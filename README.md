<div align="center">

# RAGLens

### A RAG pipeline you can see through.

Upload a document, ask a question, get an answer with citations —
and watch every step that produced it, including the steps that were skipped to save money.

`FastAPI` · `PostgreSQL + pgvector` · `Gemini` · `React + Vite` · `TypeScript`

</div>

![RAGLens home screen](docs/screenshots/00-hero.png)

---

## Why this exists

Most RAG demos show you a chat box and an answer. You learn nothing about what happened in between.

RAGLens shows the whole thing:

- **Where the answer came from** — every sentence links to the exact chunk of text it was written from.
- **What it cost** — how many model calls were made, how many tokens, how many milliseconds.
- **What it did *not* cost** — a two-layer cache answers many questions without calling the model at all, and the app counts those saved calls.
- **What happens before you spend anything** — upload a file and it tells you the exact number of API calls indexing will take, *before* making a single one.

It is a small codebase on purpose. You should be able to read it end to end in an afternoon.

---

## Screenshots

<table>
<tr>
<td width="50%">

**Ask a question**

Answer first, with numbered citation chips. Sources collapse into one line so the answer stays readable.

</td>
<td width="50%">

**Same question, from cache**

The second time a similar question is asked, the answer is replayed from Postgres. No model call. 92% similarity match.

</td>
</tr>
<tr>
<td><img src="docs/screenshots/01-chat-answer.png" alt="Answer with citations"></td>
<td><img src="docs/screenshots/02-cache-hit.png" alt="Semantic cache hit at 92%"></td>
</tr>
<tr>
<td>

**Signals — the cost dashboard**

Calls made vs calls prevented, cache hit rate, latency percentiles, token usage, failures. Read from a ledger the backend writes on every request.

</td>
<td>

**Pipeline — how it works**

Twelve steps across two pipelines. Every number on the page is read live from the running config and the database, not hardcoded.

</td>
</tr>
<tr>
<td><img src="docs/screenshots/03-dashboard.png" alt="Observability dashboard"></td>
<td><img src="docs/screenshots/04-pipeline.png" alt="Pipeline explainer"></td>
</tr>
<tr>
<td>

**Upload — the quote, before you pay**

Preflight extracts and chunks the file in memory and reports the cost. Zero API calls so far. You can still cancel.

</td>
<td>

**Upload — after indexing**

The quote is checked against what actually happened. Each column is one chunk against the size ceiling.

</td>
</tr>
<tr>
<td><img src="docs/screenshots/05-upload-preflight.png" alt="Upload preflight showing zero API calls spent"></td>
<td><img src="docs/screenshots/06-upload-indexed.png" alt="Upload finished, predicted cost matched actual"></td>
</tr>
</table>

**Chunk inspector** — open any document and read the chunks exactly as they were stored. The overlap is visible: chunk `01` begins mid-word, carrying the tail of chunk `00` forward so a sentence cut in half is still findable.

![Chunk inspector](docs/screenshots/07-chunks.png)

---

## Quick start

You need **Docker**, **Python 3.12+** with [`uv`](https://docs.astral.sh/uv/), and **Node 18.17+**.

```bash
git clone https://github.com/gauravpatil97886/RagLens.git
cd RagLens

cp .env.example .env
# open .env and paste a free Gemini API key from https://aistudio.google.com/apikey

make install     # backend deps (uv) + frontend deps (npm)
make up          # starts Postgres + pgvector in Docker, waits until healthy
```

Then two terminals:

```bash
make backend     # http://localhost:8000
make frontend    # http://localhost:5173
```

Open <http://localhost:5173>, click **Add document**, and drop in `samples/acme-employee-handbook.md`.
`samples/QUESTIONS.md` has questions to try, including pairs designed to test the cache.

<details>
<summary>All make targets</summary>

| Target | What it does |
|---|---|
| `make up` | Start Postgres in Docker, wait until healthy |
| `make down` | Stop containers, **keep** the data |
| `make install` | `uv sync` for the backend, `npm install` for the frontend |
| `make backend` | Run the API on `:8000` with auto-reload |
| `make frontend` | Run Vite on `:5173` (proxies `/api` to `:8000`) |
| `make psql` | Open a `psql` shell inside the container |
| `make health` | Curl the health endpoint |
| `make logs` | Tail the Postgres logs |
| `make reset-db` | Drop and rebuild the schema (destroys data, keeps the container) |
| `make nuke` | Delete the Docker volume too — asks you to type `yes` |

</details>

---

## How it works

There are two pipelines. One runs when you upload a file. The other runs when you ask a question.

```
INGEST  (once per file)                QUERY  (once per question)
─────────────────────────              ──────────────────────────────
 1  receive the file                    1  question + which documents
 2  extract text                        2  exact cache check      ── hit? stop here
 3  split into chunks                   3  embed the question
 4  embed each chunk                    4  semantic cache check   ── hit? stop here
 5  store vectors in Postgres           5  vector search in Postgres
 6  build the HNSW index                6  build a grounded prompt
                                        7  stream the answer from Gemini
                                        8  store the answer for next time
```

Steps 2 and 4 on the right are the money savers. Both can end the run before Gemini is ever contacted.

### The answer is streamed, not delivered in one lump

`POST /api/chat/stream` is a Server-Sent Events endpoint. It emits, in order:

| Event | Carries |
|---|---|
| `cache` | Was this a hit? Which kind? What similarity? |
| `retrieval` | The citation cards, before any text is generated |
| `token` | Text, as the model produces it |
| `done` | Final timings and cache verdict |

Cache hits are replayed token-by-token too, so a cached answer looks the same as a fresh one — only much faster and free.

Uploads stream as well (`POST /api/documents/stream`). Every stage you see in the upload card is a real server event, not a fake progress bar.

---

## The database

**PostgreSQL 17 with the [pgvector](https://github.com/pgvector/pgvector) extension** — image `pgvector/pgvector:pg17`, on host port **5433** so it does not collide with a Postgres you may already run on 5432.

Postgres does everything here: it is the document store, the vector index, the cache, and the metrics ledger. No separate vector database, no Redis, no queue. For a corpus this size that is not a compromise — it is the correct answer, and it keeps the whole system inspectable with one `psql` shell.

### Six tables

| Table | What it holds |
|---|---|
| `documents` | One row per uploaded file: name, size, status, chunk count, SHA-256 of the extracted text |
| `chunks` | The text pieces **and their vectors** — this is what gets searched |
| `embedding_cache` | Vectors keyed by content hash, so the same text is never embedded twice |
| `query_cache` | Past questions, their vectors, and their answers — the semantic cache |
| `cache_stats` | Running counters: exact hits, semantic hits, misses |
| `api_calls` | One row per Gemini request, including requests that were **prevented** |

### What a stored embedding actually looks like

```sql
\d chunks
```

```
 embedding | vector(768) | not null
```

```sql
SELECT pg_column_size(embedding), length(content) FROM chunks LIMIT 1;
```

```
 pg_column_size | length
----------------+--------
           3076 |    894
```

So a 894-character chunk becomes 3076 bytes of vector — **the vector is about 3.4× larger than the text it represents**. That is normal, and it is the price of semantic search.

```sql
SELECT left(embedding::text, 90) FROM chunks LIMIT 1;
```

```
[-0.017299635,0.05193721,0.014355395,-0.08804728,0.0070452904,0.019605016,0.03410683,...]
```

768 float32 numbers. Each one is a coordinate. Two chunks that mean similar things end up near each other in this 768-dimensional space, and "near" is something Postgres can compute.

```sql
WITH one AS (SELECT embedding FROM chunks LIMIT 1)
SELECT round(sqrt(sum(v*v))::numeric, 6) AS l2_norm, count(*) AS dims
FROM one, unnest(one.embedding::real[]) AS v;
```

```
 l2_norm  | dims
----------+------
 1.000000 |  768
```

The length is exactly 1. That matters — see the optimizations below.

### The search itself

```sql
SELECT c.id, c.content, 1 - (c.embedding <=> %(q)s) AS similarity
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE d.status = 'ready'
ORDER BY c.embedding <=> %(q)s     -- <=> is cosine distance
LIMIT 5;
```

`<=>` is pgvector's cosine-distance operator. `1 - distance` gives similarity between 0 and 1. Anything below `MIN_SIMILARITY` (0.25) is thrown away before citation numbers are handed out, so `[1]`, `[2]`, `[3]` never have gaps.

Two HNSW indexes exist, both `vector_cosine_ops`:

```
chunks_embedding_hnsw        -- searching your documents
query_cache_embedding_hnsw   -- searching past questions
```

---

## Chunking and embedding

A whole document is the wrong unit to embed. One vector cannot represent forty pages. So the text is cut into pieces small enough to be about one thing.

**The splitter is recursive, not blind.** It tries separators from widest to narrowest:

```
"\n\n"  →  "\n"  →  ". "  →  "? "  →  "! "  →  "; "  →  ", "  →  " "  →  hard cut
```

It only reaches a hard character cut if nothing else works. Paragraphs stay whole where possible.

**Chunks overlap by 200 characters.** Without overlap, a sentence that straddles a boundary is lost to both chunks. With overlap, the last 200 characters of chunk N are repeated at the start of chunk N+1. You can see this in the chunk inspector screenshot above — chunk `01` starts with `bationary employee`, the tail of `probationary employee` from chunk `00`.

Defaults: `CHUNK_SIZE=1200`, `CHUNK_OVERLAP=200` — a 16.7% overlap ratio.

**The embedding model is `gemini-embedding-001` truncated to 768 dimensions.** It emits 3072 by default. Two reasons to cut it down:

1. pgvector's HNSW index supports at most **2000 dimensions**. 3072 would mean no index at all.
2. This model is trained with [Matryoshka representation learning](https://arxiv.org/abs/2205.13147), so the first 768 numbers are a usable embedding on their own. You lose a little accuracy and save 4× the storage.

**Important catch:** Google normalizes the full 3072-dim output, but **a truncated vector is no longer normalized**. Cosine similarity assumes unit length. So the app L2-normalizes every truncated vector itself before storing it:

```python
def l2_normalize(values) -> list[float]:
    """Scale a vector to unit length. Both the document path and the query
    path go through this one helper."""
    arr = np.asarray(values, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    if norm == 0.0:
        return arr.tolist()
    return (arr / norm).tolist()
```

That is why the `l2_norm` query above returns exactly `1.000000`. Skip this step and your similarity scores are quietly wrong.

**Ingest and query use different task types.** Chunks are embedded as `RETRIEVAL_DOCUMENT`, questions as `RETRIEVAL_QUERY`. Same model, same dimension, different instruction — a question and a passage are not the same kind of text, and the model is told so.

---

## The two-layer cache

This is the feature that turns a free API tier into something you can actually develop against.

### Layer 1 — exact cache (free, instant)

The question is normalized: lowercase, punctuation stripped, whitespace collapsed. Then it is a plain string lookup on `query_cache`.

```
"What is the leave policy?"  →  "what is the leave policy"
"WHAT IS THE LEAVE POLICY"   →  "what is the leave policy"   ← same row
```

This runs **before anything is embedded**. A hit costs zero API calls and zero milliseconds of network time.

### Layer 2 — semantic cache (also free)

The clever part: the question has to be embedded anyway, for retrieval. So that vector gets reused to search past questions first:

```sql
SELECT question, answer, 1 - (question_embedding <=> %(q)s) AS similarity
FROM query_cache
ORDER BY question_embedding <=> %(q)s
LIMIT 1;
```

If similarity ≥ threshold, the stored answer is replayed and **the generation call never happens**. The extra lookup costs one indexed vector search — under a millisecond — and no API call.

### Choosing the threshold — with measurements, not vibes

The first attempt used 0.95. It never fired once. So `backend/calibrate_cache.py` was written to measure it properly: score real paraphrase pairs (should hit) against real look-alike pairs (must *not* hit).

Measured on `gemini-embedding-001` at 768 dims:

| Question A | Question B | Score | Should it hit? |
|---|---|---:|---|
| "How fast are expenses reimbursed?" | "turnaround time for expense reimbursement?" | **0.9394** | Yes |
| "expense limit for travel?" | "expense limit for meals?" | **0.8605** | **No** — different answers |
| "Can I work from home?" | "What is the remote work policy?" | **0.7292** | Yes |

Look at those numbers. **The two populations overlap.** A true paraphrase scored 0.7292 while a genuinely different question scored 0.8605. No single threshold is both safe and complete.

So the default is **0.87** — just above the highest known false pair. The trade is deliberate:

> A cache **miss** costs one API call. A cache **false hit** costs correctness.
> We accept missing some real paraphrases so that we never serve the answer to a different question.

Run it yourself against your own corpus:

```bash
cd backend && uv run python calibrate_cache.py
```

### The scope key stops a subtle bug

Cache keys include *which documents were ticked*. An answer retrieved from three documents is not a valid answer for a different three. Uploading a new document also invalidates every `scope_key='ALL'` entry, because "search everything" now means something different.

### It works

From the dashboard screenshot above, on a real session:

```
167 model calls wanted
 97 actually made
 70 prevented by the cache        ← 42% never left the machine
52% cache hit rate (24 exact + 5 semantic on the chat path)
```

---

## Optimizations

Every item here exists because something was measured first.

| # | Optimization | Why | Measured effect |
|---|---|---|---|
| 1 | **Two-layer cache** (exact + semantic) | Free-tier quotas are tiny; repeated questions are common | 42% of wanted calls prevented |
| 2 | **Reuse the retrieval embedding for the semantic lookup** | The vector already exists — searching past questions with it is free | Semantic cache costs 0 extra API calls |
| 3 | **Exact cache runs before embedding** | A string match needs no vector at all | Exact hit = 0 API calls, 0 network |
| 4 | **`embedding_cache` keyed by content SHA-256** | Re-uploading the same file, or overlapping chunks, should not be re-embedded | Preflight regularly reports `already_cached: 11, to_embed: 0` |
| 5 | **Matryoshka truncation 3072 → 768 dims** | HNSW caps at 2000 dims; 768 is 4× smaller | Makes the vector index possible at all |
| 6 | **Explicit L2 normalization after truncation** | Truncated Gemini vectors are *not* unit length | `l2_norm = 1.000000`; without it, cosine scores are wrong |
| 7 | **HNSW index with `vector_cosine_ops`** | Approximate nearest neighbour instead of a full scan | 320 kB index; ready before the corpus outgrows a seq scan |
| 8 | **Model fallback chain** | Gemini's free quota is **per model per day**, not per account | One dead model no longer kills the app |
| 9 | **Detect daily-quota 429s and skip the retry backoff** | Google says "retry in 11.4s" even for a *daily* cap, which is a lie worth ignoring | Failover **9076ms → 1056ms** |
| 10 | **`gemini-flash-lite-latest` as the default model** | RAG puts the reasoning in the retrieved context; the model is summarising, not deriving | **632ms / 0 thinking tokens** vs 4241ms / 571 for full Flash |
| 11 | **Zero-cost upload preflight** | You should know the bill before you agree to it | Preflight makes 0 API calls; predicted 1, actual 1 |
| 12 | **Token batching onto animation frames** | Tokens arrive every few ms; React should not commit 160×/second | ~60 commits/sec instead of ~160 |
| 13 | **SSE for both chat and ingest** | Perceived latency beats real latency | First token visible in ~600ms |
| 14 | **Connection pooling with `psycopg_pool`** | `register_vector` runs once per connection, not per query | No per-request setup cost |
| 15 | **`MIN_SIMILARITY` floor before citing** | Weak matches produce confident nonsense | Junk chunks dropped; citation numbers never have gaps |

### On the fallback chain

Gemini's free tier caps generation **per model, per day**. Seven models were tested on the same key with the same 5-word question:

| Model | Latency | Thinking tokens |
|---|---:|---:|
| `gemini-flash-lite-latest` | **632 ms** | 0 |
| `gemini-3.1-flash-lite` | 1589 ms | 0 |
| `gemini-3.5-flash` | 2239 ms | 312 |
| `gemini-flash-latest` | 4241 ms | 571 |

Flash-lite leads because in RAG the hard thinking has already been done by the retriever. The model is being handed the right passages and asked to summarise them. Paying for a reasoning model to do that is paying for nothing.

The chain is configurable — put `gemini-flash-latest` first if you want maximum answer quality and can live with a smaller daily allowance.

---

## API reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | DB ping, key configured, corpus counts |
| `POST` | `/api/documents/preflight` | Chunk a file and quote the cost. **Makes no API calls.** |
| `POST` | `/api/documents/stream` | Upload + index, narrated as SSE. Disconnect = the partial document is cleaned up |
| `POST` | `/api/documents` | Same, non-streaming |
| `GET` | `/api/documents` | List the corpus |
| `DELETE` | `/api/documents/{id}` | Delete a document, its chunks, and the cache entries that referenced it |
| `GET` | `/api/chunks/{document_id}` | Read the chunks exactly as stored |
| `POST` | `/api/chat/stream` | Ask a question, streamed as SSE |
| `POST` | `/api/chat` | Ask a question, one response |
| `GET` | `/api/cache` | Inspect cached questions and their hit counts |
| `DELETE` | `/api/cache` | Clear the cache and reset the counters |
| `GET` | `/api/stats` | Corpus and cache summary |
| `GET` | `/api/metrics` | Full telemetry: calls, tokens, latency percentiles, cost, recent ledger |
| `GET` | `/api/pipeline` | Live config read back from the running app and the DB catalog |

Exact request and response shapes are frozen in [`CONTRACT.md`](./CONTRACT.md). The frontend types in `frontend/src/types.ts` mirror it one-to-one.

---

## Configuration

Everything lives in `.env` at the repo root. Copy `.env.example` and add your key.

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | — | Free key from [AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_CHAT_MODEL` | `gemini-flash-lite-latest` | First model tried |
| `GEMINI_CHAT_FALLBACKS` | *(list)* | Tried in order when the first is out of quota |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Embedding model |
| `EMBED_DIM` | `768` | Matryoshka truncation target |
| `DATABASE_URL` | `postgresql://rag:rag@localhost:5433/rag` | Postgres connection |
| `CHUNK_SIZE` | `1200` | Max characters per chunk |
| `CHUNK_OVERLAP` | `200` | Characters carried into the next chunk |
| `TOP_K` | `5` | Chunks retrieved per question |
| `MIN_SIMILARITY` | `0.25` | Below this, a chunk is not used or cited |
| `SEMANTIC_CACHE_ENABLED` | `true` | Turn layer 2 off to see the difference |
| `SEMANTIC_CACHE_THRESHOLD` | `0.87` | Calibrated, not guessed — see above |
| `CACHE_TTL_HOURS` | `168` | Cached answers expire after a week |

`.env` is gitignored. **Never commit your key.**

---

## Tech stack

**Backend** — Python 3.12

| Package | Version |
|---|---|
| fastapi | 0.141.1 |
| uvicorn | 0.52.1 |
| google-genai | 2.17.0 |
| psycopg (binary, pool) | 3.3.4 |
| pgvector | 0.5.0 |
| numpy | 2.5.2 |
| pydantic-settings | 2.15.0 |
| pypdf | 6.15.0 |
| python-docx | 1.2.0 |

> `google-genai` is the current SDK. The older `google-generativeai` package is deprecated.

**Frontend** — Node 18.17+

React 18.3 · TypeScript 5.5 · Vite 5.4 · Tailwind CSS 3.4 · framer-motion 11.3 · react-markdown 9 · lucide-react

**Database** — `pgvector/pgvector:pg17` in Docker. Only the database is containerised; backend and frontend run natively so you can read logs and edit code while it is running.

---

## Project layout

```
RagLens/
├── docker-compose.yml        Postgres + pgvector, host port 5433
├── Makefile                  every dev command
├── CONTRACT.md               frozen API contract
├── sql/schema.sql            idempotent DDL, applied on backend startup
├── samples/                  a handbook to upload, questions to try
├── backend/
│   ├── calibrate_cache.py    measures the semantic-cache threshold
│   └── app/
│       ├── main.py           FastAPI routes
│       ├── config.py         settings, loaded from .env
│       ├── db.py             connection pool + schema bootstrap
│       ├── extract.py        PDF / DOCX / MD / TXT → text
│       ├── chunking.py       recursive splitter with overlap
│       ├── gemini.py         all model calls, embedding cache, fallback chain, telemetry
│       ├── cache.py          the two-layer cache
│       ├── rag.py            the pipeline — read this one first
│       └── metrics.py        dashboard aggregation
└── frontend/src/
    ├── App.tsx               state and orchestration
    ├── api.ts                typed fetch wrappers
    ├── types.ts              mirrors CONTRACT.md
    └── components/           chat, corpus, upload, dashboard, pipeline
```

**Reading order:** `sql/schema.sql` → `backend/app/rag.py` → `backend/app/cache.py` → `backend/app/gemini.py`.

---

## Known limits

Stated plainly, because a README that claims no weaknesses is not telling the truth.

- **No OCR.** A scanned PDF with no text layer produces nothing. The document is marked `failed` rather than silently indexed empty.
- **Ingestion is synchronous.** A very large file holds a request open. Fine for a demo, wrong for production — that wants a queue.
- **No auth.** Anyone who can reach the port can read the corpus.
- **HNSW is not exercised at this size.** With a few dozen chunks the planner correctly prefers a sequential scan (0.185 ms vs 0.383 ms forced). The index is there for when the corpus grows; today, retrieval is ~0.2 ms and the model is ~2000 ms, so search is not the bottleneck.
- **Rupee cost estimates are approximate** — they use a fixed USD→INR rate from `.env`, and the free tier costs nothing anyway. The numbers are there to show shape, not to bill anyone.

---

## Credits

Built by **Gaurav** as a hands-on way to learn how retrieval-augmented generation actually works, end to end.

Documents in `samples/` are fictional.
