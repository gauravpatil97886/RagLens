"""Costing — the ledger: one trace per user action, and what each one cost.

`api_calls` records one row per Gemini request. That is not enough to answer "what did
this chat cost?", because one question makes several requests — embed the question, then
generate — and a cached question makes none at all. A **trace** is the missing link: one
row per user ACTION (one chat turn, or one ingest run), with every api_calls row it
caused carrying its `trace_id`.

This module owns three things:

1. `Trace` — the recorder. It stamps `gemini.current_trace_id` for the duration of the
   action and writes one `traces` row at the end. Telemetry may never break a chat, so
   that write is wrapped: a failure is logged and swallowed.
2. The three read endpoints under `/api/costing`.
3. Nothing else. Money is priced by `metrics.usd()` — the one pricing function in the
   codebase — so this screen and the Signals screen cannot disagree about a rate.

Security posture, same as infra.py: **no endpoint here accepts SQL.** `window`, `kind`
and `cached` are matched against literal whitelists, `limit` and `offset` are clamped to
integers, and `trace_id` only ever travels as a query parameter.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, TypeVar

from fastapi import APIRouter, HTTPException

from . import db, gemini, metrics
from .config import settings

log = logging.getLogger(__name__)

router = APIRouter()

T = TypeVar("T")

KIND_CHAT = "chat"
KIND_INGEST = "ingest"
TRACE_KINDS = (KIND_CHAT, KIND_INGEST)

# Window literal -> hours. `all` is None, which the SQL reads as "no lower bound".
WINDOWS: dict[str, int | None] = {"1h": 1, "24h": 24, "7d": 24 * 7, "all": None}
DEFAULT_WINDOW = "24h"

MAX_LIMIT = 200
DEFAULT_LIMIT = 50

_HOURS_PER_MONTH = 24 * 30


# ---------------------------------------------------------------------------
# Recording a trace
# ---------------------------------------------------------------------------


@dataclass
class Trace:
    """One user action, being recorded.

    Created by `start()`, filled in by the pipeline as it learns things (which cache
    layer answered, how many citations, the per-stage timings), and written exactly once
    when the `with` block ends — including when it ends in an exception.

    Only the descriptive fields are set by the caller. Every number that costs money —
    api_calls, tokens, cost, model — is rolled up from this trace's `api_calls` rows at
    write time, so the ledger cannot drift from the per-request table it summarises.
    """

    trace_id: str
    kind: str
    label: str
    started: float
    scope_key: str | None = None
    cache_kind: str | None = None
    cached: bool = False
    n_citations: int = 0
    timings: dict[str, int] = field(default_factory=dict)
    ok: bool = True
    error: str | None = None
    _token: Any = field(default=None, repr=False)
    _written: bool = False

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> "Trace":
        self._token = gemini.current_trace_id.set(self.trace_id)
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc is not None and self.ok:
            self.ok = False
            # A client that closes an SSE stream mid-answer is an abandoned action, not a
            # crash, and saying so is more useful than "GeneratorExit: ".
            self.error = (
                "client disconnected before the run finished"
                if isinstance(exc, GeneratorExit)
                else f"{type(exc).__name__}: {exc}"
            )
        self._unstamp()
        self.write()
        return False  # never swallow the caller's exception

    def _unstamp(self) -> None:
        try:
            gemini.current_trace_id.reset(self._token)
        except (ValueError, TypeError):
            # The token was created in a different copy of the context — normal for a
            # streaming response, where each step runs in its own copy. Clearing the
            # value in *this* copy is the equivalent cleanup.
            gemini.current_trace_id.set(None)

    def steps(self, source: Iterator[T]) -> Iterator[T]:
        """Drive a generator, re-stamping the trace id before every step.

        Starlette pulls a sync streaming response one `next()` at a time, each in a
        threadpool worker that gets a *fresh copy* of the request's context. A ContextVar
        set once inside the generator would therefore be gone by the second step — so the
        generate call, which happens after the first yield, would land in api_calls with
        no trace_id. Setting it immediately before each `next()` puts it in the same
        context copy as the work that step does.
        """
        try:
            while True:
                gemini.current_trace_id.set(self.trace_id)
                try:
                    item = next(source)
                except StopIteration:
                    return
                yield item
        finally:
            close = getattr(source, "close", None)
            if close is not None:
                close()

    # -- the write ---------------------------------------------------------

    def write(self) -> None:
        """Roll up this trace's api_calls rows and store one `traces` row.

        Idempotent, and it never raises: a telemetry failure must never be the reason a
        user's chat fails.
        """
        if self._written:
            return
        self._written = True
        latency_ms = int((time.perf_counter() - self.started) * 1000)
        try:
            _insert(self, latency_ms)
        except Exception:
            log.exception("trace write failed for %s (ignored)", self.trace_id)


def start(kind: str, label: str) -> Trace:
    """Begin recording a user action. uuid4 because ids must be unique across processes
    and must not leak how many chats have happened."""
    return Trace(
        trace_id=str(uuid.uuid4()),
        kind=kind,
        label=label,
        started=time.perf_counter(),
    )


# The rollup. Everything billable about a trace is derived here rather than accumulated
# by hand as the pipeline runs, because api_calls is written by the one function that
# actually talks to Google — including on the retry paths a caller never sees.
_ROLLUP_SQL = """
SELECT count(*) FILTER (WHERE NOT saved)                                   AS api_calls,
       count(*) FILTER (WHERE saved)                                       AS saved_calls,
       coalesce(sum(prompt_tokens)   FILTER (WHERE NOT saved), 0)          AS prompt_tokens,
       coalesce(sum(output_tokens)   FILTER (WHERE NOT saved), 0)          AS output_tokens,
       coalesce(sum(thinking_tokens) FILTER (WHERE NOT saved), 0)          AS thinking_tokens,
       coalesce(sum(total_tokens)    FILTER (WHERE NOT saved), 0)          AS total_tokens,
       coalesce(sum(prompt_tokens)
                FILTER (WHERE NOT saved AND kind = 'generate'), 0)         AS gen_prompt,
       coalesce(sum(output_tokens + thinking_tokens)
                FILTER (WHERE NOT saved AND kind = 'generate'), 0)         AS gen_output,
       coalesce(sum(total_tokens)
                FILTER (WHERE NOT saved AND kind <> 'generate'), 0)        AS embed_tokens,
       -- "the model that actually answered, after fallbacks". Kept as two separate
       -- lookups on purpose: a chat answered from cache reached no chat model at all,
       -- and must report none. Collapsing these with a fallback would let the question's
       -- embedding model surface as the thing that wrote the answer, which is a lie.
       (SELECT model FROM api_calls
         WHERE trace_id = %(tid)s AND NOT saved AND ok AND kind = 'generate'
         ORDER BY id DESC LIMIT 1)                                         AS answer_model,
       -- An ingest has no generate call; its model is whatever did the embedding.
       (SELECT model FROM api_calls
         WHERE trace_id = %(tid)s AND NOT saved AND ok
         ORDER BY id DESC LIMIT 1)                                         AS any_model
  FROM api_calls
 WHERE trace_id = %(tid)s
"""

_INSERT_SQL = """
INSERT INTO traces (trace_id, kind, label, scope_key, cache_kind, cached, n_citations,
                    model, api_calls, saved_calls, prompt_tokens, output_tokens,
                    thinking_tokens, total_tokens, cost_usd, latency_ms, timings, ok, error)
VALUES (%(tid)s, %(kind)s, %(label)s, %(scope)s, %(cache_kind)s, %(cached)s, %(citations)s,
        %(model)s, %(api_calls)s, %(saved_calls)s, %(prompt)s, %(output)s,
        %(thinking)s, %(total)s, %(cost)s, %(latency)s, %(timings)s, %(ok)s, %(error)s)
ON CONFLICT (trace_id) DO UPDATE SET
    cache_kind = EXCLUDED.cache_kind, cached = EXCLUDED.cached,
    n_citations = EXCLUDED.n_citations, model = EXCLUDED.model,
    api_calls = EXCLUDED.api_calls, saved_calls = EXCLUDED.saved_calls,
    prompt_tokens = EXCLUDED.prompt_tokens, output_tokens = EXCLUDED.output_tokens,
    thinking_tokens = EXCLUDED.thinking_tokens, total_tokens = EXCLUDED.total_tokens,
    cost_usd = EXCLUDED.cost_usd, latency_ms = EXCLUDED.latency_ms,
    timings = EXCLUDED.timings, ok = EXCLUDED.ok, error = EXCLUDED.error
"""


def _insert(rec: Trace, latency_ms: int) -> None:
    with db.connection() as conn:
        roll = conn.execute(_ROLLUP_SQL, {"tid": rec.trace_id}).fetchone() or {}

        # Every trace is priced from what it actually spent — including a cached one.
        #
        # It is tempting to record a cache hit as a flat zero, and an *exact* hit really
        # is free: it is a string lookup, no vector, no request. A *semantic* hit is not.
        # Finding the match means embedding the question, which is one real API call of
        # about $0.0000025. Writing that down as $0.00 would make the trace rows stop
        # summing to the totals, and a cost screen whose rows disagree with its own total
        # is worse than no cost screen. The saving is still the headline — it is just an
        # honest one: ~$0.0000025 instead of ~$0.007, so roughly 2,700x cheaper rather
        # than infinitely cheaper. `saved_calls` and `cached` carry that story.
        money = {
            "model": roll.get("answer_model") if rec.kind == "chat" else roll.get("any_model"),
            "api_calls": int(roll.get("api_calls") or 0),
            "prompt": int(roll.get("prompt_tokens") or 0),
            "output": int(roll.get("output_tokens") or 0),
            "thinking": int(roll.get("thinking_tokens") or 0),
            "total": int(roll.get("total_tokens") or 0),
            "cost": round(
                metrics.usd(
                    float(roll.get("gen_prompt") or 0),
                    float(roll.get("gen_output") or 0),
                    float(roll.get("embed_tokens") or 0),
                ),
                8,
            ),
        }

        conn.execute(
            _INSERT_SQL,
            {
                "tid": rec.trace_id,
                "kind": rec.kind,
                "label": (rec.label or "")[:2000],
                "scope": rec.scope_key,
                "cache_kind": rec.cache_kind,
                "cached": rec.cached,
                "citations": rec.n_citations,
                "saved_calls": int(roll.get("saved_calls") or 0),
                "latency": latency_ms,
                "timings": json.dumps({**rec.timings, "total": rec.timings.get("total", latency_ms)}),
                "ok": rec.ok,
                "error": (rec.error or "")[:2000] or None,
                **money,
            },
        )


# ---------------------------------------------------------------------------
# Validation. Nothing below reaches SQL as anything but a bound parameter, but the
# whitelists still run first: a 400 on `window=evil` is a better answer than a query.
# ---------------------------------------------------------------------------


def _check_window(value: str | None) -> str:
    window = (value or DEFAULT_WINDOW).strip()
    if window not in WINDOWS:
        raise HTTPException(400, f"window must be one of {', '.join(WINDOWS)}.")
    return window


def _check_kind(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    kind = value.strip()
    if kind not in TRACE_KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(TRACE_KINDS)}.")
    return kind


def _check_cached(value: str | None) -> bool | None:
    if value is None or value == "":
        return None
    flag = value.strip().lower()
    if flag not in ("true", "false"):
        raise HTTPException(400, "cached must be true or false.")
    return flag == "true"


def _clamp(value: int, low: int, high: int) -> int:
    """Paging is clamped rather than rejected: a UI asking for too much should get the
    most it may have, not an error it has to handle."""
    return max(low, min(high, value))


# ---------------------------------------------------------------------------
# Shared serialisation
# ---------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _inr(usd: float) -> float:
    return round(usd * settings.usd_inr_rate, 4)


def _trace_row(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "trace_id": r["trace_id"],
        "kind": r["kind"],
        "label": r["label"],
        "scope_key": r["scope_key"],
        "cache_kind": r["cache_kind"],
        "cached": r["cached"],
        "model": r["model"],
        "api_calls": int(r["api_calls"]),
        "saved_calls": int(r["saved_calls"]),
        "prompt_tokens": int(r["prompt_tokens"]),
        "output_tokens": int(r["output_tokens"]),
        "thinking_tokens": int(r["thinking_tokens"]),
        "total_tokens": int(r["total_tokens"]),
        "cost_usd": float(r["cost_usd"]),
        "cost_inr": _inr(float(r["cost_usd"])),
        "latency_ms": int(r["latency_ms"]),
        "n_citations": int(r["n_citations"]),
        "ok": r["ok"],
        "error": r["error"],
        "created_at": _iso(r["created_at"]),
    }


def _span_cost(r: dict[str, Any]) -> float:
    """One api_calls row, priced. A `saved` row is a call that never happened: it has no
    tokens and costs nothing, which is exactly what makes it worth counting."""
    if r["saved"]:
        return 0.0
    if r["kind"] == gemini.KIND_GENERATE:
        return metrics.usd(r["prompt_tokens"], r["output_tokens"] + r["thinking_tokens"], 0)
    return metrics.usd(0, 0, r["total_tokens"])


# ---------------------------------------------------------------------------
# GET /api/costing/summary
# ---------------------------------------------------------------------------

# One window predicate, written once — `api_calls` and `traces` both date from
# created_at. make_interval(hours => NULL) is NULL, so the IS NULL branch is what makes
# `all` mean "no lower bound" rather than "no rows".
_CALLS_WINDOW = (
    "(%(hours)s::int IS NULL OR created_at > now() - make_interval(hours => %(hours)s))"
)

_SPEND_SQL = f"""
SELECT count(*) FILTER (WHERE NOT saved)                                   AS api_calls,
       count(*) FILTER (WHERE saved)                                       AS saved_calls,
       coalesce(sum(prompt_tokens)   FILTER (WHERE NOT saved), 0)          AS prompt_tokens,
       coalesce(sum(output_tokens)   FILTER (WHERE NOT saved), 0)          AS output_tokens,
       coalesce(sum(thinking_tokens) FILTER (WHERE NOT saved), 0)          AS thinking_tokens,
       coalesce(sum(total_tokens)    FILTER (WHERE NOT saved), 0)          AS total_tokens,
       coalesce(sum(prompt_tokens)
                FILTER (WHERE NOT saved AND kind = 'generate'), 0)         AS gen_prompt,
       coalesce(sum(output_tokens + thinking_tokens)
                FILTER (WHERE NOT saved AND kind = 'generate'), 0)         AS gen_output,
       coalesce(sum(total_tokens)
                FILTER (WHERE NOT saved AND kind <> 'generate'), 0)        AS embed_tokens,
       min(created_at)                                                     AS first_at
  FROM api_calls
 WHERE {_CALLS_WINDOW}
"""

# What the caches avoided, in tokens. A saved row records that a call did not happen, so
# it cannot record tokens — the figure is the mean of the calls that DID happen,
# multiplied out. Same extrapolation /api/metrics uses, so the two agree.
_SAVINGS_SQL = f"""
SELECT count(*) FILTER (WHERE kind = 'generate' AND saved)                 AS gen_saved,
       coalesce(avg(prompt_tokens)
                FILTER (WHERE kind = 'generate' AND NOT saved AND ok), 0)  AS gen_prompt_mean,
       coalesce(avg(output_tokens + thinking_tokens)
                FILTER (WHERE kind = 'generate' AND NOT saved AND ok), 0)  AS gen_output_mean,
       coalesce(sum(total_tokens)
                FILTER (WHERE kind = 'embed_query' AND NOT saved AND ok), 0)::numeric
         / nullif(sum(n_items)
                  FILTER (WHERE kind = 'embed_query' AND NOT saved AND ok), 0)
                                                                           AS eq_per_item,
       coalesce(sum(n_items) FILTER (WHERE kind = 'embed_query' AND saved), 0)
                                                                           AS eq_items_saved,
       coalesce(sum(total_tokens)
                FILTER (WHERE kind = 'embed_document' AND NOT saved AND ok), 0)::numeric
         / nullif(sum(n_items)
                  FILTER (WHERE kind = 'embed_document' AND NOT saved AND ok), 0)
                                                                           AS ed_per_item,
       coalesce(sum(n_items) FILTER (WHERE kind = 'embed_document' AND saved), 0)
                                                                           AS ed_items_saved
  FROM api_calls
 WHERE {_CALLS_WINDOW}
"""

_BY_MODEL_SQL = f"""
SELECT model,
       count(*)                                                            AS calls,
       coalesce(sum(total_tokens), 0)                                      AS total_tokens,
       coalesce(sum(prompt_tokens) FILTER (WHERE kind = 'generate'), 0)    AS gen_prompt,
       coalesce(sum(output_tokens + thinking_tokens)
                FILTER (WHERE kind = 'generate'), 0)                       AS gen_output,
       coalesce(sum(total_tokens) FILTER (WHERE kind <> 'generate'), 0)    AS embed_tokens,
       coalesce(round(avg(latency_ms)), 0)::int                            AS avg_latency_ms,
       count(*) FILTER (WHERE NOT ok)                                      AS failures
  FROM api_calls
 WHERE NOT saved AND {_CALLS_WINDOW}
 GROUP BY model
 ORDER BY calls DESC, model
"""

_BY_KIND_SQL = f"""
SELECT kind,
       count(*) FILTER (WHERE NOT saved)                                   AS calls,
       count(*) FILTER (WHERE saved)                                       AS saved,
       coalesce(sum(prompt_tokens)
                FILTER (WHERE NOT saved AND kind = 'generate'), 0)         AS gen_prompt,
       coalesce(sum(output_tokens + thinking_tokens)
                FILTER (WHERE NOT saved AND kind = 'generate'), 0)         AS gen_output,
       coalesce(sum(total_tokens)
                FILTER (WHERE NOT saved AND kind <> 'generate'), 0)        AS embed_tokens
  FROM api_calls
 WHERE {_CALLS_WINDOW}
 GROUP BY kind
"""

_PER_CHAT_SQL = f"""
SELECT count(*)                                                            AS traces,
       count(*) FILTER (WHERE kind = 'chat')                               AS chats,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY cost_usd)
         FILTER (WHERE kind = 'chat')                                      AS median_cost_usd,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY total_tokens)
         FILTER (WHERE kind = 'chat')                                      AS median_tokens,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)
         FILTER (WHERE kind = 'chat')                                      AS median_latency_ms,
       min(created_at)                                                     AS first_at
  FROM traces
 WHERE {_CALLS_WINDOW}
"""


def summary(window: str) -> dict[str, Any]:
    """Spend, savings and a projection over a window.

    Money and tokens come from `api_calls` rather than from the `traces` rollup, so this
    endpoint stays reconcilable with /api/metrics call-for-call — including the requests
    made before tracing existed, and the ones a cached action still had to make.
    """
    hours = WINDOWS[window]
    params = {"hours": hours}
    with db.connection() as conn:
        spend = conn.execute(_SPEND_SQL, params).fetchone()
        saving = conn.execute(_SAVINGS_SQL, params).fetchone()
        by_model = conn.execute(_BY_MODEL_SQL, params).fetchall()
        by_kind = {r["kind"]: r for r in conn.execute(_BY_KIND_SQL, params).fetchall()}
        chats = conn.execute(_PER_CHAT_SQL, params).fetchone()

    cost_usd = metrics.usd(spend["gen_prompt"], spend["gen_output"], spend["embed_tokens"])

    gen_saved = int(saving["gen_saved"] or 0)
    saved_embed_tokens = float(saving["eq_per_item"] or 0) * int(saving["eq_items_saved"] or 0) + (
        float(saving["ed_per_item"] or 0) * int(saving["ed_items_saved"] or 0)
    )
    saved_usd = metrics.usd(
        float(saving["gen_prompt_mean"] or 0) * gen_saved,
        float(saving["gen_output_mean"] or 0) * gen_saved,
        saved_embed_tokens,
    )

    return {
        "window": window,
        "pricing": {
            "chat_input_per_1m_usd": settings.price_chat_input_per_1m_usd,
            "chat_output_per_1m_usd": settings.price_chat_output_per_1m_usd,
            "embed_input_per_1m_usd": settings.price_embed_input_per_1m_usd,
            "usd_inr_rate": settings.usd_inr_rate,
            "tier": settings.gemini_tier,
            "source": settings.pricing_source,
            "as_of": settings.pricing_as_of,
        },
        "totals": {
            "traces": int(chats["traces"] or 0),
            "api_calls": int(spend["api_calls"]),
            "saved_calls": int(spend["saved_calls"]),
            "prompt_tokens": int(spend["prompt_tokens"]),
            "output_tokens": int(spend["output_tokens"]),
            "thinking_tokens": int(spend["thinking_tokens"]),
            "total_tokens": int(spend["total_tokens"]),
            "cost_usd": round(cost_usd, 8),
            "cost_inr": _inr(cost_usd),
            # Estimated, like everything priced from calls that never happened.
            "saved_usd": round(saved_usd, 8),
            "saved_inr": _inr(saved_usd),
            "saved_estimated": True,
            "would_have_cost_usd": round(cost_usd + saved_usd, 8),
        },
        "by_model": [
            {
                "model": r["model"],
                "calls": int(r["calls"]),
                "total_tokens": int(r["total_tokens"]),
                "cost_usd": round(
                    metrics.usd(r["gen_prompt"], r["gen_output"], r["embed_tokens"]), 8
                ),
                "avg_latency_ms": int(r["avg_latency_ms"]),
                "failures": int(r["failures"]),
            }
            for r in by_model
        ],
        # metrics.KINDS order, always all three, so the UI's rows never jump about.
        "by_kind": [
            {
                "kind": kind,
                "calls": int((by_kind.get(kind) or {}).get("calls", 0) or 0),
                "saved": int((by_kind.get(kind) or {}).get("saved", 0) or 0),
                "cost_usd": round(
                    metrics.usd(
                        float((by_kind.get(kind) or {}).get("gen_prompt", 0) or 0),
                        float((by_kind.get(kind) or {}).get("gen_output", 0) or 0),
                        float((by_kind.get(kind) or {}).get("embed_tokens", 0) or 0),
                    ),
                    8,
                ),
            }
            for kind in metrics.KINDS
        ],
        "per_chat": {
            "chats": int(chats["chats"] or 0),
            "median_cost_usd": round(float(chats["median_cost_usd"] or 0), 8),
            "median_tokens": int(float(chats["median_tokens"] or 0)),
            "median_latency_ms": int(float(chats["median_latency_ms"] or 0)),
        },
        "projection": _projection(window, chats, spend, cost_usd, saved_usd),
    }


def _elapsed_hours(window: str, *first_at: datetime | None) -> float:
    """How long the window actually covers.

    For a fixed window, the window. For `all` it is the age of the oldest row the window
    swept up — the earliest trace OR the earliest api_call, whichever came first, because
    dividing a week of API spend by an hour of traces would project a monthly bill that
    is off by two orders of magnitude. Floored at one hour: a demo five minutes old
    should not claim to know what a month of it costs.
    """
    hours = WINDOWS[window]
    if hours is not None:
        return float(hours)
    oldest = min((t for t in first_at if t is not None), default=None)
    if oldest is None:
        return 1.0
    return max((datetime.now(timezone.utc) - oldest).total_seconds() / 3600, 1.0)


def _projection(
    window: str,
    chats: dict[str, Any],
    spend: dict[str, Any],
    cost_usd: float,
    saved_usd: float,
) -> dict[str, Any]:
    hours = _elapsed_hours(window, chats["first_at"], spend["first_at"])
    per_hour = int(chats["traces"] or 0) / hours
    monthly = cost_usd / hours * _HOURS_PER_MONTH
    monthly_without_cache = (cost_usd + saved_usd) / hours * _HOURS_PER_MONTH
    free = (settings.gemini_tier or "").lower() == "free"
    return {
        "basis": window,
        "traces_per_day": round(per_hour * 24, 2),
        "monthly_cost_usd": round(monthly, 6),
        "monthly_cost_inr": round(monthly * settings.usd_inr_rate, 2),
        "monthly_without_cache_usd": round(monthly_without_cache, 6),
        # The server owns this sentence. A UI that invented it could get it wrong, and
        # "your demo costs $5.23 a month" is exactly the wrong thing to get wrong.
        "note": (
            "You are on the free tier, so the real bill is zero. These are what the same "
            "traffic would cost at the listed paid rates."
            if free
            else f"You are on the {settings.gemini_tier} tier. These are the listed "
            "paid rates applied to the traffic above."
        ),
    }


@router.get("/api/costing/summary")
def api_costing_summary(window: str = DEFAULT_WINDOW):
    return summary(_check_window(window))


# ---------------------------------------------------------------------------
# GET /api/costing/traces
# ---------------------------------------------------------------------------

# Both filters are optional and both are literal-checked before they get here; the
# `IS NULL OR` form keeps it to one statement instead of four assembled ones.
_TRACE_FILTER = """
    (%(kind)s::text IS NULL OR kind = %(kind)s)
AND (%(cached)s::boolean IS NULL OR cached = %(cached)s)
"""

_TRACES_SQL = f"""
SELECT trace_id, kind, label, scope_key, cache_kind, cached, model, api_calls,
       saved_calls, prompt_tokens, output_tokens, thinking_tokens, total_tokens,
       cost_usd, latency_ms, n_citations, ok, error, created_at
  FROM traces
 WHERE {_TRACE_FILTER}
 ORDER BY created_at DESC, trace_id
 LIMIT %(limit)s OFFSET %(offset)s
"""

_TRACES_COUNT_SQL = f"SELECT count(*) AS n FROM traces WHERE {_TRACE_FILTER}"


def traces(limit: int, offset: int, kind: str | None, cached: bool | None) -> dict[str, Any]:
    params = {"kind": kind, "cached": cached, "limit": limit, "offset": offset}
    with db.connection() as conn:
        total = conn.execute(_TRACES_COUNT_SQL, params).fetchone()["n"]
        rows = conn.execute(_TRACES_SQL, params).fetchall()
    return {
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "kind": kind,
        "cached": cached,
        "traces": [_trace_row(r) for r in rows],
    }


@router.get("/api/costing/traces")
def api_costing_traces(
    limit: int = DEFAULT_LIMIT,
    offset: int = 0,
    kind: str | None = None,
    cached: str | None = None,
):
    return traces(
        _clamp(limit, 1, MAX_LIMIT),
        _clamp(offset, 0, 10_000_000),
        _check_kind(kind),
        _check_cached(cached),
    )


# ---------------------------------------------------------------------------
# GET /api/costing/trace/{trace_id}
# ---------------------------------------------------------------------------

_ONE_TRACE_SQL = """
SELECT trace_id, kind, label, scope_key, cache_kind, cached, model, api_calls,
       saved_calls, prompt_tokens, output_tokens, thinking_tokens, total_tokens,
       cost_usd, latency_ms, n_citations, timings, ok, error, created_at
  FROM traces
 WHERE trace_id = %(tid)s
"""

# Oldest first: spans are read as a sequence of events, not as a log tail.
_SPANS_SQL = """
SELECT id, kind, model, prompt_tokens, output_tokens, thinking_tokens, total_tokens,
       tokens_estimated, latency_ms, n_items, ok, error, saved, created_at
  FROM api_calls
 WHERE trace_id = %(tid)s
 ORDER BY id
"""

# (timings key, label, billable). Billable means "this step is where money goes" —
# the UI colours those bars differently, because a slow retrieve is free and a slow
# generate is not.
_CHAT_STEPS = (
    ("embed", "embed", True),
    ("cache_lookup", "cache lookup", False),
    ("retrieve", "retrieve", False),
    ("generate", "generate", True),
)
_INGEST_STEPS = (
    ("extract", "extract", False),
    ("chunk", "chunk", False),
    ("embed", "embed", True),
    ("index", "index", False),
)


def _skip_reason(step: str, trace: dict[str, Any]) -> str | None:
    """Why a step did not run, or None if it ran.

    Decided from what the trace *means*, never from a zero duration: retrieval over a
    small corpus genuinely takes under a millisecond, and calling that "skipped" would be
    a lie drawn as an outline.
    """
    if trace["kind"] != KIND_CHAT:
        return None
    cache_kind = trace["cache_kind"]
    cached = bool(trace["cached"])
    if step == "embed" and cache_kind == "exact":
        return "exact cache hit — matching the question text needs no embedding"
    if step == "retrieve" and cached:
        return f"{cache_kind} cache hit — the stored citations were replayed"
    if step == "generate":
        if cached:
            return f"{cache_kind} cache hit"
        if int(trace["n_citations"]) == 0:
            return "no chunk cleared the similarity threshold, so the model was not asked"
    return None


def _waterfall(trace: dict[str, Any], timings: dict[str, Any]) -> list[dict[str, Any]]:
    """One bar per pipeline step, laid out end to end.

    Derived here rather than in the UI so that every client draws the same chart from the
    same arithmetic — and so that "this step did not run" is a fact the server states
    rather than a zero the client has to interpret.
    """
    steps = _CHAT_STEPS if trace["kind"] == KIND_CHAT else _INGEST_STEPS
    bars: list[dict[str, Any]] = []
    at = 0
    for key, label, billable in steps:
        duration = int(timings.get(key) or 0)
        bar: dict[str, Any] = {
            "label": label,
            "start_ms": at,
            "duration_ms": duration,
            "billable": billable,
        }
        reason = _skip_reason(key, trace)
        if reason is not None:
            bar["skipped"] = True
            bar["skipped_reason"] = reason
        bars.append(bar)
        at += duration
    return bars


def trace_detail(trace_id: str) -> dict[str, Any]:
    with db.connection() as conn:
        row = conn.execute(_ONE_TRACE_SQL, {"tid": trace_id}).fetchone()
        if row is None:
            raise HTTPException(404, "Unknown trace.")
        spans = conn.execute(_SPANS_SQL, {"tid": trace_id}).fetchall()

    timings = row["timings"] or {}
    return {
        "trace": _trace_row(row),
        "timings": {k: int(v) for k, v in timings.items()},
        "spans": [
            {
                "id": s["id"],
                "kind": s["kind"],
                "model": s["model"],
                "prompt_tokens": s["prompt_tokens"],
                "output_tokens": s["output_tokens"],
                "thinking_tokens": s["thinking_tokens"],
                "total_tokens": s["total_tokens"],
                "tokens_estimated": s["tokens_estimated"],
                "latency_ms": s["latency_ms"],
                "n_items": s["n_items"],
                "ok": s["ok"],
                "error": s["error"],
                "saved": s["saved"],
                "cost_usd": round(_span_cost(s), 10),
                "created_at": _iso(s["created_at"]),
            }
            for s in spans
        ],
        "waterfall": _waterfall(row, timings),
    }


@router.get("/api/costing/trace/{trace_id}")
def api_costing_trace(trace_id: str):
    return trace_detail(trace_id)
