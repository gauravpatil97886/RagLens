"""FastAPI app. Endpoints are exactly those in CONTRACT.md.

Every route is a plain `def`, not `async def`: FastAPI runs sync routes in a threadpool,
which is the right place for blocking psycopg and blocking Gemini calls. The SSE endpoint
follows the same rule with a sync generator, which Starlette also iterates off the loop.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import cache, costing, db, extract, gemini, infra, metrics, rag, web
from .config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("rag")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    log.info("schema ready; pool open")
    yield
    db.close_db()


app = FastAPI(title="RAG demo", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # The Vite dev server proxies /api, but direct calls from :5173 should work too.
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# The two read-only lens modules live in their own routers. They are mounted here rather
# than defining their routes in this file so that the app's wiring stays in one place and
# each module stays independently readable.
app.include_router(infra.router)
app.include_router(costing.router)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    """Never leak a bare stack trace to the UI; always the contract's {"detail": ...}."""
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _document(row: dict[str, Any], ingest_ms: int | None = None) -> dict[str, Any]:
    out = {
        "id": row["id"],
        "filename": row["filename"],
        "mime_type": row["mime_type"],
        "size_bytes": row["size_bytes"],
        "n_chunks": row["n_chunks"],
        "n_chars": row["n_chars"],
        "status": row["status"],
        "created_at": _iso(row["created_at"]),
        # Provenance, on every document: a file simply has nothing to say here, and the
        # UI gets one shape to render rather than two.
        "source_type": row["source_type"],
        "source_url": row["source_url"],
        "title": row["title"],
        "site_name": row["site_name"],
    }
    if row["status"] == "failed" and row.get("error"):
        out["error"] = row["error"]
    if ingest_ms is not None:
        out["ingest_ms"] = ingest_ms
    return out


def _sse(payload: dict[str, Any]) -> str:
    """One SSE frame. Both streaming endpoints send exactly this shape."""
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health():
    ok = db.healthy()
    documents = chunks = 0
    if ok:
        documents = db.scalar("SELECT count(*) FROM documents") or 0
        chunks = db.scalar("SELECT count(*) FROM chunks") or 0
    return {
        "status": "ok" if ok else "degraded",
        "db": ok,
        # Configured, not pinged: health is polled, and an embed call per poll costs quota.
        "gemini": gemini.configured(),
        "chunks": int(chunks),
        "documents": int(documents),
    }


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------


def _accept_upload(file: UploadFile) -> tuple[str, bytes]:
    """Validation shared by both upload endpoints. Rejections are real HTTP errors on
    both paths — a stream is only opened once we know we have something to ingest."""
    filename = file.filename or "upload"
    if extract.extension_of(filename) not in extract.ALLOWED_EXTENSIONS:
        raise HTTPException(
            400,
            f"Unsupported file type. Allowed: {', '.join(sorted(extract.ALLOWED_EXTENSIONS))}",
        )

    def too_big(n_bytes: int) -> HTTPException:
        """One wording for both size checks, so they cannot start disagreeing."""
        return HTTPException(
            413,
            f"'{filename}' is {n_bytes / 1_048_576:.1f} MB; the limit is "
            f"{settings.max_upload_bytes // 1_048_576} MB.",
        )

    # Starlette's multipart parser already counted the part while spooling it, so an
    # oversized upload can be refused before it ever becomes a bytes object in this
    # process. `size` is Optional in the UploadFile API — hence the len(data) check
    # below, which stays as the belt to this brace rather than being replaced by it.
    if file.size is not None and file.size > settings.max_upload_bytes:
        raise too_big(file.size)

    data = file.file.read()  # sync route, so read the underlying spooled file directly
    if not data:
        raise HTTPException(400, f"'{filename}' is empty.")
    if len(data) > settings.max_upload_bytes:
        raise too_big(len(data))
    return filename, data


@app.post("/api/documents", status_code=201)
def upload_document(file: UploadFile = File(...)):
    filename, data = _accept_upload(file)

    started = time.perf_counter()
    try:
        row = rag.ingest(filename, data)
    except rag.IngestError as exc:
        # The document row is already marked 'failed' with this message.
        raise HTTPException(422, str(exc)) from exc

    return _document(row, ingest_ms=int((time.perf_counter() - started) * 1000))


@app.post("/api/documents/preflight")
def preflight_document(file: UploadFile = File(...)):
    """Analyse an upload and report what indexing it would cost. Spends nothing.

    Same validation, same extractor, same splitter, same batching maths as the real
    ingest — but no Gemini request and no row written, so the user can look at the price
    before agreeing to it.
    """
    filename, data = _accept_upload(file)
    try:
        return rag.preflight(filename, data)
    except (extract.ExtractionError, ValueError) as exc:
        # Exactly the failures ingest would have hit, raised before anything was written.
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/documents/stream")
def upload_document_stream(file: UploadFile = File(...)):
    """Same ingestion, same pipeline, narrated as it happens.

    rag.ingest_events() is the single source of truth — POST /api/documents is the same
    generator drained — so the two paths cannot drift apart.
    """
    filename, data = _accept_upload(file)
    return _ingest_stream(rag.ingest_events(filename, data), filename)


def _ingest_stream(source: Iterator[dict[str, Any]], what: str) -> StreamingResponse:
    """Serialise an ingest generator as SSE, and clean up if the client walks away.

    Files and links run different generators but produce the same frame vocabulary and
    need the same abandonment handling, so the wire half lives here once.
    """
    # Shared between the generator and the cleanup below, which Starlette may run on a
    # different thread once the response is over.
    run: dict[str, Any] = {"document_id": None, "settled": False}

    def cleanup():
        """Delete the row of a run the client walked away from.

        'settled' means the pipeline reached done or error — a finished document, or a
        failed one the user is entitled to see. Anything else is a row still saying
        'processing' that nothing will ever finish, so it goes. Idempotent, and never
        raises: a failed cleanup must not become the error the client sees.
        """
        if run["settled"] or run["document_id"] is None:
            return
        try:
            if rag.discard_partial(run["document_id"]):
                log.info(
                    "ingest of %s was abandoned; removed partial document %s and its chunks",
                    what,
                    run["document_id"],
                )
        except Exception:
            log.exception("failed to clean up abandoned document %s", run["document_id"])

    def events():
        started = time.perf_counter()
        try:
            for event in source:
                if event["type"] == "started":
                    run["document_id"] = event["document_id"]
                elif event["type"] == "error":
                    run["settled"] = True  # the row is already 'failed'; it stays
                if event["type"] == "done":
                    run["settled"] = True
                    # Only here does the raw row become the wire document, so the
                    # payload is byte-for-byte what POST /api/documents returns.
                    ingest_ms = int((time.perf_counter() - started) * 1000)
                    yield _sse(
                        {"type": "done", "document": _document(event["row"], ingest_ms=ingest_ms)}
                    )
                else:
                    yield _sse(event)
        except Exception as exc:  # the stream is already open, so errors go inline
            run["settled"] = True
            log.exception("ingest stream failed for %s", what)
            yield _sse({"type": "error", "detail": f"{type(exc).__name__}: {exc}"})
        finally:
            # Reached via GeneratorExit if this generator is closed early. It often is
            # not — a sync generator abandoned mid-stream is only finalised whenever the
            # interpreter gets round to it — so the BackgroundTask below is the cleanup
            # that actually happens on time, and this is the belt to its braces.
            cleanup()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # stop nginx-style proxies buffering the stream
        },
        # Runs once the response is over however it ended, including a client disconnect,
        # which is the only moment we can be sure nobody is going to read the rest.
        background=BackgroundTask(cleanup),
    )


# ---------------------------------------------------------------------------
# Documents from a link
# ---------------------------------------------------------------------------


class UrlRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


@app.post("/api/documents/url/preflight")
def preflight_url(req: UrlRequest):
    """Fetch a link, show what was scraped, and price indexing it. Spends nothing.

    Every refusal a link can earn — private address, wrong content type, no article text
    — surfaces here as a plain 400, before a row exists and before any quota is used.
    """
    try:
        result = rag.preflight_url(req.url.strip())
    except (web.FetchError, extract.ExtractionError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc

    if result["existing"]:
        # rag.py deals in rows; turning a timestamp into the wire format is this layer's job.
        result["existing"]["created_at"] = _iso(result["existing"]["created_at"])
    return result


@app.post("/api/documents/url/stream")
def ingest_url_stream(req: UrlRequest):
    """Fetch, scrape and index a link, narrated as it happens.

    The page is loaded here rather than inside the generator so a bad link is an ordinary
    400 instead of an error frame in a stream that should never have opened. It lands in
    web.py's body cache on the way through, so a preflight moments earlier means this
    costs no second request to the site — which is what `from_cache` on the `fetched`
    frame reports.
    """
    url = req.url.strip()
    try:
        page = web.load(url)
    except web.FetchError as exc:
        raise HTTPException(400, str(exc)) from exc

    return _ingest_stream(rag.ingest_url_events(url, page), url)


@app.get("/api/documents")
def list_documents():
    return {"documents": [_document(r) for r in rag.list_documents()]}


@app.delete("/api/documents/{document_id}", status_code=204)
def delete_document(document_id: int):
    if not rag.delete_document(document_id):
        raise HTTPException(404, f"No document with id {document_id}.")
    return Response(status_code=204)  # explicit: a 204 must carry no body at all


@app.get("/api/chunks/{document_id}")
def list_chunks(document_id: int):
    if rag.get_document(document_id) is None:
        raise HTTPException(404, f"No document with id {document_id}.")
    return {"chunks": rag.list_chunks(document_id)}


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    document_ids: list[int] | None = None
    top_k: int | None = Field(default=None, ge=1, le=50)


@app.post("/api/chat")
def chat(req: ChatRequest):
    return rag.answer(req.question.strip(), req.document_ids, req.top_k)


# Replay settings for cached answers: the UI's typing animation must look identical
# whether the text came from Gemini or from the cache.
_REPLAY_CHARS = 8
_REPLAY_DELAY = 0.006


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest):
    question = req.question.strip()
    # Opened out here, before the generator exists, because the response wrapper below
    # needs the id: every step of a streaming response runs in its own copy of the
    # context, so the trace has to re-stamp itself before each one.
    rec = costing.start(costing.KIND_CHAT, question)

    def events():
        with rec:
            try:
                prep = rag.prepare(question, req.document_ids, req.top_k)

                # Order is fixed by the contract: cache verdict, then citation cards,
                # then text.
                yield _sse({"type": "cache", "cache": prep.cache})
                yield _sse({"type": "retrieval", "citations": prep.citations})

                if prep.answer is not None:
                    # Cache hit, or the no-relevant-context short-circuit: replay, don't call.
                    for i in range(0, len(prep.answer), _REPLAY_CHARS):
                        yield _sse({"type": "token", "text": prep.answer[i : i + _REPLAY_CHARS]})
                        time.sleep(_REPLAY_DELAY)
                else:
                    started = time.perf_counter()
                    parts: list[str] = []
                    for token in rag.generate_stream(prep):
                        parts.append(token)
                        yield _sse({"type": "token", "text": token})
                    prep.timings["generate"] = int((time.perf_counter() - started) * 1000)
                    rag.finish(prep, "".join(parts))

                prep.timings["total"] = int((time.perf_counter() - prep.started) * 1000)
                rag.record_trace(rec, prep)
                yield _sse(
                    {
                        "type": "done",
                        "cached": prep.cache["hit"],
                        "cache": prep.cache,
                        "timings_ms": prep.timings,
                    }
                )
            except Exception as exc:  # the stream is already open, so errors go inline
                log.exception("stream failed")
                # Caught here, so the trace has to be told; an unraised failure is still
                # a failed action.
                rec.ok = False
                rec.error = f"{type(exc).__name__}: {exc}"
                yield _sse({"type": "error", "detail": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(
        rec.steps(events()),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # stop nginx-style proxies buffering the stream
        },
    )


# ---------------------------------------------------------------------------
# Cache inspection
# ---------------------------------------------------------------------------


@app.get("/api/cache")
def inspect_cache():
    with db.connection() as conn:
        rows = conn.execute(
            """
            SELECT id, question, hits, answer, created_at, last_hit_at
              FROM query_cache
             ORDER BY COALESCE(last_hit_at, created_at) DESC, id DESC
            """
        ).fetchall()
    return {
        "threshold": settings.semantic_cache_threshold,
        "entries": [
            {
                "id": r["id"],
                "question": r["question"],
                "hits": r["hits"],
                "answer_preview": (r["answer"][:160] + "...") if len(r["answer"]) > 160 else r["answer"],
                "created_at": _iso(r["created_at"]),
                "last_hit_at": _iso(r["last_hit_at"]),
            }
            for r in rows
        ],
    }


@app.delete("/api/cache")
def clear_cache():
    with db.connection() as conn:
        deleted = cache.clear(conn)
    return {"deleted": deleted}


@app.get("/api/stats")
def stats():
    with db.connection() as conn:
        counts = conn.execute(
            """
            SELECT (SELECT count(*) FROM documents)       AS documents,
                   (SELECT count(*) FROM chunks)          AS chunks,
                   (SELECT count(*) FROM query_cache)     AS cache_entries,
                   (SELECT count(*) FROM embedding_cache) AS embed_cache_rows
            """
        ).fetchone()
        s = conn.execute(
            "SELECT exact_hits, semantic_hits, misses FROM cache_stats WHERE id = true"
        ).fetchone() or {"exact_hits": 0, "semantic_hits": 0, "misses": 0}

    hits = int(s["exact_hits"]) + int(s["semantic_hits"])
    misses = int(s["misses"])
    total = hits + misses
    return {
        "documents": int(counts["documents"]),
        "chunks": int(counts["chunks"]),
        "cache_entries": int(counts["cache_entries"]),
        "cache_hits": hits,
        "cache_misses": misses,
        "hit_rate": round(hits / total, 4) if total else 0.0,
        "exact_hits": int(s["exact_hits"]),
        "semantic_hits": int(s["semantic_hits"]),
        # One generation call saved per hit.
        "saved_api_calls": hits,
        "embed_cache_rows": int(counts["embed_cache_rows"]),
        "threshold": settings.semantic_cache_threshold,
    }


# ---------------------------------------------------------------------------
# Cost + configuration (the teaching endpoints)
# ---------------------------------------------------------------------------


@app.get("/api/metrics")
def api_metrics():
    """Everything api_calls knows: what was spent, what the cache avoided, what it would
    have cost on the paid tier."""
    return metrics.snapshot()


@app.get("/api/pipeline")
def api_pipeline():
    """The live configuration and corpus shape, so the UI never has to hardcode a number."""
    return metrics.pipeline()
