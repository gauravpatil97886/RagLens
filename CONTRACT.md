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

---

## `GET /api/metrics` — what the demo actually cost

Everything is read back out of the `api_calls` table, which gets one row per Gemini
request *and* one row per request a cache made unnecessary. Rows are never deleted, so
these are cumulative-since-first-run totals, not a rolling window (except `timeseries`).

Two rules run through the whole payload:
- **`saved` rows are calls that did not happen.** They carry `latency_ms: 0` and no
  tokens. Every "calls"/"tokens" figure below counts only real calls; every
  "saved"/"avoided" figure counts only saved rows. They are never mixed.
- **Anything derived rather than observed is flagged `estimated: true`** and says what
  it was derived from. Embedding responses carry no `usage_metadata` at all, so
  `embed_query`/`embed_document` token counts are estimated at ~4 chars/token — hence
  `tokens_estimated` on those kinds and on each `recent` row.

`kind` is always one of `generate | embed_query | embed_document`.
`thinking_tokens` is its own field everywhere and is **never folded into output** — on a
thinking model it routinely dwarfs the answer (a 171-token answer measured 2,005 thinking
tokens at `thinking_level: high`). It *is* billed at the output rate, which is why
`cost.breakdown` prices it separately but at `rates.chat_output`.

```json
{
  "totals": {
    "api_calls": 12, "failed_calls": 1, "calls_saved": 9,
    "by_kind": {
      "generate": {
        "calls": 3, "failed": 1, "calls_saved": 2, "items": 3, "items_saved": 2,
        "tokens": { "prompt": 4284, "output": 81, "thinking": 565, "total": 4930 },
        "tokens_estimated": false
      },
      "embed_query":    { "calls": 8, "failed": 0, "calls_saved": 1, "items": 8, "items_saved": 1,
                          "tokens": { "prompt": 130, "output": 0, "thinking": 0, "total": 130 },
                          "tokens_estimated": true },
      "embed_document": { "calls": 1, "failed": 0, "calls_saved": 6, "items": 2, "items_saved": 31,
                          "tokens": { "prompt": 522, "output": 0, "thinking": 0, "total": 522 },
                          "tokens_estimated": true }
    },
    "tokens": { "prompt": 4936, "output": 81, "thinking": 565, "total": 5582,
                "estimated": 652, "measured": 4930 }
  },
  "latency_ms": {
    "overall": { "n": 12, "avg": 1041, "p50": 676, "p95": 2772, "max": 3256 },
    "by_kind": {
      "generate":       { "n": 3, "avg": 1959, "p50": 2376, "p95": 3168, "max": 3256 },
      "embed_query":    { "n": 8, "avg": 669,  "p50": 634,  "p95": 956,  "max": 1036 },
      "embed_document": { "n": 1, "avg": 1266, "p50": 1266, "p95": 1266, "max": 1266 }
    }
  },
  "cache": {
    "threshold": 0.87, "enabled": true, "ttl_hours": 168,
    "lookups": 13, "hits": 3, "misses": 10,
    "exact_hits": 2, "semantic_hits": 1, "hit_rate": 0.2308,
    "saved_api_calls": { "generate": 2, "embed_query": 1, "embed_document": 6, "total": 9 },
    "estimated_tokens_saved": {
      "estimated": true,
      "basis": "mean tokens per successful generate call (n=2) x 2 generate calls avoided, plus mean tokens per embedded item x items served from embedding_cache",
      "prompt": 12391, "output": 81, "thinking": 565, "total": 13037
    }
  },
  "cost": {
    "tier": "free",
    "actual_cost_usd": 0.0,
    "actual_cost_inr": 0.0,
    "note": "This demo runs on the Gemini free tier, so the real bill is zero. ...",
    "rates": {
      "unit": "USD per 1,000,000 tokens",
      "chat_model": "gemini-flash-latest", "chat_input": 1.5, "chat_output": 7.5,
      "embed_model": "gemini-embedding-001", "embed_input": 0.15,
      "thinking_billed_as": "output",
      "usd_inr": 95.24,
      "source": "https://ai.google.dev/gemini-api/docs/pricing",
      "as_of": "2026-08-10"
    },
    "would_have_cost": { "usd": 0.011369, "inr": 1.0828 },
    "breakdown": {
      "generate_input":    { "usd": 0.006426, "inr": 0.612  },
      "generate_output":   { "usd": 0.000608, "inr": 0.0579 },
      "generate_thinking": { "usd": 0.004237, "inr": 0.4036 },
      "embed_input":       { "usd": 0.000098, "inr": 0.0093 }
    },
    "saved_by_cache": { "usd": 0.012487, "inr": 1.1893, "estimated": true }
  },
  "recent": [
    {
      "id": 25, "created_at": "2026-08-10T11:30:38.999728Z",
      "kind": "embed_query", "model": "gemini-embedding-001",
      "saved": false, "ok": true, "error": null,
      "latency_ms": 451, "n_items": 1, "tokens_estimated": true,
      "tokens": { "prompt": 9, "output": 0, "thinking": 0, "total": 9 }
    }
  ],
  "timeseries": {
    "bucket": "minute", "minutes": 60,
    "points": [
      { "t": "2026-08-10T11:27:00Z", "calls": 7, "saved": 3, "tokens": 4988, "thinking_tokens": 565 },
      { "t": "2026-08-10T11:28:00Z", "calls": 1, "saved": 6, "tokens": 522,  "thinking_tokens": 0 }
    ]
  }
}
```

Field notes the UI needs:
- `totals.by_kind[*].items` — texts embedded (a batch of 5 chunks is **one** call, five
  items); always `1` for `generate`. `items_saved` is the same count for avoided calls,
  which is why `embed_document.items_saved` (31) can exceed `calls_saved` (6).
- `totals.failed_calls` — real requests that returned an error. They still contribute
  latency (a 429 that burned 244 ms and produced nothing is in `latency_ms`), which is
  the point. The offending row is in `recent` with `ok: false` and the full `error` text.
- `cost.actual_cost_usd` is **always** `0` while `tier` is `"free"`. `would_have_cost` is
  a what-if at the list prices in `rates`; show them together or the number is magic.
  Every rate is an overridable setting in `backend/app/config.py` (`PRICE_*`,
  `USD_INR_RATE`, `PRICING_SOURCE`, `PRICING_AS_OF`, `GEMINI_TIER`).
- `cost.saved_by_cache` prices calls that never happened, so it is extrapolated from the
  mean of the calls that did — hence `estimated: true`. It can legitimately exceed
  `would_have_cost` when the cache has served more than it has missed.
- `recent` is the last 50 rows, newest first, saved and real interleaved.
- `timeseries` is always exactly 60 minute-buckets ending at the current minute; empty
  minutes are present as zeros so a sparkline has no holes in it.

## `GET /api/pipeline` — the live configuration, so the UI can stop hardcoding

Every value is read from the running `settings` object or from real SQL at request time.
The index method, the opclass and `embedding.stored_dim` come out of the Postgres
catalog rather than from config, so a config/schema disagreement shows up here instead
of hiding.

```json
{
  "models": { "chat": "gemini-flash-latest", "embed": "gemini-embedding-001",
              "thinking_level": "low", "temperature": 0.2 },
  "embedding": {
    "dim": 768, "stored_dim": 768, "normalized": true,
    "why_normalized": "gemini-embedding-001 only pre-normalizes its native 3072-dim output. ...",
    "task_types": { "documents": "RETRIEVAL_DOCUMENT", "queries": "RETRIEVAL_QUERY" },
    "why_task_types": "Documents and questions only land in the same space when each side is embedded with its matching task type."
  },
  "chunking": { "chunk_size": 1200, "chunk_overlap": 200, "overlap_ratio": 0.1667 },
  "retrieval": {
    "top_k": 5, "min_similarity": 0.25,
    "metric": "cosine", "distance_operator": "<=>",
    "similarity_formula": "1 - (chunk_embedding <=> query_embedding)",
    "index": { "name": "chunks_embedding_hnsw", "method": "hnsw",
               "opclass": "vector_cosine_ops",
               "definition": "CREATE INDEX chunks_embedding_hnsw ON public.chunks USING hnsw (embedding vector_cosine_ops)" }
  },
  "cache": {
    "enabled": true, "semantic_threshold": 0.87, "ttl_hours": 168,
    "layers": [
      { "name": "embedding_cache",       "keyed_on": "sha256(text) + task_type + dim",
        "avoids": "embed_document / embed_query", "rows": 86 },
      { "name": "query_cache (exact)",   "keyed_on": "normalised question + document scope",
        "avoids": "embed_query + generate", "rows": 3 },
      { "name": "query_cache (semantic)","keyed_on": "question embedding, cosine >= 0.87",
        "avoids": "generate", "rows": 3 }
    ]
  },
  "corpus": {
    "documents": 2, "ready_documents": 2, "chunks": 48,
    "total_chunk_chars": 53381, "avg_chunk_chars": 1112,
    "min_chunk_chars": 814, "max_chunk_chars": 1198,
    "vector_bytes": 147648,
    "embedding_cache_rows": 86, "embedding_cache_vector_bytes": 264536,
    "query_cache_rows": 3
  },
  "limits": { "max_upload_bytes": 20971520,
              "allowed_extensions": [".docx", ".md", ".pdf", ".txt"] }
}
```

- `models.thinking_level` is the literal string `"off"` when no `thinking_config` is sent
  at all; otherwise it is the configured level (`low` by default).
- `vector_bytes` / `embedding_cache_vector_bytes` are `sum(pg_column_size(embedding))`,
  i.e. what the vectors really occupy on disk, not `dim * 4` arithmetic.
- `retrieval.index.*` is `null` if no HNSW/IVFFlat index exists — treat it as optional.
