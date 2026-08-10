"""Everything that talks to the Gemini API, plus the embedding cache in front of it.

The public embed_* functions are cache-aware: nothing here calls the API for text whose
vector is already in `embedding_cache`.

Every request also lands in the `api_calls` table before it leaves this module, so
/api/metrics can price the demo honestly. See _api_call().
"""

from __future__ import annotations

import hashlib
import logging
import random
import time
from collections.abc import Callable, Generator, Iterator
from dataclasses import dataclass

import numpy as np
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pgvector import Vector

from . import db
from .config import settings

log = logging.getLogger(__name__)

# task_type is not cosmetic: gemini-embedding-001 places documents and questions in the
# same space *only* when each side is embedded with its matching task type. Indexing with
# RETRIEVAL_DOCUMENT and querying with RETRIEVAL_QUERY measurably beats using one for both.
TASK_DOCUMENT = "RETRIEVAL_DOCUMENT"
TASK_QUERY = "RETRIEVAL_QUERY"

# A single embed request is capped at roughly 2048 tokens *in total*, so batch by
# character budget rather than by item count alone (~4 chars/token, kept conservative).
_MAX_BATCH_ITEMS = 16
_MAX_BATCH_CHARS = 6_000
_MAX_TEXT_CHARS = 6_000

# api_calls.kind — the only three values written.
KIND_EMBED_DOCUMENT = "embed_document"
KIND_EMBED_QUERY = "embed_query"
KIND_GENERATE = "generate"

_TASK_KINDS = {TASK_DOCUMENT: KIND_EMBED_DOCUMENT, TASK_QUERY: KIND_EMBED_QUERY}

_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not settings.gemini_api_key:
            raise RuntimeError("GEMINI_API_KEY is not set — check the .env at the repo root.")
        _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


def configured() -> bool:
    """Cheap health signal. We deliberately do not burn an API call per /api/health poll."""
    return bool(settings.gemini_api_key)


# ---------------------------------------------------------------------------
# Vectors
# ---------------------------------------------------------------------------


def l2_normalize(values) -> list[float]:
    """Scale a vector to unit length.

    REQUIRED: gemini-embedding-001 only pre-normalizes its native 3072-dim output. We ask
    for output_dimensionality=768 (Matryoshka truncation, so it fits pgvector's 2000-dim
    HNSW limit), and truncated vectors come back with arbitrary magnitude. Cosine
    similarity via `1 - (a <=> b)` is only meaningful on unit vectors, so both the
    document path and the query path normalize here — the one shared helper.
    """
    arr = np.asarray(values, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    if norm == 0.0:
        return arr.tolist()
    return (arr / norm).tolist()


# ---------------------------------------------------------------------------
# Retry + telemetry
#
# Nothing in this module calls the network directly: every request goes through
# _api_call(), which times it and writes exactly one api_calls row per *attempt* —
# including the attempts that fail. A new call site cannot silently skip accounting.
# ---------------------------------------------------------------------------


@dataclass
class _Usage:
    prompt: int = 0
    output: int = 0
    thinking: int = 0
    total: int = 0
    estimated: bool = False


def _usage_from(meta) -> _Usage:
    """Read google-genai's usage_metadata. Fields are read defensively because a model
    that does no thinking simply omits thoughts_token_count."""
    if meta is None:
        return _Usage()
    prompt = int(getattr(meta, "prompt_token_count", 0) or 0)
    output = int(getattr(meta, "candidates_token_count", 0) or 0)
    thinking = int(getattr(meta, "thoughts_token_count", 0) or 0)
    total = int(getattr(meta, "total_token_count", 0) or 0)
    return _Usage(prompt, output, thinking, total or prompt + output + thinking)


def _response_usage(response) -> _Usage:
    return _usage_from(getattr(response, "usage_metadata", None))


def _estimated_embed_usage(texts: list[str]) -> _Usage:
    """Embedding responses carry NO usage_metadata — verified on gemini-embedding-001,
    the attribute is None. So this is an ESTIMATE at the usual ~4 chars/token, written
    with tokens_estimated = true and surfaced as estimated everywhere downstream. It is
    never presented as a measurement."""
    tokens = sum(max(1, len(t) // 4) for t in texts)
    return _Usage(prompt=tokens, total=tokens, estimated=True)


def _record(
    kind: str,
    model: str,
    *,
    latency_ms: int,
    usage: _Usage | None = None,
    n_items: int = 1,
    ok: bool = True,
    error: str | None = None,
    saved: bool = False,
) -> None:
    """One INSERT. Telemetry must never be able to break a request, so every failure
    here is logged and swallowed."""
    u = usage or _Usage()
    try:
        with db.connection() as conn:
            conn.execute(
                """
                INSERT INTO api_calls (kind, model, prompt_tokens, output_tokens,
                                       thinking_tokens, total_tokens, tokens_estimated,
                                       latency_ms, n_items, ok, error, saved)
                VALUES (%(kind)s, %(model)s, %(prompt)s, %(output)s, %(thinking)s,
                        %(total)s, %(est)s, %(latency)s, %(n)s, %(ok)s, %(error)s, %(saved)s)
                """,
                {
                    "kind": kind,
                    "model": model,
                    "prompt": u.prompt,
                    "output": u.output,
                    "thinking": u.thinking,
                    "total": u.total,
                    "est": u.estimated,
                    "latency": latency_ms,
                    "n": n_items,
                    "ok": ok,
                    "error": (error or "")[:2000] or None,
                    "saved": saved,
                },
            )
    except Exception:
        log.exception("api_calls telemetry insert failed for kind=%s (ignored)", kind)


def record_saved(kind: str, model: str, n_items: int = 1) -> None:
    """Record a call that did NOT happen because a cache answered first.

    Savings are only believable if they are counted the same way as spend, in the same
    table, at the moment they occur — not inferred later from a hit counter.
    """
    _record(kind, model, latency_ms=0, n_items=n_items, saved=True)


def _with_retry(what: str, call: Callable):
    """3 attempts, 1s/2s/4s + jitter, for 429 and 5xx only.

    400/403 mean the request or the key is wrong; retrying just wastes quota.
    """
    delay = 1.0
    for attempt in range(3):
        try:
            return call()
        except genai_errors.ClientError as exc:
            if getattr(exc, "code", None) != 429 or attempt == 2:
                raise
            log.warning("%s rate-limited (429), retrying in %.1fs", what, delay)
        except genai_errors.ServerError:
            if attempt == 2:
                raise
            log.warning("%s server error, retrying in %.1fs", what, delay)
        time.sleep(delay + random.uniform(0, 0.25))
        delay *= 2
    raise RuntimeError("unreachable")


def _api_call(
    kind: str,
    model: str,
    call: Callable,
    *,
    n_items: int = 1,
    usage_of: Callable[[object], _Usage] | None = None,
):
    """One retried Gemini request, with one api_calls row per attempt.

    The row is written inside the retried closure, so a 429 that cost 900ms and produced
    nothing still shows up as a failed call with real latency — which is the whole point
    of measuring.
    """

    def attempt():
        started = time.perf_counter()
        try:
            result = call()
        except Exception as exc:
            _record(
                kind,
                model,
                latency_ms=_ms(started),
                n_items=n_items,
                ok=False,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise
        _record(
            kind,
            model,
            latency_ms=_ms(started),
            n_items=n_items,
            usage=usage_of(result) if usage_of else None,
        )
        return result

    return _with_retry(f"{kind}(n={n_items})", attempt)


def _ms(since: float) -> int:
    return int((time.perf_counter() - since) * 1000)


# ---------------------------------------------------------------------------
# Embeddings (cache-aware)
# ---------------------------------------------------------------------------


# Yields progress dicts as it goes; *returns* the finished vectors.
EmbedProgress = Generator[dict[str, int], None, list[list[float]]]


def embed_documents(texts: list[str]) -> list[list[float]]:
    """Embed chunks for indexing."""
    return _drain(_embed(texts, TASK_DOCUMENT))


def embed_query(text: str) -> list[float]:
    """Embed a question for searching."""
    return _drain(_embed([text], TASK_QUERY))[0]


def embed_documents_progress(texts: list[str]) -> EmbedProgress:
    """embed_documents, narrated.

    Yields a progress dict after the cache lookup and after every API batch:

        {"done": 5, "total": 11, "cached": 2, "api_calls": 1}

    `cached` is how many of `texts` were served from `embedding_cache` (no API call at
    all), `api_calls` is the cumulative number of embed requests actually sent. The
    finished vectors are the generator's *return* value, so callers must read
    StopIteration.value — or just use embed_documents if they don't want progress.
    """
    return _embed(texts, TASK_DOCUMENT)


def _embed(texts: list[str], task_type: str) -> EmbedProgress:
    """The one embedding implementation. A generator so progress is observable; the
    vectors come back as the return value, in the same order as `texts`."""
    if not texts:
        return []

    digests = [_sha256(t) for t in texts]
    cached = _cache_get(digests, task_type)

    total = len(texts)
    # Count texts, not digests: a document that repeats a paragraph resolves both copies.
    n_cached = sum(1 for d in digests if d in cached)
    api_calls = 0
    yield {"done": n_cached, "total": total, "cached": n_cached, "api_calls": api_calls}

    _record_embed_savings(digests, texts, cached, task_type)

    # Only embed what we have never seen — de-duplicated, so a document that repeats a
    # paragraph pays for it once.
    todo: dict[str, str] = {}
    for digest, text in zip(digests, texts, strict=True):
        if digest not in cached and digest not in todo:
            todo[digest] = text

    if todo:
        pending_digests = list(todo)
        pending_texts = [todo[d] for d in pending_digests]
        fresh: dict[str, list[float]] = {}
        for start, end in _batches(pending_texts):
            vectors = _embed_api(pending_texts[start:end], task_type)
            # One request per batch. A retried batch still only lands once, so this is
            # the number of calls the quota was actually charged for.
            api_calls += 1
            for digest, vector in zip(pending_digests[start:end], vectors, strict=True):
                fresh[digest] = vector
            done = sum(1 for d in digests if d in cached or d in fresh)
            yield {"done": done, "total": total, "cached": n_cached, "api_calls": api_calls}
        _cache_put(fresh, task_type)
        cached.update(fresh)

    return [cached[d] for d in digests]


def _drain(progress: EmbedProgress) -> list[list[float]]:
    """Run an _embed generator to completion and hand back what it returned."""
    while True:
        try:
            next(progress)
        except StopIteration as stop:
            return stop.value or []


def _record_embed_savings(
    digests: list[str], texts: list[str], cached: dict[str, list[float]], task_type: str
) -> None:
    """Log the embed requests `embedding_cache` made unnecessary.

    Counted as *requests*, not texts, so it is directly comparable to the requests we did
    send: re-batch exactly the texts that came from cache and count the batches. One
    saved_call row per batch avoided.
    """
    seen: set[str] = set()
    hits: list[str] = []
    for digest, text in zip(digests, texts, strict=True):
        if digest in cached and digest not in seen:
            seen.add(digest)
            hits.append(text)
    if not hits:
        return
    for start, end in _batches(hits):
        record_saved(_TASK_KINDS[task_type], settings.gemini_embed_model, n_items=end - start)


def _embed_api(batch: list[str], task_type: str) -> list[list[float]]:
    client = get_client()
    response = _api_call(
        _TASK_KINDS[task_type],
        settings.gemini_embed_model,
        lambda: client.models.embed_content(
            model=settings.gemini_embed_model,
            contents=batch,
            config=types.EmbedContentConfig(
                task_type=task_type,
                output_dimensionality=settings.embed_dim,
            ),
        ),
        n_items=len(batch),
        # Estimated, not measured — embed responses have no usage_metadata.
        usage_of=lambda _response: _estimated_embed_usage(batch),
    )
    return [l2_normalize(e.values) for e in response.embeddings]


def _batches(texts: list[str]):
    """Yield (start, end) index pairs respecting both the item and character budgets."""
    start = 0
    chars = 0
    for i, text in enumerate(texts):
        size = len(text)
        if i > start and (i - start >= _MAX_BATCH_ITEMS or chars + size > _MAX_BATCH_CHARS):
            yield start, i
            start, chars = i, 0
        chars += size
    if start < len(texts):
        yield start, len(texts)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _cache_get(digests: list[str], task_type: str) -> dict[str, list[float]]:
    if not digests:
        return {}
    with db.connection() as conn:
        rows = conn.execute(
            """
            SELECT content_sha256, embedding
              FROM embedding_cache
             WHERE content_sha256 = ANY(%(digests)s) AND task_type = %(task)s AND dim = %(dim)s
            """,
            {"digests": list(set(digests)), "task": task_type, "dim": settings.embed_dim},
        ).fetchall()
    # pgvector's psycopg loader hands back a `Vector` object, not a list or ndarray, so
    # np.asarray() on it raises. `.to_list()` is the documented way out. Everything
    # downstream expects plain floats.
    return {r["content_sha256"]: _to_floats(r["embedding"]) for r in rows}


def _to_floats(value) -> list[float]:
    """Normalise whatever pgvector hands back into a plain list[float]."""
    if hasattr(value, "to_list"):  # pgvector.Vector
        return value.to_list()
    return np.asarray(value, dtype=np.float32).tolist()


def _cache_put(vectors: dict[str, list[float]], task_type: str) -> None:
    if not vectors:
        return
    with db.connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO embedding_cache (content_sha256, task_type, dim, embedding)
            VALUES (%(sha)s, %(task)s, %(dim)s, %(vec)s)
            ON CONFLICT (content_sha256, task_type, dim) DO NOTHING
            """,
            [
                {
                    "sha": digest,
                    "task": task_type,
                    "dim": settings.embed_dim,
                    # pgvector's psycopg dumper is registered for Vector/ndarray, never for
                    # a bare list — a plain list would silently become a Postgres array.
                    "vec": Vector(vector),
                }
                for digest, vector in vectors.items()
            ],
        )


def truncate_for_embedding(text: str) -> str:
    return text[:_MAX_TEXT_CHARS]


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


_THINKING_OFF = {"", "off", "none", "disabled"}


def thinking_level() -> str | None:
    """The configured level, or None for 'send no thinking_config at all'."""
    level = (settings.gemini_thinking_level or "").strip().lower()
    return None if level in _THINKING_OFF else level


def _generate_config(system_instruction: str, with_thinking: bool) -> types.GenerateContentConfig:
    kwargs: dict = {
        "system_instruction": system_instruction,
        "temperature": 0.2,  # grounded answers should not be creative
    }
    level = thinking_level()
    if with_thinking and level:
        # thinking_level, never thinking_budget: budget=0 is a 400 on gemini-flash-latest.
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=level)
    return types.GenerateContentConfig(**kwargs)


def _thinking_attempts() -> list[bool]:
    """Try with thinking_config, then once without.

    A future model that rejects the config should degrade to a warning, not an outage,
    so the fallback is built in rather than left to whoever is on call.
    """
    return [True, False] if thinking_level() else [False]


def _thinking_rejected(exc: Exception) -> bool:
    return isinstance(exc, genai_errors.ClientError) and getattr(exc, "code", None) == 400


def generate(prompt: str, system_instruction: str) -> str:
    client = get_client()
    for with_thinking in _thinking_attempts():
        try:
            response = _api_call(
                KIND_GENERATE,
                settings.gemini_chat_model,
                lambda: client.models.generate_content(
                    model=settings.gemini_chat_model,
                    contents=prompt,
                    config=_generate_config(system_instruction, with_thinking),
                ),
                usage_of=_response_usage,
            )
        except Exception as exc:
            if with_thinking and _thinking_rejected(exc):
                log.warning(
                    "thinking_level=%r rejected by %s (%s); retrying without thinking_config",
                    thinking_level(),
                    settings.gemini_chat_model,
                    exc,
                )
                continue
            raise
        return (response.text or "").strip()
    raise RuntimeError("unreachable")


def generate_stream(prompt: str, system_instruction: str) -> Iterator[str]:
    """Yield answer text as it arrives. Not retried on transport errors: once bytes are on
    the wire to the client, replaying the call would duplicate tokens. The one retry is a
    400 rejecting thinking_config, which can only land before the first token."""
    client = get_client()
    for with_thinking in _thinking_attempts():
        started = time.perf_counter()
        usage = _Usage()
        emitted = False
        try:
            stream = client.models.generate_content_stream(
                model=settings.gemini_chat_model,
                contents=prompt,
                config=_generate_config(system_instruction, with_thinking),
            )
            for chunk in stream:
                # usage_metadata rides the final chunk(s); keep the last non-null one.
                meta = getattr(chunk, "usage_metadata", None)
                if meta is not None:
                    usage = _usage_from(meta)
                if chunk.text:
                    emitted = True
                    yield chunk.text
        except Exception as exc:
            _record(
                KIND_GENERATE,
                settings.gemini_chat_model,
                latency_ms=_ms(started),
                usage=usage,
                ok=False,
                error=f"{type(exc).__name__}: {exc}",
            )
            if with_thinking and not emitted and _thinking_rejected(exc):
                log.warning(
                    "thinking_level=%r rejected by %s (%s); retrying without thinking_config",
                    thinking_level(),
                    settings.gemini_chat_model,
                    exc,
                )
                continue
            raise
        _record(
            KIND_GENERATE, settings.gemini_chat_model, latency_ms=_ms(started), usage=usage
        )
        return
