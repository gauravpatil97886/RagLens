"""Everything that talks to the Gemini API, plus the embedding cache in front of it.

The public embed_* functions are cache-aware: nothing here calls the API for text whose
vector is already in `embedding_cache`.
"""

from __future__ import annotations

import hashlib
import logging
import random
import time
from collections.abc import Callable, Generator, Iterator

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
# Retry
# ---------------------------------------------------------------------------


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


def _embed_api(batch: list[str], task_type: str) -> list[list[float]]:
    client = get_client()
    response = _with_retry(
        f"embed({task_type}, n={len(batch)})",
        lambda: client.models.embed_content(
            model=settings.gemini_embed_model,
            contents=batch,
            config=types.EmbedContentConfig(
                task_type=task_type,
                output_dimensionality=settings.embed_dim,
            ),
        ),
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


def generate(prompt: str, system_instruction: str) -> str:
    client = get_client()
    response = _with_retry(
        "generate",
        lambda: client.models.generate_content(
            model=settings.gemini_chat_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.2,  # grounded answers should not be creative
            ),
        ),
    )
    return (response.text or "").strip()


def generate_stream(prompt: str, system_instruction: str) -> Iterator[str]:
    """Yield answer text as it arrives. Not retried: once bytes are on the wire to the
    client, replaying the call would duplicate tokens."""
    client = get_client()
    stream = client.models.generate_content_stream(
        model=settings.gemini_chat_model,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=0.2,
        ),
    )
    for chunk in stream:
        if chunk.text:
            yield chunk.text
