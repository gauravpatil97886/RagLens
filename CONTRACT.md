# API Contract — frozen. Backend and frontend both build against this.

Backend runs on `http://localhost:8000`. Frontend dev server on `http://localhost:5173`
proxies `/api/*` -> `http://localhost:8000/api/*` via Vite's `server.proxy`, so the
frontend only ever calls same-origin relative paths like `/api/documents`.

All errors use HTTP status + `{"detail": "human readable message"}`.

---

## `GET /api/health`
```json
{ "status": "ok", "db": true, "gemini": true, "chunks": 128, "documents": 3 }
```

## `POST /api/documents` — upload + ingest
`multipart/form-data`, field name `file`. Accepts `.pdf .txt .md .docx`. Max 20 MB.

**201 Response:**
```json
{
  "id": 1,
  "filename": "handbook.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 48211,
  "n_chunks": 42,
  "n_chars": 51203,
  "status": "ready",
  "created_at": "2026-08-10T15:40:00Z",
  "ingest_ms": 3120
}
```
`status` is one of `pending | processing | ready | failed`. On `failed` there is also
`"error": "..."`. Ingestion is synchronous — the response returns when it is done.
For live progress use `POST /api/documents/stream`; this endpoint stays as the fallback.

## `POST /api/documents/stream` — same upload, streamed
Identical request: `multipart/form-data`, field name `file`, same extensions, same 20 MB
limit. Rejections (`400`, `413`) are still ordinary HTTP errors — the stream only opens
once the file is accepted. Responds `200 text/event-stream`, one JSON object per `data:`
line:

```
data: {"type":"stage","stage":"extracting","label":"Reading acme.pdf"}
data: {"type":"stage","stage":"extracted","n_chars":9093,"label":"Extracted 9,093 characters"}
data: {"type":"stage","stage":"chunking","label":"Splitting into chunks"}
data: {"type":"chunk","index":0,"n_chars":1180,"preview":"Acme Innotech Pvt. Ltd. — Employee Handbook…"}
data: {"type":"chunked","n_chunks":11,"label":"11 chunks"}
data: {"type":"stage","stage":"embedding","label":"Embedding 11 chunks"}
data: {"type":"embedding","done":0,"total":11,"cached":0,"api_calls":0}
data: {"type":"embedding","done":5,"total":11,"cached":0,"api_calls":1}
data: {"type":"stage","stage":"indexing","label":"Writing vectors to pgvector"}
data: {"type":"done","document":{ ...exactly the POST /api/documents object, ingest_ms included... }}
```
On error: `data: {"type":"error","detail":"..."}` then the stream closes; the document row
is already `status: "failed"` with that message, exactly as on the non-streaming path.

Order is `extracting` -> `extracted` -> `chunking` -> `chunk`* -> `chunked` ->
`embedding` -> `embedding`* -> `indexing` -> `done`.
`stage` is one of `extracting | extracted | chunking | embedding | indexing`; `n_chars`
appears on `extracted` only.

Every frame is something that has already happened — nothing is interpolated and nothing
is delayed to look smoother, so a stage that is instant arrives instantly.
- One `chunk` frame per chunk, emitted as the splitter produces it, never batched.
  `preview` is the first ~90 characters with whitespace collapsed.
- One `embedding` frame after the cache lookup, then one after each completed API batch.
  `done`/`total` are chunks, `cached` is how many came from `embedding_cache` (no API
  call), `api_calls` is the cumulative number of embed requests actually sent. Re-upload
  the same file and you get a single frame with `done == total == cached` and
  `api_calls: 0` — the embedding cache, demonstrated.

Both endpoints run the same generator server-side, so they cannot drift apart.

## `GET /api/documents` — list
```json
{ "documents": [ <document object as above>, ... ] }
```
Newest first. Every object has the same shape as the upload response (minus `ingest_ms`).

## `DELETE /api/documents/{id}`
`204` on success, `404` if unknown. Cascades to chunks and invalidates cached answers.

---

## `POST /api/chat` — ask a question (non-streaming)
```json
{ "question": "What is the refund window?", "document_ids": [1,2], "top_k": 5 }
```
`document_ids` optional — omit or `null` to search every document. `top_k` optional.

**200 Response:**
```json
{
  "answer": "Refunds are accepted within 30 days [1].",
  "citations": [
    {
      "n": 1,
      "chunk_id": 87,
      "document_id": 1,
      "filename": "handbook.pdf",
      "chunk_index": 12,
      "similarity": 0.8134,
      "content": "...the full chunk text that was retrieved..."
    }
  ],
  "cached": false,
  "cache": {
    "hit": true,
    "kind": "semantic",
    "similarity": 0.9412,
    "matched_question": "What is the refund window?",
    "age_seconds": 412,
    "saved_api_calls": 1
  },
  "timings_ms": { "embed": 210, "cache_lookup": 4, "retrieve": 8, "generate": 0, "total": 222 }
}
```
On a miss, `cache` is `{"hit": false, "kind": "miss", "similarity": null,
"matched_question": null, "age_seconds": null, "saved_api_calls": 0, "nearest": ...,
"threshold": 0.87}`.
`kind` is `exact | semantic | miss`. On `exact`, `similarity` is `1.0`.
When `hit` is true, `timings_ms.generate` is `0` — that is the point of the cache.

Every cache object also carries `threshold` (the configured cut-off) and `nearest`.
`nearest` is `null` except on a semantic near-miss, where it is
`{"question": "...", "similarity": 0.8612}` — the closest cached question that still
failed the bar. The UI should show this ("closest match 0.86, needs 0.87") so the
threshold is tunable rather than a black box. Both fields are additive; treat them as
optional if you are reading an older response.
If nothing clears `MIN_SIMILARITY`, return `200` with `citations: []` and an `answer`
that says the documents don't cover it. Never invent an answer with no sources.

`answer` cites sources inline as `[1]`, `[2]` matching `citations[].n`.

## `POST /api/chat/stream` — same request body, streaming
`text/event-stream`. Events, each `data:` line is one JSON object:

```
data: {"type":"cache","cache":{ ...cache object as above... }}
data: {"type":"retrieval","citations":[ ...same shape as above... ]}
data: {"type":"token","text":"Refunds "}
data: {"type":"token","text":"are accepted "}
data: {"type":"done","cached":false,"cache":{...},"timings_ms":{...}}
```
On error: `data: {"type":"error","detail":"..."}` then the stream closes.
Event order is always `cache` -> `retrieval` -> `token`* -> `done`, so the UI can show
the cache verdict and citation cards before any tokens arrive. On a cache hit the
cached answer is still replayed as `token` events (chunked ~8 chars, ~6ms apart) so the
typing animation looks identical — the UI just also shows the "94% semantic match" badge.

---

## `GET /api/cache` — inspect the semantic cache (teaching view)
```json
{
  "threshold": 0.95,
  "entries": [
    { "id": 3, "question": "What is the refund window?", "hits": 4,
      "answer_preview": "Refunds are accepted within 30 days...",
      "created_at": "2026-08-10T15:40:00Z", "last_hit_at": "2026-08-10T15:52:00Z" }
  ]
}
```

## `DELETE /api/cache` — clear it, so the effect is demoable
```json
{ "deleted": 7 }
```

---

## `GET /api/chunks/{document_id}` — inspect chunks (teaching/debug view)
```json
{ "chunks": [ { "id": 87, "chunk_index": 12, "n_chars": 1180, "content": "..." } ] }
```

## `GET /api/stats` — cache + corpus stats for the UI footer
```json
{
  "documents": 3, "chunks": 128,
  "cache_entries": 7, "cache_hits": 12, "cache_misses": 30, "hit_rate": 0.2857,
  "exact_hits": 5, "semantic_hits": 7,
  "saved_api_calls": 12, "embed_cache_rows": 140, "threshold": 0.95
}
```
