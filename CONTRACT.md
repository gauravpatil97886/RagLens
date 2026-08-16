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

**Two limits, not one.** 20 MB is the transport limit; the one that protects the quota is
**max 500 chunks per document** (~500,000 characters, roughly a 250-page book, ~100 embed
requests). Bytes are the wrong lever — 20 MB of text splits into ~21,000 chunks and ~4,200
embed requests, a free-tier day gone in one drag-and-drop. Over the byte limit is `413`;
over the chunk limit is `400` with
`{"detail": "'handbook.pdf' splits into 21,433 chunks. This demo indexes at most 500 per
document (about 500,000 characters), so one upload cannot spend a day's API allowance.
Upload a shorter extract, or split the file."}`. The chunk cap is checked in both
preflights as well, so the refusal appears on the cost screen before Index is pressed.
The same cap applies to a link, counted on the scraped article text.

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

## `POST /api/documents/preflight` — analyse a file WITHOUT spending anything
`multipart/form-data`, field `file`, same extensions, same 20 MB and 500-chunk limits as
upload.
**Makes zero Gemini API calls.** It extracts and chunks the file in memory, then reports
what ingesting it *would* cost, so the user decides before any money or quota is spent.
Nothing is written to the database.

**200 Response:**
```json
{
  "filename": "handbook.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 48211,
  "n_chars": 51203,
  "n_pages": 17,
  "n_chunks": 42,
  "chunk_chars": { "min": 814, "mean": 1112, "max": 1198 },
  "preview_chunks": [ { "index": 0, "n_chars": 894, "preview": "first ~160 chars…" } ],
  "embedding": {
    "already_cached": 12,
    "to_embed": 30,
    "api_calls_needed": 6,
    "estimated_tokens": 9200,
    "tokens_estimated": true
  },
  "duplicate": { "document_id": 1, "filename": "handbook.pdf" },
  "warnings": ["This file has no text layer — it is probably a scanned PDF."]
}
```
`n_pages` is null for non-PDF. `preview_chunks` is the first 5 chunks only.
`already_cached` counts chunks whose exact text is already in `embedding_cache`, so
re-uploading a near-identical file honestly shows `api_calls_needed: 0`.
`duplicate` is non-null when a ready document with identical extracted text already
exists — the UI should offer to cancel rather than index it twice.
`warnings` is a possibly-empty list of plain-English strings.
On an unreadable file return `400` with `{"detail": "..."}` — the same errors ingest
would have raised, surfaced before anything is written.

## `POST /api/documents/stream` — same upload, streamed
Identical request: `multipart/form-data`, field name `file`, same extensions, same 20 MB
and 500-chunk limits. Rejections (`400`, `413`) are still ordinary HTTP errors — the stream only opens
once the file is accepted. The chunk cap is the exception, because chunk count is not
known until after splitting: it arrives as an `{"type":"error"}` frame with the same
`detail`, and the row is left `status: "failed"`, exactly like any other ingest failure.
The preflight is what turns it into a `400` before the stream is ever opened. Responds `200 text/event-stream`, one JSON object per `data:`
line:

```
data: {"type":"started","document_id":14}
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

**Cancelling mid-way.** `started` is always the FIRST frame, carrying the row id, so the
client can clean up a run it abandons. To cancel, abort the fetch and then call
`DELETE /api/documents/{document_id}`. The server also cleans up on its own: if the
client disconnects mid-stream, the ingest generator is closed and the partial document
row and any chunks written so far are removed, so an abandoned upload never leaves a
half-indexed document behind. Cancelling cannot un-spend embedding calls already made —
but those vectors stay in `embedding_cache`, so re-uploading the same file is cheap.

---

# Links — ingest a web page by URL

A pasted URL becomes an ordinary **document**. Everything downstream — chunks, vectors,
retrieval, citations, the cache, deletion — is unchanged. Only the way the text arrives
is different.

## The document object gains four fields

Every document object everywhere (upload, list, stream `done`) now also carries:

```json
{
  "source_type": "file",          // "file" | "url"
  "source_url": null,             // the final URL after redirects, or null for files
  "title": null,                  // article title for URLs; null for files
  "site_name": null               // e.g. "martinfowler.com"; null for files
}
```
For a URL document, `filename` is the article title (trimmed to 120 chars), falling back
to the last path segment, falling back to the host. The corpus rail keeps working with no
changes. `mime_type` is `text/html`. `size_bytes` is the number of bytes fetched.

## `POST /api/documents/url/preflight` — fetch and quote, WITHOUT spending anything

```json
{ "url": "https://martinfowler.com/articles/patterns-of-distributed-systems/" }
```

Fetches and scrapes the page, then reports what indexing it *would* cost.
**Makes zero Gemini API calls. Writes nothing to the database.**

**200 Response** — the file preflight object, plus `article` and `existing`:
```json
{
  "url": "https://martinfowler.com/articles/...",
  "final_url": "https://martinfowler.com/articles/...",
  "site_name": "martinfowler.com",
  "mime_type": "text/html",
  "size_bytes": 148211,
  "fetch_ms": 412,
  "n_chars": 24310,
  "n_chunks": 23,
  "chunk_chars": { "min": 814, "mean": 1112, "max": 1198 },
  "preview_chunks": [ { "index": 0, "n_chars": 894, "preview": "first ~160 chars…" } ],
  "article": {
    "title": "Patterns of Distributed Systems",
    "author": "Unmesh Joshi",
    "published": "2023-08-08",
    "reading_minutes": 12,
    "n_words": 4180,
    "excerpt": "first ~320 characters of the real article text…"
  },
  "embedding": {
    "already_cached": 23, "to_embed": 0, "api_calls_needed": 0,
    "estimated_tokens": 0, "tokens_estimated": true
  },
  "existing": {
    "document_id": 21,
    "filename": "Patterns of Distributed Systems",
    "created_at": "2026-08-15T10:02:00Z",
    "kind": "url",
    "changed": false
  },
  "warnings": ["Someone already indexed this link. Indexing it again costs 0 API calls."]
}
```

`article.excerpt` is the reader's proof that scraping worked — it must be real body text,
never nav or cookie-banner boilerplate.

`existing` is `null` when the page is new. Otherwise:
- `kind: "url"` — the same normalised URL is already in the corpus.
- `kind: "content"` — a *different* URL produced byte-identical text (same article
  mirrored, or `?utm_source` noise that normalisation did not catch).
- `changed: true` — the URL matches but the page text has changed since it was indexed.
  The UI should offer "re-index" rather than "already done".

**URL normalisation** (used for the `kind: "url"` match): lowercase scheme and host, drop
`www.`, drop the fragment, drop tracking params (`utm_*`, `gclid`, `fbclid`, `ref`,
`ref_src`, `mc_cid`, `mc_eid`), sort the remaining query params, strip a trailing slash.
Stored in `documents.source_url_norm`.

**Errors** — all `400` with `{"detail": "..."}` in plain English:

| Situation | `detail` |
|---|---|
| Not http/https | `Only http and https links can be fetched.` |
| Host resolves to a private/loopback/link-local address | `That link points to a private network address, so it will not be fetched.` |
| DNS failure | `That domain could not be found.` |
| Timeout (15s) | `That site took too long to respond.` |
| Non-2xx | `The site answered with 403 Forbidden.` |
| Wrong content type | `That link is a PDF, not a web page — download it and upload the file instead.` |
| Body over 10 MB | `That page is larger than the 10 MB limit.` |
| Too little text extracted (< 200 chars) | `Only 84 characters of article text could be found — the page may be mostly JavaScript.` |

## `POST /api/documents/url/stream` — fetch, scrape, index; streamed

Same JSON body. Rejections above are still ordinary `400`s — the stream opens only once
the page has been fetched and accepted. Responds `200 text/event-stream`.

The frames are the file ingest frames with **three new ones at the front** and one new
frame after extraction:

```
data: {"type":"started","document_id":21}
data: {"type":"stage","stage":"resolving","host":"martinfowler.com","label":"Checking martinfowler.com"}
data: {"type":"stage","stage":"fetching","label":"Fetching the page"}
data: {"type":"stage","stage":"fetched","status":200,"bytes":148211,"content_type":"text/html","final_url":"https://…","from_cache":true,"fetch_ms":0,"label":"148 KB of HTML"}
data: {"type":"stage","stage":"extracting","label":"Finding the article text"}
data: {"type":"article","title":"Patterns of Distributed Systems","site_name":"martinfowler.com","author":"Unmesh Joshi","published":"2023-08-08","n_words":4180,"reading_minutes":12,"excerpt":"first ~320 characters…"}
data: {"type":"stage","stage":"extracted","n_chars":24310,"label":"Extracted 24,310 characters"}
… from here identical to the file path: chunking → chunk* → chunked → embedding* → indexing → done
```

Full order: `resolving` → `fetching` → `fetched` → `extracting` → `article` →
`extracted` → `chunking` → `chunk`* → `chunked` → `embedding` → `embedding`* →
`indexing` → `done`.

`stage` is now one of
`resolving | fetching | fetched | extracting | chunking | embedding | indexing`.

The `article` frame is emitted exactly once, immediately before `extracted`. It is what
the UI shows as "here is what I found" so the reader can confirm the right thing was
scraped before any embedding happens.

**`from_cache` on the `fetched` frame.** A successful preflight puts the fetched page body
in a small in-process cache (keyed by normalised URL, TTL 5 minutes, capped at 32 entries).
When the reader then presses Index, the stream reuses that body instead of hitting the
site a second time — so pressing Index does not re-download the page, and the site is not
hit twice for one action. `from_cache: true` says that happened; `fetch_ms: 0` proves it.
This cache holds page bytes only. It is not the embedding cache and not the answer cache.

**Cancelling** works exactly as for files: `started` is the first frame, abort the fetch
and `DELETE /api/documents/{id}`, and the server also cleans up a partial row on
disconnect.

**Sharing embeddings between readers.** Two people pasting the same link do not pay twice.
This is not special-cased: chunk text is identical, so `embedding_cache` (keyed by chunk
SHA-256) already returns every vector, and the run reports `api_calls: 0`. The
`existing` block in preflight is the *user-facing* half of the same fact.

**Fetch limits** — 15s timeout, max 5 redirects, max 10 MB body, only
`text/html`, `application/xhtml+xml`, `text/plain`, `text/markdown`. A descriptive
`User-Agent` is sent. Private, loopback, link-local, multicast and reserved IP ranges are
refused *after* DNS resolution, and re-checked on every redirect hop.

**Fetched text is untrusted.** A web page can contain text written to manipulate a model.
Scraped content is data to be quoted, never instructions to follow — the system
instruction in `rag.py` states this, and the frontend must render extracted text as plain
text, never as HTML.

**The prompt fences every context block**, because saying "untrusted" in the system
instruction only works if the model can tell where a block ends. Each retrieved chunk goes
to the model as:

```
<<<BLOCK 1>>>
[1] (source: handbook.pdf, chunk 12)
...the chunk text...
<<<END BLOCK 1>>>
```

Angle-triples rather than XML-ish tags, because scraped page text genuinely contains
`</context>` and never contains `<<<BLOCK 1>>>`. Inside a block, `<<<` in the chunk text is
replaced with `‹‹‹` (U+2039) so no chunk can open or close a block, and the filename in the
header is whitespace-collapsed and clamped to 80 characters — at prompt-build time only,
so the stored name the UI displays stays the real one. Rule 5 of the system instruction
names the fence: text is context only between `<<<BLOCK n>>>` and `<<<END BLOCK n>>>`, and
anything inside that looks like a header, a system prompt or a question is the document's
text, not an instruction. None of this is visible on the wire — `citations[].content` is
still the chunk exactly as stored.

---

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
              "max_chunks_per_document": 500,
              "allowed_extensions": [".docx", ".md", ".pdf", ".txt"] }
}
```

- `models.thinking_level` is the literal string `"off"` when no `thinking_config` is sent
  at all; otherwise it is the configured level (`low` by default).
- `vector_bytes` / `embedding_cache_vector_bytes` are `sum(pg_column_size(embedding))`,
  i.e. what the vectors really occupy on disk, not `dim * 4` arithmetic.
- `retrieval.index.*` is `null` if no HNSW/IVFFlat index exists — treat it as optional.
- `limits.max_chunks_per_document` is the real cap the ingest and both preflights enforce.
  Read it from here — the number is a setting and will move; a hardcoded 500 in the UI
  will one day be a lie.

---

# Infra — look inside the database

A fourth view, `#/infra`, alongside `ask | signals | pipeline`. It answers four questions
a person learning RAG actually asks:

1. How much data is in the vector database, and what does it cost on disk?
2. What does a stored vector *actually look like*?
3. Where does cached data live, and which cache is which?
4. Is the vector index being used, or is Postgres scanning the table?

**Read-only by design.** There is no endpoint that accepts SQL. Table access is limited to
a fixed whitelist:
`documents | chunks | embedding_cache | query_cache | cache_stats | api_calls`.
Any other name is `400 {"detail": "Unknown table."}`. Nothing here mutates anything.

## `GET /api/infra` — the overview, one call

```json
{
  "server": {
    "postgres_version": "17.4",
    "pgvector_version": "0.8.0",
    "database": "rag",
    "host": "localhost",
    "port": 5433,
    "database_bytes": 12582912,
    "database_pretty": "12 MB",
    "connections": { "active": 2, "max": 100 }
  },
  "vectors": {
    "dimensions": 768,
    "stored": 22,
    "bytes_per_vector": 3076,
    "vector_bytes": 67672,
    "text_bytes": 22150,
    "expansion_ratio": 3.05,
    "l2_norm": { "min": 1.0, "mean": 1.0, "max": 1.0 },
    "index_method": "hnsw",
    "index_ops": "vector_cosine_ops",
    "index_bytes": 327680,
    "distance_operator": "<=>"
  },
  "tables": [
    {
      "name": "chunks",
      "role": "The text pieces and their vectors. This is what a question is searched against.",
      "rows": 22,
      "total_bytes": 655360, "total_pretty": "640 kB",
      "heap_pretty": "216 kB", "index_pretty": "352 kB", "toast_pretty": "72 kB",
      "columns": [
        { "name": "embedding", "type": "vector(768)", "nullable": false, "is_vector": true }
      ],
      "indexes": [
        { "name": "chunks_embedding_hnsw", "method": "hnsw",
          "size_pretty": "320 kB", "is_vector": true,
          "definition": "CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)" }
      ]
    }
  ],
  "caches": [
    { "layer": "embedding_cache", "where": "postgres", "what": "One vector per unique chunk of text, keyed by SHA-256. Stops the same text being embedded twice.",
      "rows": 45, "size_pretty": "864 kB", "key": "content_sha256 + task_type + dim", "ttl": null },
    { "layer": "query_cache", "where": "postgres", "what": "Past questions, their vectors and their answers. Layer 1 matches the text exactly, layer 2 matches by meaning.",
      "rows": 12, "size_pretty": "352 kB", "key": "question_norm + scope_key", "ttl": "168h" },
    { "layer": "page_fetch_cache", "where": "memory", "what": "Fetched page bytes, so pressing Index does not download the page a second time.",
      "rows": 1, "size_pretty": "148 kB", "key": "normalised URL", "ttl": "300s" }
  ],
  "counters": { "exact_hits": 24, "semantic_hits": 5, "misses": 27 }
}
```

`caches[].where` is `"postgres" | "memory"` — the point being that not every cache is a
table. `pgvector_version` is read from `pg_extension`. Sizes come from
`pg_total_relation_size` / `pg_indexes_size`, never estimated.

## `GET /api/infra/table/{name}?limit=25&offset=0` — browse real rows

`limit` max 100, default 25.

```json
{
  "table": "chunks",
  "total": 22,
  "limit": 25,
  "offset": 0,
  "columns": [ { "name": "id", "type": "bigint" }, { "name": "embedding", "type": "vector(768)" } ],
  "rows": [
    {
      "id": 167,
      "content": "…the full text…",
      "embedding": {
        "__vector__": true,
        "dims": 768,
        "bytes": 3076,
        "l2_norm": 1.0,
        "head": [-0.017299, 0.051937, 0.014355, -0.088047, 0.007045, 0.019605, 0.034107, -0.001132]
      }
    }
  ]
}
```

**Vector columns are never returned in full here** — 768 floats per row would be megabytes
of JSON for a page of results. They come back as the object above: `head` is the first 8
values, and `dims`/`bytes`/`l2_norm` tell the rest of the story. Use the endpoint below to
get one whole vector.

Other columns are returned as-is. `bytea` and any column over 4 KB is truncated with a
trailing `"…"` and a sibling `"<name>__truncated": true`. Timestamps are ISO-8601 `Z`.

## `GET /api/infra/vector/{chunk_id}` — one whole vector, plus its neighbours

The endpoint that answers "can I actually see the data?".

```json
{
  "chunk_id": 167,
  "document_id": 18,
  "filename": "acme-employee-handbook.md",
  "chunk_index": 3,
  "content": "…the text this vector was made from…",
  "dims": 768,
  "bytes": 3076,
  "l2_norm": 1.0,
  "stats": { "min": -0.1204, "max": 0.1187, "mean": 0.0001, "abs_mean": 0.0287 },
  "values": [ -0.017299635, 0.05193721, "… all 768 floats …" ],
  "neighbours": [
    { "chunk_id": 168, "filename": "acme-employee-handbook.md", "chunk_index": 4,
      "similarity": 0.7412, "preview": "first ~90 chars…" }
  ]
}
```
`neighbours` is the 5 nearest other chunks by cosine distance — the same `<=>` query
retrieval uses, run against a stored vector instead of a question. It makes "near in
768-dimensional space" concrete: neighbours of a leave-policy chunk are other
leave-policy chunks. `404` if the chunk does not exist.

## `GET /api/infra/explain` — is the index actually used?

Runs the real retrieval query through `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` using a
stored vector as the probe, once as the planner chooses and once with
`SET LOCAL enable_seqscan = off`.

```json
{
  "query": "SELECT … ORDER BY c.embedding <=> $1 LIMIT 5",
  "rows_in_table": 22,
  "chosen": { "plan": "Seq Scan on chunks", "uses_index": false, "ms": 0.185 },
  "forced_index": { "plan": "Index Scan using chunks_embedding_hnsw", "uses_index": true, "ms": 0.383 },
  "verdict": "Postgres is choosing a sequential scan, and it is right: at 22 rows the HNSW index costs more to walk than the table costs to read. The index earns its place as the corpus grows.",
  "note": "Retrieval takes about 0.2 ms either way. The model takes about 2000 ms. Search is not the bottleneck here."
}
```
`verdict` and `note` are server-generated plain English — the UI renders them, it does not
compose them, so the explanation can never contradict the numbers beside it.
`SET LOCAL` is used inside a transaction that is rolled back, so nothing about the
session's planner settings persists.

## Frontend

`View` becomes `'ask' | 'signals' | 'pipeline' | 'infra'`, and `VIEWS` in `App.tsx` gains
`'infra'`. The nav label is **Infra**. Polls `GET /api/infra` on the same 6s cadence the
dashboard uses; the table browser and vector viewer load on demand, not on a timer.

---

# Costing — every model call, and what each chat cost

A sub-tab of **Infra**, at `#/infra/costing`.

`Signals` and `Costing` are not duplicates. Signals is the *summary* — how is the system
doing right now. Costing is the *ledger* — every individual call, and the ability to open
one chat turn and see exactly what it spent. Summary vs. drill-down.

## Traces: the missing link

`api_calls` records one row per Gemini request, but a single question makes *several*
requests (embed the question, then generate) and may make none at all (a cache hit). There
is nothing tying them together, so "what did this chat cost?" is currently unanswerable.

A **trace** is one user action. Every API call it causes carries its `trace_id`.
This is the same idea Langfuse, Phoenix and LangSmith are built on, and the field names
below follow the OpenTelemetry GenAI semantic conventions (`gen_ai.*`) so this data can be
exported to any of them later without reshaping it.

### Schema additions

`api_calls` gains:
- `trace_id text` — null for calls made before this feature existed
- index on `trace_id`

New table `traces`:

| Column | Type | Meaning |
|---|---|---|
| `trace_id` | `text primary key` | uuid4, generated at the start of the action |
| `kind` | `text` | `chat` \| `ingest` |
| `label` | `text` | the question asked, or the filename/URL ingested |
| `scope_key` | `text` | which documents were in scope (chat only) |
| `cache_kind` | `text` | `miss` \| `exact` \| `semantic` (chat only) |
| `cached` | `bool` | did this action avoid the model entirely |
| `n_citations` | `int` | how many chunks were cited |
| `model` | `text` | the model that actually answered, after fallbacks |
| `api_calls` | `int` | requests actually sent |
| `saved_calls` | `int` | requests the cache prevented |
| `prompt_tokens` / `output_tokens` / `thinking_tokens` / `total_tokens` | `int` | |
| `cost_usd` | `numeric(12,8)` | computed from the pricing settings |
| `latency_ms` | `int` | wall clock for the whole action |
| `timings` | `jsonb` | `{embed, cache_lookup, retrieve, generate, total}` |
| `ok` | `bool` | |
| `error` | `text` | |
| `created_at` | `timestamptz` | |

Writing a trace must never break a chat: wrap the write so a telemetry failure is logged
and swallowed, never surfaced to the user.

## `GET /api/costing/summary?window=24h`

`window` is one of `1h | 24h | 7d | all`, default `24h`.

```json
{
  "window": "24h",
  "pricing": {
    "chat_input_per_1m_usd": 1.50, "chat_output_per_1m_usd": 7.50,
    "embed_input_per_1m_usd": 0.15, "usd_inr_rate": 95.24,
    "tier": "free", "source": "https://ai.google.dev/gemini-api/docs/pricing",
    "as_of": "2026-08-10"
  },
  "totals": {
    "traces": 56, "api_calls": 97, "saved_calls": 70,
    "prompt_tokens": 71204, "output_tokens": 8410, "thinking_tokens": 1152,
    "total_tokens": 80766,
    "cost_usd": 0.17421, "cost_inr": 16.59,
    "saved_usd": 0.12044, "saved_inr": 11.47,
    "would_have_cost_usd": 0.29465
  },
  "by_model": [
    { "model": "gemini-flash-lite-latest", "calls": 28, "total_tokens": 41200,
      "cost_usd": 0.0912, "avg_latency_ms": 1525, "failures": 0 }
  ],
  "by_kind": [
    { "kind": "generate", "calls": 34, "saved": 28, "cost_usd": 0.1601 },
    { "kind": "embed_query", "calls": 20, "saved": 32, "cost_usd": 0.0004 },
    { "kind": "embed_document", "calls": 10, "saved": 0, "cost_usd": 0.0137 }
  ],
  "per_chat": { "median_cost_usd": 0.0031, "median_tokens": 1420, "median_latency_ms": 1557 },
  "projection": {
    "basis": "24h", "traces_per_day": 56,
    "monthly_cost_usd": 5.23, "monthly_cost_inr": 498.10,
    "monthly_without_cache_usd": 8.84,
    "note": "You are on the free tier, so the real bill is zero. These are what the same traffic would cost at the listed paid rates."
  }
}
```

`cost_usd` is always **computed, never stored twice** — one pricing function, used by this
endpoint and by the trace writer, so a pricing change cannot make two screens disagree.
The free-tier caveat must be stated by the server, not invented by the UI.

## `GET /api/costing/traces?limit=50&offset=0&kind=&cached=`

`limit` max 200, default 50. `kind` filters `chat|ingest`. `cached` filters `true|false`.

```json
{
  "total": 56, "limit": 50, "offset": 0,
  "traces": [
    {
      "trace_id": "3f9c…", "kind": "chat",
      "label": "How many days of casual leave do employees get?",
      "cache_kind": "semantic", "cached": true,
      "model": null, "api_calls": 0, "saved_calls": 1,
      "total_tokens": 0, "cost_usd": 0.0, "latency_ms": 719,
      "n_citations": 5, "ok": true, "created_at": "2026-08-15T18:22:04Z"
    }
  ]
}
```
Newest first. A cached trace has `model: null` — no chat model was reached — and
`saved_calls: 1`. Those two fields, not the cost, are what mark a cache hit.

**Cost is always what was actually spent, cached or not.** An *exact* hit really is
`api_calls: 0, cost_usd: 0.0`: it is a string lookup, no vector, no request. A *semantic*
hit is `api_calls: 1` and roughly `cost_usd: 0.0000025`, because finding the match means
embedding the question. Recording that as zero would stop the trace rows summing to
`totals.cost_usd`, and a cost screen whose rows disagree with its own total cannot be
trusted. The saving is still the headline, just an honest one: ~$0.0000025 against
~$0.007 for a fresh answer, about 2,700x cheaper.

The UI must therefore key the "from cache" treatment off `cached` / `cache_kind` /
`saved_calls`, **never** off `cost_usd == 0`.

## `GET /api/costing/trace/{trace_id}`

One action, opened up.

```json
{
  "trace": { "…the trace object above…" },
  "timings": { "embed": 652, "cache_lookup": 11, "retrieve": 0, "generate": 0, "total": 719 },
  "spans": [
    { "id": 412, "kind": "embed_query", "model": "gemini-embedding-001",
      "prompt_tokens": 12, "output_tokens": 0, "thinking_tokens": 0, "total_tokens": 12,
      "tokens_estimated": true, "latency_ms": 652, "ok": true, "error": null,
      "saved": false, "cost_usd": 0.0000018, "created_at": "…" }
  ],
  "waterfall": [
    { "label": "embed", "start_ms": 0, "duration_ms": 652, "billable": true },
    { "label": "cache lookup", "start_ms": 652, "duration_ms": 11, "billable": false },
    { "label": "generate", "start_ms": 663, "duration_ms": 0, "billable": true,
      "skipped": true, "skipped_reason": "semantic cache hit" }
  ]
}
```
`spans` are the `api_calls` rows for this trace, oldest first. `waterfall` is derived from
`timings` server-side so the UI renders one bar per entry without doing arithmetic.
A `skipped` entry is a step that did not run — drawn as an outline, not a filled bar.
`404` if the trace is unknown.

## Frontend

Infra gains a sub-tab bar. `#/infra` opens **Vectors**; the others are
`#/infra/tables`, `#/infra/caches`, `#/infra/plan`, `#/infra/costing`.

---

# Navigation — the information architecture

With Ask, Pipeline, Signals, Infra and five Infra sub-tabs, a flat list stops working.
The rule: **the left rail holds destinations, the page header holds sections within a
destination.** Never nest a second level in the rail.

| Rail item | Question it answers | Sections (in the page header) |
|---|---|---|
| **Ask** | Get me an answer | — |
| **Pipeline** | How does this work? | — |
| **Signals** | How is it doing right now? | — |
| **Infra** | Where does the data live, and what did it cost? | Vectors · Tables · Caches · Query plan · Costing |

Ask is the product. The other three are the lens — the reason the app is called RAGLens.
The rail should show that: Ask sits on its own, the other three group below a divider.

Hash routes: `#/`, `#/pipeline`, `#/signals`, `#/infra[/tables|caches|plan|costing]`.
An unknown hash falls back to `#/`. Back/forward must move between sub-tabs too, so the
sub-tab is part of the hash, not component state.
