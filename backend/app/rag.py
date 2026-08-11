"""The RAG pipeline itself. This is the file to read if you want to understand RAG.

Ingest:  extract text -> split into chunks -> embed each chunk -> store vectors.
Answer:  (1) cache -> (2) embed question -> (3) retrieve -> (4) ground -> (5) generate.
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from pgvector import Vector

from . import cache, chunking, db, extract, gemini
from .config import settings

log = logging.getLogger(__name__)


class IngestError(Exception):
    """Ingestion failed; the document row has been marked 'failed' with this message."""


# The formatting half of this prompt is not cosmetic. The frontend renders GitHub
# markdown, so LaTeX arrives as literal `$$\frac{a}{b}$$`, and a citation the model tucks
# inside `\text{ [1][3] }` cannot be linked to its chunk. Both are fixed here, at the
# source, rather than by post-processing the answer with regexes.
SYSTEM_INSTRUCTION = r"""You are a retrieval-augmented assistant.

Grounding rules, in order of importance:
1. Answer using ONLY the numbered context blocks given to you. Never use outside
   knowledge, never guess, never fill gaps from memory.
2. Cite every factual claim with the number of the block it came from, like [1] or
   [2][3]. The numbers must match the blocks you were given.
3. If the context does not contain the answer, say so plainly — for example
   "The documents you've uploaded don't cover that." Do not apologise at length and do
   not offer a general-knowledge answer instead.
4. Be concise and concrete. Quote the source wording where precision matters.

Formatting rules — your output is rendered as GitHub-flavoured markdown:
5. NEVER use LaTeX. No `$...$`, no `$$...$$`, no `\frac`, no `\text{...}`, no `\times`,
   no backslash commands of any kind. Write formulas as plain text or in a backtick code
   span, for example:
   `shares = (weighted_salary / total_weighted_salary) * allocable_pool`
   Use plain characters for maths: * for multiply, / for divide, ^ for powers.
6. Use only these markdown features: paragraphs, `-` bullet lists, `1.` numbered lists,
   **bold**, `backtick code`, fenced code blocks, and markdown tables when the source
   material is genuinely tabular.
7. Put citations at the END of the sentence or clause they support, after any closing
   punctuation-free word, like this: The notice period is 60 days [2].
   Citations must NEVER appear inside a formula, a code span, a fenced code block, a
   table cell, or a heading. Write them strictly as [1] or [1][2] — never "1.", never a
   bare number, never [1, 2]."""

NO_CONTEXT_ANSWER = (
    "I couldn't find anything relevant to that in your documents. "
    "Nothing in the indexed text was similar enough to the question to answer from, "
    "so rather than guess, here's nothing — try rephrasing, or upload a document that "
    "covers it."
)


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------


def ingest(filename: str, data: bytes) -> dict[str, Any]:
    """Extract -> chunk -> embed -> store. Synchronous; returns the document row.

    Just ingest_events() drained: the non-streaming endpoint wants the last frame only.
    """
    row: dict[str, Any] | None = None
    for event in ingest_events(filename, data):
        if event["type"] == "error":
            # The document row is already marked 'failed' with this message.
            raise IngestError(event["detail"])
        if event["type"] == "done":
            row = event["row"]
    return row  # type: ignore[return-value]


def ingest_events(filename: str, data: bytes) -> Iterator[dict[str, Any]]:
    """The ingestion pipeline, narrated as it happens.

    Yields one dict per real event — never a guess, never an interpolation. A stage that
    is genuinely instant simply yields twice in a row. The vocabulary:

        {"type": "started", "document_id": 14}                   row exists, first frame
        {"type": "stage", "stage": "extracting", "label": ...}   a phase began
        {"type": "stage", "stage": "extracted", "n_chars": ...}  extraction finished
        {"type": "chunk", "index": 0, "n_chars": ..., "preview": ...}   per chunk
        {"type": "chunked", "n_chunks": ...}                     splitting finished
        {"type": "embedding", "done": 5, "total": 11, "cached": 2, "api_calls": 1}
        {"type": "done", "row": <documents row>}                 success, last frame
        {"type": "error", "detail": "..."}                       failure, last frame

    Failure is a frame, not an exception: the row is marked 'failed' first, then the
    error is yielded, so a caller that is already streaming can report it inline.
    Serialising these for the wire is main.py's job — `row` is the raw database row.
    """
    mime_type = extract.mime_for(filename)

    with db.connection() as conn:
        document_id = conn.execute(
            """
            INSERT INTO documents (filename, mime_type, size_bytes, status)
            VALUES (%s, %s, %s, 'processing')
            RETURNING id
            """,
            (filename, mime_type, len(data)),
        ).fetchone()["id"]

    # First frame, before any work: the client needs the row id to be able to abandon
    # this run and clean up after itself.
    yield {"type": "started", "document_id": document_id}

    try:
        yield {"type": "stage", "stage": "extracting", "label": f"Reading {filename}"}
        text = extract.extract_text(filename, data)
        yield {
            "type": "stage",
            "stage": "extracted",
            "n_chars": len(text),
            "label": f"Extracted {len(text):,} characters",
        }

        yield {"type": "stage", "stage": "chunking", "label": "Splitting into chunks"}
        chunks: list[str] = []
        for chunk in chunking.iter_chunks(text, settings.chunk_size, settings.chunk_overlap):
            chunks.append(chunk)
            yield {
                "type": "chunk",
                "index": len(chunks) - 1,
                "n_chars": len(chunk),
                "preview": _preview(chunk),
            }
        if not chunks:
            raise extract.ExtractionError(f"'{filename}' produced no chunks after splitting.")
        yield {
            "type": "chunked",
            "n_chunks": len(chunks),
            "label": f"{len(chunks)} chunk{'' if len(chunks) == 1 else 's'}",
        }

        # One embedding per chunk. The embed path checks embedding_cache first, so
        # re-uploading an identical file costs zero API calls — and says so, live.
        yield {
            "type": "stage",
            "stage": "embedding",
            "label": f"Embedding {len(chunks)} chunk{'' if len(chunks) == 1 else 's'}",
        }
        progress = gemini.embed_documents_progress(
            [gemini.truncate_for_embedding(c) for c in chunks]
        )
        while True:
            # The vectors are the generator's return value, so we drive it by hand
            # rather than with `yield from`, which would swallow them.
            try:
                step = next(progress)
            except StopIteration as stop:
                vectors = stop.value
                break
            yield {"type": "embedding", **step}

        yield {"type": "stage", "stage": "indexing", "label": "Writing vectors to pgvector"}
        with db.connection() as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """
                INSERT INTO chunks (document_id, chunk_index, content, n_chars, embedding)
                VALUES (%(doc)s, %(idx)s, %(content)s, %(n)s, %(vec)s)
                ON CONFLICT (document_id, chunk_index) DO NOTHING
                """,
                    [
                        {
                            "doc": document_id,
                            "idx": i,
                            "content": chunk,
                            "n": len(chunk),
                            # Vector(), never a bare list: pgvector's psycopg dumper is
                            # registered for Vector/ndarray only.
                            "vec": Vector(vector),
                        }
                        for i, (chunk, vector) in enumerate(zip(chunks, vectors, strict=True))
                    ],
                )
            conn.execute(
                """
                UPDATE documents
                   SET status = 'ready', n_chunks = %s, n_chars = %s, error = NULL,
                       content_sha256 = %s
                 WHERE id = %s
                """,
                (len(chunks), len(text), content_sha256(text), document_id),
            )
            # A new document changes the meaning of "search all documents".
            cache.invalidate_all_scope(conn)

    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        log.exception("ingest failed for %s", filename)
        with db.connection() as conn:
            conn.execute(
                "UPDATE documents SET status = 'failed', error = %s WHERE id = %s",
                (message[:2000], document_id),
            )
        yield {"type": "error", "detail": message}
        return

    yield {"type": "done", "row": get_document(document_id)}


def _preview(chunk: str, limit: int = 90) -> str:
    """The opening of a chunk on one line — enough to recognise it, never the whole thing."""
    flat = " ".join(chunk.split())
    return flat if len(flat) <= limit else flat[:limit].rstrip() + "…"


def content_sha256(text: str) -> str:
    """Identity of a document's *content*, so the same text uploaded under two filenames
    (or two formats) is recognisable as the same corpus material."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def discard_partial(document_id: int) -> bool:
    """Remove a document left behind by an ingest that never finished.

    Guarded on status so it is safe to call unconditionally and safe to call twice: a run
    that reached 'ready' is a real document and is never touched, and a row someone else
    already deleted simply matches nothing. Chunks go with it via the FK cascade.
    """
    with db.connection() as conn:
        deleted = conn.execute(
            "DELETE FROM documents WHERE id = %s AND status <> 'ready' RETURNING id",
            (document_id,),
        ).fetchone()
    return deleted is not None


# ---------------------------------------------------------------------------
# Preflight — what ingesting this file would cost, before spending anything
# ---------------------------------------------------------------------------

_PREFLIGHT_PREVIEW_CHUNKS = 5
_PREFLIGHT_PREVIEW_CHARS = 160
# Above this many embed requests the upload stops being instant and starts being a
# noticeable chunk of a free-tier day, which is worth saying out loud.
_MANY_API_CALLS = 20
# A PDF page of real prose runs to thousands of characters. Far below that and the pages
# are pictures with a caption — i.e. a scan that mostly failed to extract.
_SPARSE_PDF_CHARS_PER_PAGE = 50


def preflight(filename: str, data: bytes) -> dict[str, Any]:
    """Everything ingest() would do except the parts that cost money or write rows.

    Extraction and chunking are the real code paths, not a lookalike, and the embedding
    figures come from gemini.plan_embeddings() — otherwise the estimate would be a
    separate implementation free to disagree with reality, which is the one thing a
    "what will this cost" screen must never do.
    """
    text = extract.extract_text(filename, data)
    chunks = list(chunking.iter_chunks(text, settings.chunk_size, settings.chunk_overlap))
    if not chunks:
        raise extract.ExtractionError(f"'{filename}' produced no chunks after splitting.")

    # Truncated exactly as ingestion truncates, because that — not the raw chunk — is the
    # string that gets hashed, cached and embedded.
    embedding = gemini.plan_embeddings([gemini.truncate_for_embedding(c) for c in chunks])

    n_pages = extract.page_count(filename, data)
    sizes = [len(c) for c in chunks]

    return {
        "filename": filename,
        "mime_type": extract.mime_for(filename),
        "size_bytes": len(data),
        "n_chars": len(text),
        "n_pages": n_pages,
        "n_chunks": len(chunks),
        "chunk_chars": {
            "min": min(sizes),
            "mean": round(sum(sizes) / len(sizes)),
            "max": max(sizes),
        },
        "preview_chunks": [
            {
                "index": i,
                "n_chars": len(chunk),
                "preview": _preview(chunk, _PREFLIGHT_PREVIEW_CHARS),
            }
            for i, chunk in enumerate(chunks[:_PREFLIGHT_PREVIEW_CHUNKS])
        ],
        "embedding": {**embedding, "tokens_estimated": True},
        "duplicate": find_duplicate(text),
        "warnings": _preflight_warnings(filename, text, chunks, n_pages, embedding),
    }


def find_duplicate(text: str) -> dict[str, Any] | None:
    """An already-indexed document with byte-identical extracted text, if there is one."""
    with db.connection() as conn:
        row = conn.execute(
            """
            SELECT id, filename FROM documents
             WHERE status = 'ready' AND content_sha256 = %s
             ORDER BY id LIMIT 1
            """,
            (content_sha256(text),),
        ).fetchone()
    return None if row is None else {"document_id": row["id"], "filename": row["filename"]}


def _preflight_warnings(
    filename: str,
    text: str,
    chunks: list[str],
    n_pages: int | None,
    embedding: dict[str, int],
) -> list[str]:
    """Plain English, for someone who has never heard of a token or an embedding."""
    warnings: list[str] = []

    if n_pages and len(text) / n_pages < _SPARSE_PDF_CHARS_PER_PAGE:
        warnings.append(
            f"Only {len(text):,} characters came out of {n_pages} pages. This PDF is "
            "probably scanned images with little or no text layer — this demo does not "
            "run OCR, so most of the content will be missing."
        )
    if len(chunks) == 1:
        warnings.append(
            f"'{filename}' is short enough to fit in a single chunk, so retrieval will "
            "always return the whole document — fine for a quick test, but it does not "
            "show search doing any work."
        )
    if embedding["api_calls_needed"] > _MANY_API_CALLS:
        warnings.append(
            f"This will need {embedding['api_calls_needed']} embedding requests to "
            f"Google for {embedding['to_embed']} chunks. That is a large slice of the "
            "free tier's daily allowance and will take a while."
        )
    if embedding["to_embed"] == 0:
        warnings.append(
            "Every chunk of this file is already in the embedding cache, so indexing it "
            "costs no API calls at all."
        )
    return warnings


def get_document(document_id: int) -> dict[str, Any] | None:
    with db.connection() as conn:
        return conn.execute(
            """
            SELECT id, filename, mime_type, size_bytes, n_chunks, n_chars,
                   status, error, created_at
              FROM documents WHERE id = %s
            """,
            (document_id,),
        ).fetchone()


def list_documents() -> list[dict[str, Any]]:
    with db.connection() as conn:
        return conn.execute(
            """
            SELECT id, filename, mime_type, size_bytes, n_chunks, n_chars,
                   status, error, created_at
              FROM documents ORDER BY created_at DESC, id DESC
            """
        ).fetchall()


def delete_document(document_id: int) -> bool:
    with db.connection() as conn:
        deleted = conn.execute(
            "DELETE FROM documents WHERE id = %s RETURNING id", (document_id,)
        ).fetchone()
        if deleted is None:
            return False
        # chunks cascade via the FK; cached answers must be invalidated by hand.
        cache.invalidate_for_document(conn, document_id)
    return True


def list_chunks(document_id: int) -> list[dict[str, Any]]:
    with db.connection() as conn:
        return conn.execute(
            """
            SELECT id, chunk_index, n_chars, content
              FROM chunks WHERE document_id = %s ORDER BY chunk_index
            """,
            (document_id,),
        ).fetchall()


# ---------------------------------------------------------------------------
# Answering
# ---------------------------------------------------------------------------


@dataclass
class Prepared:
    """Everything the pipeline worked out before generation — shared by the plain and
    the streaming endpoint so both behave identically."""

    question: str
    scope_key: str
    started: float
    cache: dict[str, Any] = field(default_factory=cache.miss)
    citations: list[dict[str, Any]] = field(default_factory=list)
    answer: str | None = None  # set on a cache hit or a no-context short-circuit
    prompt: str | None = None  # set only when we actually have to call the LLM
    question_embedding: list[float] | None = None
    cacheable: bool = False
    timings: dict[str, int] = field(
        default_factory=lambda: {
            "embed": 0,
            "cache_lookup": 0,
            "retrieve": 0,
            "generate": 0,
            "total": 0,
        }
    )

    def finalize(self) -> "Prepared":
        self.timings["total"] = _ms(self.started)
        return self


def prepare(question: str, document_ids: list[int] | None, top_k: int | None) -> Prepared:
    k = top_k or settings.top_k
    prep = Prepared(
        question=question,
        scope_key=cache.scope_key(document_ids),
        started=time.perf_counter(),
    )

    # --- Stage 1: exact cache. Costs nothing — no embedding needed to compare strings.
    t0 = time.perf_counter()
    with db.connection() as conn:
        found = cache.lookup_exact(conn, question, prep.scope_key)
        if found:
            cache.record_hit(conn, found["row"]["id"])
            cache.bump_stats(conn, "exact")
    prep.timings["cache_lookup"] = _ms(t0)
    if found:
        prep.cache = found["cache"]
        # Replay the stored citations: the cached answer's [n] markers refer to them.
        prep.citations = found["row"]["citations"] or []
        prep.answer = found["row"]["answer"]
        # An exact hit skips BOTH remaining API calls — we never even embed the question,
        # because matching normalised strings needs no vector. Two saved calls, not one.
        gemini.record_saved(gemini.KIND_EMBED_QUERY, settings.gemini_embed_model)
        gemini.record_saved(gemini.KIND_GENERATE, settings.gemini_chat_model)
        return prep.finalize()

    # --- Stage 2: embed the question (RETRIEVAL_QUERY, not RETRIEVAL_DOCUMENT).
    t0 = time.perf_counter()
    prep.question_embedding = gemini.embed_query(gemini.truncate_for_embedding(question))
    prep.timings["embed"] = _ms(t0)

    # --- Stage 2b: semantic cache. Reuses the vector we just made for retrieval, so
    # checking the cache is free — no second embedding call.
    t0 = time.perf_counter()
    with db.connection() as conn:
        found = cache.lookup_semantic(conn, prep.question_embedding, prep.scope_key)
        # A result with row=None is a near miss: close enough to report, not to reuse.
        hit = bool(found and found["row"])
        if hit:
            cache.record_hit(conn, found["row"]["id"])
            cache.bump_stats(conn, "semantic")
        else:
            cache.bump_stats(conn, "miss")
    prep.timings["cache_lookup"] += _ms(t0)
    if found:
        # Carry the near-miss detail through even when we go on to generate.
        prep.cache = found["cache"]
    if hit:
        prep.citations = found["row"]["citations"] or []
        prep.answer = found["row"]["answer"]
        # Only the generation call is saved here: the embedding above already happened,
        # and is what made the match findable in the first place.
        gemini.record_saved(gemini.KIND_GENERATE, settings.gemini_chat_model)
        return prep.finalize()

    # --- Stage 3: retrieve the nearest chunks by cosine distance.
    t0 = time.perf_counter()
    prep.citations = retrieve(prep.question_embedding, document_ids, k)
    prep.timings["retrieve"] = _ms(t0)

    # Nothing cleared MIN_SIMILARITY -> short-circuit. We do NOT call the LLM: with no
    # relevant context it can only answer from its own weights, which is exactly the
    # hallucination RAG exists to prevent — and skipping the call is free.
    # Not cached either: a later upload could make this question answerable.
    if not prep.citations:
        prep.answer = NO_CONTEXT_ANSWER
        return prep.finalize()

    # --- Stage 4: ground. Build a prompt whose context blocks are numbered [1]..[k],
    # matching citations[].n exactly, so the model's markers resolve on the frontend.
    # prep.answer stays None: stage 5 happens in the caller, streamed or not.
    prep.prompt = build_prompt(question, prep.citations)
    prep.cacheable = True
    return prep


def retrieve(
    question_embedding: list[float], document_ids: list[int] | None, k: int
) -> list[dict[str, Any]]:
    """k nearest chunks. `<=>` is cosine DISTANCE, so similarity = 1 - distance and we
    order ascending. Only chunks above MIN_SIMILARITY are kept."""
    params: dict[str, Any] = {"q": Vector(question_embedding), "k": k}
    scope_filter = ""
    if document_ids:
        scope_filter = "AND c.document_id = ANY(%(ids)s)"
        params["ids"] = list(document_ids)

    with db.connection() as conn:
        rows = conn.execute(
            f"""
            SELECT c.id AS chunk_id, c.document_id, d.filename, c.chunk_index, c.content,
                   1 - (c.embedding <=> %(q)s) AS similarity
              FROM chunks c
              JOIN documents d ON d.id = c.document_id
             WHERE d.status = 'ready' {scope_filter}
             ORDER BY c.embedding <=> %(q)s
             LIMIT %(k)s
            """,
            params,
        ).fetchall()

    # Filter first, number second: citation numbers must run 1..k with no gaps, because
    # they are what the model is told to cite and what the UI resolves.
    keep = [r for r in rows if r["similarity"] >= settings.min_similarity]

    citations = []
    for n, row in enumerate(keep, start=1):
        citations.append(
            {
                "n": n,
                "chunk_id": row["chunk_id"],
                "document_id": row["document_id"],
                "filename": row["filename"],
                "chunk_index": row["chunk_index"],
                "similarity": round(float(row["similarity"]), 4),
                "content": row["content"],
            }
        )
    return citations


def build_prompt(question: str, citations: list[dict[str, Any]]) -> str:
    blocks = "\n\n".join(
        f"[{c['n']}] (source: {c['filename']}, chunk {c['chunk_index']})\n{c['content']}"
        for c in citations
    )
    return (
        "Context blocks:\n\n"
        f"{blocks}\n\n"
        "---\n"
        f"Question: {question}\n\n"
        "Answer using only the blocks above, citing them as [n]."
    )


def answer(question: str, document_ids: list[int] | None, top_k: int | None) -> dict[str, Any]:
    """Non-streaming path: prepare, then stage 5 if we still need it."""
    prep = prepare(question, document_ids, top_k)

    if prep.answer is None:
        t0 = time.perf_counter()
        text = gemini.generate(prep.prompt, SYSTEM_INSTRUCTION)
        prep.timings["generate"] = _ms(t0)
        finish(prep, text)
    else:
        text = prep.answer  # cache hit or short-circuit: generate stays 0

    prep.timings["total"] = _ms(prep.started)
    return {
        "answer": text,
        "citations": prep.citations,
        "cached": prep.cache["hit"],
        "cache": prep.cache,
        "timings_ms": prep.timings,
    }


def generate_stream(prep: Prepared) -> Iterator[str]:
    return gemini.generate_stream(prep.prompt, SYSTEM_INSTRUCTION)


def finish(prep: Prepared, text: str) -> None:
    """Store a freshly generated answer so the next asking of this question is free."""
    if not prep.cacheable or not text or prep.question_embedding is None:
        return
    with db.connection() as conn:
        cache.store(
            conn,
            prep.question,
            prep.scope_key,
            prep.question_embedding,
            text,
            prep.citations,
        )


def _ms(since: float) -> int:
    return int((time.perf_counter() - since) * 1000)
