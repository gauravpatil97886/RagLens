"""FastAPI app. Endpoints are exactly those in CONTRACT.md.

Every route is a plain `def`, not `async def`: FastAPI runs sync routes in a threadpool,
which is the right place for blocking psycopg and blocking Gemini calls. The SSE endpoint
follows the same rule with a sync generator, which Starlette also iterates off the loop.
"""

from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import cache, db, extract, gemini, metrics, rag
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

    data = file.file.read()  # sync route, so read the underlying spooled file directly
    if not data:
        raise HTTPException(400, f"'{filename}' is empty.")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(
            413,
            f"'{filename}' is {len(data) / 1_048_576:.1f} MB; the limit is "
            f"{settings.max_upload_bytes // 1_048_576} MB.",
        )
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


@app.post("/api/documents/stream")
def upload_document_stream(file: UploadFile = File(...)):
    """Same ingestion, same pipeline, narrated as it happens.

    rag.ingest_events() is the single source of truth — POST /api/documents is the same
    generator drained — so the two paths cannot drift apart.
    """
    filename, data = _accept_upload(file)

    def events():
        started = time.perf_counter()
        try:
            for event in rag.ingest_events(filename, data):
                if event["type"] == "done":
                    # Only here does the raw row become the wire document, so the
                    # payload is byte-for-byte what POST /api/documents returns.
                    ingest_ms = int((time.perf_counter() - started) * 1000)
                    yield _sse(
                        {"type": "done", "document": _document(event["row"], ingest_ms=ingest_ms)}
                    )
                else:
                    yield _sse(event)
        except Exception as exc:  # the stream is already open, so errors go inline
            log.exception("ingest stream failed for %s", filename)
            yield _sse({"type": "error", "detail": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # stop nginx-style proxies buffering the stream
        },
    )


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

    def events():
        try:
            prep = rag.prepare(question, req.document_ids, req.top_k)

            # Order is fixed by the contract: cache verdict, then citation cards, then text.
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
            yield _sse({"type": "error", "detail": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(
        events(),
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
