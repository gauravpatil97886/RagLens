"""The two "explain yourself" endpoints: what the demo spent, and how it is wired.

Nothing in here is a constant the UI could have hardcoded. Every number is either read
back out of `api_calls` / the corpus tables, or read off the live `settings` object.
Where a figure cannot be measured — embedding token counts, the cost of a call the cache
prevented — it is computed here and shipped with an `estimated: true` flag next to it,
never quietly mixed in with the measured ones.
"""

from __future__ import annotations

import re
from typing import Any

from . import db, gemini
from .config import settings

# The three kinds api_calls can hold, in the order the UI should show them.
KINDS = (gemini.KIND_GENERATE, gemini.KIND_EMBED_QUERY, gemini.KIND_EMBED_DOCUMENT)
_EMBED_KINDS = (gemini.KIND_EMBED_QUERY, gemini.KIND_EMBED_DOCUMENT)

RECENT_LIMIT = 50
TIMESERIES_MINUTES = 60


# ---------------------------------------------------------------------------
# GET /api/metrics
# ---------------------------------------------------------------------------


def snapshot() -> dict[str, Any]:
    with db.connection() as conn:
        by_kind = {r["kind"]: r for r in conn.execute(_TOTALS_SQL).fetchall()}
        latency = conn.execute(_LATENCY_SQL).fetchall()
        means = conn.execute(_GENERATE_MEANS_SQL).fetchone()
        embed_means = {r["kind"]: r for r in conn.execute(_EMBED_MEANS_SQL).fetchall()}
        cache_row = conn.execute(
            "SELECT exact_hits, semantic_hits, misses FROM cache_stats WHERE id = true"
        ).fetchone() or {"exact_hits": 0, "semantic_hits": 0, "misses": 0}
        recent = conn.execute(_RECENT_SQL, {"limit": RECENT_LIMIT}).fetchall()
        series = conn.execute(_TIMESERIES_SQL, {"minutes": TIMESERIES_MINUTES - 1}).fetchall()

    totals = _totals(by_kind)
    saved = _savings(by_kind, means, embed_means)
    return {
        "totals": totals,
        "latency_ms": _latency(latency),
        "cache": _cache(cache_row, by_kind, saved),
        "cost": _cost(totals, saved),
        "recent": [_recent_row(r) for r in recent],
        "timeseries": {
            "bucket": "minute",
            "minutes": TIMESERIES_MINUTES,
            "points": [
                {
                    "t": r["t"].isoformat().replace("+00:00", "Z"),
                    "calls": int(r["calls"]),
                    "saved": int(r["saved"]),
                    "tokens": int(r["tokens"]),
                    "thinking_tokens": int(r["thinking_tokens"]),
                }
                for r in series
            ],
        },
    }


_TOTALS_SQL = """
SELECT kind,
       count(*) FILTER (WHERE NOT saved)                            AS calls,
       count(*) FILTER (WHERE NOT saved AND NOT ok)                 AS failed,
       count(*) FILTER (WHERE saved)                                AS calls_saved,
       coalesce(sum(n_items)         FILTER (WHERE NOT saved), 0)   AS items,
       coalesce(sum(n_items)         FILTER (WHERE saved), 0)       AS items_saved,
       coalesce(sum(prompt_tokens)   FILTER (WHERE NOT saved), 0)   AS prompt_tokens,
       coalesce(sum(output_tokens)   FILTER (WHERE NOT saved), 0)   AS output_tokens,
       coalesce(sum(thinking_tokens) FILTER (WHERE NOT saved), 0)   AS thinking_tokens,
       coalesce(sum(total_tokens)    FILTER (WHERE NOT saved), 0)   AS total_tokens,
       coalesce(sum(total_tokens) FILTER (WHERE NOT saved AND tokens_estimated), 0)
                                                                    AS estimated_tokens
  FROM api_calls
 GROUP BY kind
"""

# ROLLUP gives us the per-kind rows and the overall row from one scan; GROUPING(kind)=1
# marks the overall row, which is safer than testing for a NULL kind.
_LATENCY_SQL = """
SELECT CASE WHEN grouping(kind) = 1 THEN NULL ELSE kind END      AS kind,
       count(*)                                                  AS n,
       round(avg(latency_ms))::int                               AS avg,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::int AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95,
       max(latency_ms)                                           AS max
  FROM api_calls
 WHERE NOT saved
 GROUP BY ROLLUP (kind)
"""

# Only successful calls: a failed one contributes latency but no tokens, and averaging
# its zeros in would understate what a real generation costs.
_GENERATE_MEANS_SQL = """
SELECT count(*)                        AS n,
       coalesce(avg(prompt_tokens), 0)   AS prompt_tokens,
       coalesce(avg(output_tokens), 0)   AS output_tokens,
       coalesce(avg(thinking_tokens), 0) AS thinking_tokens,
       coalesce(avg(total_tokens), 0)    AS total_tokens
  FROM api_calls
 WHERE kind = 'generate' AND NOT saved AND ok
"""

# Per *item*, not per call: an avoided embed batch of 3 chunks costs 3 chunks' worth.
_EMBED_MEANS_SQL = """
SELECT kind,
       coalesce(sum(total_tokens)::numeric / nullif(sum(n_items), 0), 0) AS tokens_per_item
  FROM api_calls
 WHERE kind IN ('embed_query', 'embed_document') AND NOT saved AND ok
 GROUP BY kind
"""

_RECENT_SQL = """
SELECT id, created_at, kind, model, prompt_tokens, output_tokens, thinking_tokens,
       total_tokens, tokens_estimated, latency_ms, n_items, ok, error, saved
  FROM api_calls
 ORDER BY id DESC
 LIMIT %(limit)s
"""

# generate_series so quiet minutes are present as zeros — a sparkline with holes in it
# lies about the shape of the traffic.
_TIMESERIES_SQL = """
WITH buckets AS (
    SELECT generate_series(
               date_trunc('minute', now()) - make_interval(mins => %(minutes)s),
               date_trunc('minute', now()),
               interval '1 minute') AS t
)
SELECT b.t,
       count(a.id) FILTER (WHERE NOT a.saved)                          AS calls,
       count(a.id) FILTER (WHERE a.saved)                              AS saved,
       coalesce(sum(a.total_tokens)    FILTER (WHERE NOT a.saved), 0)  AS tokens,
       coalesce(sum(a.thinking_tokens) FILTER (WHERE NOT a.saved), 0)  AS thinking_tokens
  FROM buckets b
  LEFT JOIN api_calls a ON date_trunc('minute', a.created_at) = b.t
 GROUP BY b.t
 ORDER BY b.t
"""


def _totals(by_kind: dict[str, dict]) -> dict[str, Any]:
    def col(name: str, kinds=KINDS) -> int:
        return sum(int(by_kind.get(k, {}).get(name, 0) or 0) for k in kinds)

    tokens_total = col("total_tokens")
    return {
        "api_calls": col("calls"),
        "failed_calls": col("failed"),
        "calls_saved": col("calls_saved"),
        "by_kind": {
            k: {
                "calls": int(by_kind.get(k, {}).get("calls", 0) or 0),
                "failed": int(by_kind.get(k, {}).get("failed", 0) or 0),
                "calls_saved": int(by_kind.get(k, {}).get("calls_saved", 0) or 0),
                "items": int(by_kind.get(k, {}).get("items", 0) or 0),
                "items_saved": int(by_kind.get(k, {}).get("items_saved", 0) or 0),
                "tokens": {
                    "prompt": int(by_kind.get(k, {}).get("prompt_tokens", 0) or 0),
                    "output": int(by_kind.get(k, {}).get("output_tokens", 0) or 0),
                    "thinking": int(by_kind.get(k, {}).get("thinking_tokens", 0) or 0),
                    "total": int(by_kind.get(k, {}).get("total_tokens", 0) or 0),
                },
                # Embedding kinds are always true: those responses carry no usage_metadata.
                "tokens_estimated": k in _EMBED_KINDS,
            }
            for k in KINDS
        },
        "tokens": {
            "prompt": col("prompt_tokens"),
            "output": col("output_tokens"),
            "thinking": col("thinking_tokens"),
            "total": tokens_total,
            # How much of the headline token number is estimated rather than measured.
            "estimated": col("estimated_tokens"),
            "measured": tokens_total - col("estimated_tokens"),
        },
    }


def _latency(rows: list[dict]) -> dict[str, Any]:
    def shape(r: dict) -> dict[str, int]:
        return {
            "n": int(r["n"]),
            "avg": int(r["avg"] or 0),
            "p50": int(r["p50"] or 0),
            "p95": int(r["p95"] or 0),
            "max": int(r["max"] or 0),
        }

    empty = {"n": 0, "avg": 0, "p50": 0, "p95": 0, "max": 0}
    overall = empty
    per_kind: dict[str, dict[str, int]] = {k: dict(empty) for k in KINDS}
    for row in rows:
        if row["kind"] is None:
            overall = shape(row)
        elif row["kind"] in per_kind:
            per_kind[row["kind"]] = shape(row)
    return {"overall": overall, "by_kind": per_kind}


def _savings(by_kind: dict, means: dict, embed_means: dict) -> dict[str, Any]:
    """What the caches avoided, in tokens.

    The saved rows record that a call did not happen; they cannot record tokens, because
    no response ever came back. So the token figure is the mean of the calls that DID
    happen, multiplied out — an extrapolation, flagged as one.
    """
    generate_saved = int(by_kind.get(gemini.KIND_GENERATE, {}).get("calls_saved", 0) or 0)
    prompt = float(means["prompt_tokens"]) * generate_saved
    output = float(means["output_tokens"]) * generate_saved
    thinking = float(means["thinking_tokens"]) * generate_saved

    embed_tokens = 0.0
    embed_calls_saved = 0
    for kind in _EMBED_KINDS:
        items = int(by_kind.get(kind, {}).get("items_saved", 0) or 0)
        embed_calls_saved += int(by_kind.get(kind, {}).get("calls_saved", 0) or 0)
        per_item = float((embed_means.get(kind) or {}).get("tokens_per_item", 0) or 0)
        embed_tokens += items * per_item

    return {
        "generate_calls": generate_saved,
        "embed_calls": embed_calls_saved,
        "generate_prompt_tokens": prompt,
        "generate_output_tokens": output,
        "generate_thinking_tokens": thinking,
        "embed_tokens": embed_tokens,
        "sample_size": int(means["n"]),
    }


def _cache(stats: dict, by_kind: dict, saved: dict) -> dict[str, Any]:
    exact = int(stats["exact_hits"])
    semantic = int(stats["semantic_hits"])
    misses = int(stats["misses"])
    hits = exact + semantic
    looked_up = hits + misses
    saved_by_kind = {
        k: int(by_kind.get(k, {}).get("calls_saved", 0) or 0) for k in KINDS
    }
    return {
        "threshold": settings.semantic_cache_threshold,
        "enabled": settings.semantic_cache_enabled,
        "ttl_hours": settings.cache_ttl_hours,
        "lookups": looked_up,
        "hits": hits,
        "misses": misses,
        "exact_hits": exact,
        "semantic_hits": semantic,
        "hit_rate": round(hits / looked_up, 4) if looked_up else 0.0,
        "saved_api_calls": {**saved_by_kind, "total": sum(saved_by_kind.values())},
        "estimated_tokens_saved": {
            "estimated": True,
            "basis": (
                f"mean tokens per successful generate call (n={saved['sample_size']}) x "
                f"{saved['generate_calls']} generate calls avoided, plus mean tokens per "
                "embedded item x items served from embedding_cache"
            ),
            "prompt": round(saved["generate_prompt_tokens"] + saved["embed_tokens"]),
            "output": round(saved["generate_output_tokens"]),
            "thinking": round(saved["generate_thinking_tokens"]),
            "total": round(
                saved["generate_prompt_tokens"]
                + saved["generate_output_tokens"]
                + saved["generate_thinking_tokens"]
                + saved["embed_tokens"]
            ),
        },
    }


def _rates() -> dict[str, Any]:
    return {
        "unit": "USD per 1,000,000 tokens",
        "chat_model": settings.gemini_chat_model,
        "chat_input": settings.price_chat_input_per_1m_usd,
        "chat_output": settings.price_chat_output_per_1m_usd,
        "embed_model": settings.gemini_embed_model,
        "embed_input": settings.price_embed_input_per_1m_usd,
        # Not a separate line on the bill: Google charges thought tokens at the output rate.
        "thinking_billed_as": "output",
        "usd_inr": settings.usd_inr_rate,
        "source": settings.pricing_source,
        "as_of": settings.pricing_as_of,
    }


def usd(prompt: float, output: float, embed: float) -> float:
    """Price a bundle of tokens at the configured paid-tier rates.

    THE pricing function. /api/metrics, /api/costing/* and the trace writer all call this
    one — a screen that did its own arithmetic would be free to disagree with the screen
    next to it the moment a rate in .env changed.

    `output` must already include thinking tokens: Google bills thoughts at the output
    rate, so there is deliberately no third argument for them.
    """
    return (
        prompt / 1_000_000 * settings.price_chat_input_per_1m_usd
        + output / 1_000_000 * settings.price_chat_output_per_1m_usd
        + embed / 1_000_000 * settings.price_embed_input_per_1m_usd
    )


def _money(usd: float) -> dict[str, float]:
    # 6dp: at Flash rates a whole demo session lands in the third or fourth decimal, and
    # rounding to cents would render every honest number as 0.00.
    return {"usd": round(usd, 6), "inr": round(usd * settings.usd_inr_rate, 4)}


def _cost(totals: dict, saved: dict) -> dict[str, Any]:
    gen = totals["by_kind"][gemini.KIND_GENERATE]["tokens"]
    embed_tokens = sum(totals["by_kind"][k]["tokens"]["total"] for k in _EMBED_KINDS)

    spent = usd(gen["prompt"], gen["output"] + gen["thinking"], embed_tokens)
    would_save = usd(
        saved["generate_prompt_tokens"],
        saved["generate_output_tokens"] + saved["generate_thinking_tokens"],
        saved["embed_tokens"],
    )
    return {
        "tier": settings.gemini_tier,
        "actual_cost_usd": 0.0,
        "actual_cost_inr": 0.0,
        "note": (
            "This demo runs on the Gemini free tier, so the real bill is zero. The figures "
            "below are what the same traffic would have cost at the published paid-tier "
            "list prices in `rates`, which are settings you can override."
        ),
        "rates": _rates(),
        "would_have_cost": _money(spent),
        "breakdown": {
            "generate_input": _money(
                gen["prompt"] / 1_000_000 * settings.price_chat_input_per_1m_usd
            ),
            "generate_output": _money(
                gen["output"] / 1_000_000 * settings.price_chat_output_per_1m_usd
            ),
            "generate_thinking": _money(
                gen["thinking"] / 1_000_000 * settings.price_chat_output_per_1m_usd
            ),
            "embed_input": _money(
                embed_tokens / 1_000_000 * settings.price_embed_input_per_1m_usd
            ),
        },
        # Estimated because it prices calls that never happened — see cache.estimated_tokens_saved.
        "saved_by_cache": {**_money(would_save), "estimated": True},
    }


def _recent_row(r: dict) -> dict[str, Any]:
    return {
        "id": r["id"],
        "created_at": r["created_at"].isoformat().replace("+00:00", "Z"),
        "kind": r["kind"],
        "model": r["model"],
        "saved": r["saved"],
        "ok": r["ok"],
        "error": r["error"],
        "latency_ms": r["latency_ms"],
        "n_items": r["n_items"],
        "tokens_estimated": r["tokens_estimated"],
        "tokens": {
            "prompt": r["prompt_tokens"],
            "output": r["output_tokens"],
            "thinking": r["thinking_tokens"],
            "total": r["total_tokens"],
        },
    }


# ---------------------------------------------------------------------------
# GET /api/pipeline
# ---------------------------------------------------------------------------

_OPCLASS = re.compile(r"vector_\w+_ops")


def pipeline() -> dict[str, Any]:
    """The live configuration, so the UI can describe this system instead of a system.

    Deliberately reads the index method and the stored vector dimension back out of the
    catalog rather than echoing settings: if someone changes EMBED_DIM without re-indexing,
    this endpoint is where the disagreement becomes visible.
    """
    with db.connection() as conn:
        corpus = conn.execute(_CORPUS_SQL).fetchone()
        index = conn.execute(_INDEX_SQL, {"table": "chunks"}).fetchone()
        stored_dim = conn.execute(_STORED_DIM_SQL, {"table": "chunks"}).fetchone()

    definition = (index or {}).get("definition") or ""
    opclass = _OPCLASS.search(definition)
    return {
        "models": {
            "chat": settings.gemini_chat_model,
            "embed": settings.gemini_embed_model,
            "thinking_level": gemini.thinking_level() or "off",
            "temperature": 0.2,
        },
        "embedding": {
            "dim": settings.embed_dim,
            "stored_dim": int(stored_dim["dim"]) if stored_dim else None,
            "normalized": True,
            "why_normalized": (
                "gemini-embedding-001 only pre-normalizes its native 3072-dim output. We "
                "request output_dimensionality=768 (Matryoshka truncation) so the vectors "
                "fit pgvector's 2000-dim HNSW limit, and truncated vectors come back with "
                "arbitrary magnitude. Cosine similarity via 1 - (a <=> b) is only "
                "meaningful on unit vectors, so both sides are L2-normalized in app code."
            ),
            "task_types": {"documents": gemini.TASK_DOCUMENT, "queries": gemini.TASK_QUERY},
            "why_task_types": (
                "Documents and questions only land in the same space when each side is "
                "embedded with its matching task type."
            ),
        },
        "chunking": {
            "chunk_size": settings.chunk_size,
            "chunk_overlap": settings.chunk_overlap,
            "overlap_ratio": round(settings.chunk_overlap / settings.chunk_size, 4)
            if settings.chunk_size
            else 0.0,
        },
        "retrieval": {
            "top_k": settings.top_k,
            "min_similarity": settings.min_similarity,
            "metric": "cosine",
            "distance_operator": "<=>",
            "similarity_formula": "1 - (chunk_embedding <=> query_embedding)",
            "index": {
                "name": (index or {}).get("name"),
                "method": (index or {}).get("method"),
                "opclass": opclass.group(0) if opclass else None,
                "definition": definition or None,
            },
        },
        "cache": {
            "enabled": settings.semantic_cache_enabled,
            "semantic_threshold": settings.semantic_cache_threshold,
            "ttl_hours": settings.cache_ttl_hours,
            "layers": [
                {
                    "name": "embedding_cache",
                    "keyed_on": "sha256(text) + task_type + dim",
                    "avoids": "embed_document / embed_query",
                    "rows": int(corpus["embedding_cache_rows"]),
                },
                {
                    "name": "query_cache (exact)",
                    "keyed_on": "normalised question + document scope",
                    "avoids": "embed_query + generate",
                    "rows": int(corpus["query_cache_rows"]),
                },
                {
                    "name": "query_cache (semantic)",
                    "keyed_on": f"question embedding, cosine >= {settings.semantic_cache_threshold}",
                    "avoids": "generate",
                    "rows": int(corpus["query_cache_rows"]),
                },
            ],
        },
        "corpus": {
            "documents": int(corpus["documents"]),
            "ready_documents": int(corpus["ready_documents"]),
            "chunks": int(corpus["chunks"]),
            "total_chunk_chars": int(corpus["chunk_chars"]),
            "avg_chunk_chars": int(corpus["avg_chunk_chars"]),
            "min_chunk_chars": int(corpus["min_chunk_chars"]),
            "max_chunk_chars": int(corpus["max_chunk_chars"]),
            # pg_column_size, so this is what the vectors actually occupy on disk
            # (4 bytes per dimension plus pgvector's header), not a formula.
            "vector_bytes": int(corpus["vector_bytes"]),
            "embedding_cache_rows": int(corpus["embedding_cache_rows"]),
            "embedding_cache_vector_bytes": int(corpus["embedding_cache_vector_bytes"]),
            "query_cache_rows": int(corpus["query_cache_rows"]),
        },
        "limits": {
            "max_upload_bytes": settings.max_upload_bytes,
            "allowed_extensions": sorted(_allowed_extensions()),
        },
    }


def _allowed_extensions() -> set[str]:
    from . import extract

    return extract.ALLOWED_EXTENSIONS


_CORPUS_SQL = """
SELECT (SELECT count(*) FROM documents)                              AS documents,
       (SELECT count(*) FROM documents WHERE status = 'ready')       AS ready_documents,
       (SELECT count(*) FROM chunks)                                 AS chunks,
       (SELECT coalesce(sum(n_chars), 0) FROM chunks)                AS chunk_chars,
       (SELECT coalesce(round(avg(n_chars)), 0) FROM chunks)         AS avg_chunk_chars,
       (SELECT coalesce(min(n_chars), 0) FROM chunks)                AS min_chunk_chars,
       (SELECT coalesce(max(n_chars), 0) FROM chunks)                AS max_chunk_chars,
       (SELECT coalesce(sum(pg_column_size(embedding)), 0) FROM chunks) AS vector_bytes,
       (SELECT count(*) FROM embedding_cache)                        AS embedding_cache_rows,
       (SELECT coalesce(sum(pg_column_size(embedding)), 0) FROM embedding_cache)
                                                                     AS embedding_cache_vector_bytes,
       (SELECT count(*) FROM query_cache)                            AS query_cache_rows
"""

_INDEX_SQL = """
SELECT i.relname AS name, am.amname AS method, pg_get_indexdef(i.oid) AS definition
  FROM pg_class t
  JOIN pg_index x ON x.indrelid = t.oid
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_am am   ON am.oid = i.relam
 WHERE t.relname = %(table)s AND am.amname IN ('hnsw', 'ivfflat')
 LIMIT 1
"""

# pgvector stores the declared dimension straight in atttypmod, so this is the real
# on-disk width rather than what config.py hopes it is.
_STORED_DIM_SQL = """
SELECT a.atttypmod AS dim
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
 WHERE c.relname = %(table)s AND a.attname = 'embedding'
"""
