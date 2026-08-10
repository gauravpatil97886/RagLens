-- Schema for the RAG demo. Fully idempotent: the backend runs this on every startup.
-- Vector columns are vector(768) because we ask Gemini for output_dimensionality=768
-- (Matryoshka truncation) -- pgvector's HNSW index tops out at 2000 dimensions, and the
-- native 3072 of gemini-embedding-001 would not be indexable.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Corpus
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
    id          bigserial PRIMARY KEY,
    filename    text        NOT NULL,
    mime_type   text        NOT NULL,
    size_bytes  bigint      NOT NULL,
    n_chunks    integer     NOT NULL DEFAULT 0,
    n_chars     integer     NOT NULL DEFAULT 0,
    -- pending | processing | ready | failed
    status      text        NOT NULL DEFAULT 'pending',
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
    id           bigserial PRIMARY KEY,
    document_id  bigint      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index  integer     NOT NULL,
    content      text        NOT NULL,
    n_chars      integer     NOT NULL,
    embedding    vector(768) NOT NULL,
    UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);

-- Cosine distance (<=>) is what we search with, so the index must be built for
-- vector_cosine_ops or Postgres will ignore it.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Layer 0 cache: raw embedding vectors, keyed by content hash.
-- Re-uploading the same file, or re-asking the same question, then costs zero
-- embedding API calls. task_type and dim are part of the key because the SAME text
-- embedded as a document and as a query produces genuinely different vectors.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS embedding_cache (
    content_sha256 text        NOT NULL,
    task_type      text        NOT NULL,
    dim            integer     NOT NULL,
    embedding      vector(768) NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (content_sha256, task_type, dim)
);

-- ---------------------------------------------------------------------------
-- Layer 1+2 cache: whole answers, looked up exactly and then semantically.
-- scope_key pins an entry to the set of documents that were searched, so a cached
-- answer is never replayed for a different document selection.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS query_cache (
    id                 bigserial PRIMARY KEY,
    question           text        NOT NULL,
    question_norm      text        NOT NULL,
    scope_key          text        NOT NULL,
    question_embedding vector(768) NOT NULL,
    answer             text        NOT NULL,
    citations          jsonb       NOT NULL DEFAULT '[]'::jsonb,
    hits               integer     NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_hit_at        timestamptz,
    UNIQUE (question_norm, scope_key)
);

CREATE INDEX IF NOT EXISTS query_cache_scope_idx ON query_cache (scope_key);

CREATE INDEX IF NOT EXISTS query_cache_embedding_hnsw
    ON query_cache USING hnsw (question_embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Counters. Single row, enforced by a boolean primary key that can only be true.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cache_stats (
    id            boolean PRIMARY KEY DEFAULT true CHECK (id),
    exact_hits    bigint NOT NULL DEFAULT 0,
    semantic_hits bigint NOT NULL DEFAULT 0,
    misses        bigint NOT NULL DEFAULT 0
);

INSERT INTO cache_stats (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Telemetry: one row per Gemini request, and one row per request a cache avoided.
--
-- `saved = false` is a request that really went to Google (successful or not -- a 429
-- that burned 900ms and returned nothing is exactly the thing worth seeing). `saved =
-- true` is a request that did NOT happen because a cache answered first; those rows
-- carry latency_ms = 0 and no token counts, so any sum over `NOT saved` is real spend
-- and any count over `saved` is provable savings.
--
-- thinking_tokens is deliberately its own column and never folded into output_tokens:
-- on a thinking model it is routinely an order of magnitude larger than the answer, and
-- hiding it is how a bill becomes a surprise. It IS billed at the output rate.
--
-- tokens_estimated marks counts we derived rather than measured. Embedding responses
-- carry no usage_metadata at all, so embed rows are estimated at ~4 chars/token.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_calls (
    id               bigserial PRIMARY KEY,
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- embed_document | embed_query | generate
    kind             text        NOT NULL,
    model            text        NOT NULL,
    prompt_tokens    integer     NOT NULL DEFAULT 0,
    output_tokens    integer     NOT NULL DEFAULT 0,
    thinking_tokens  integer     NOT NULL DEFAULT 0,
    total_tokens     integer     NOT NULL DEFAULT 0,
    tokens_estimated boolean     NOT NULL DEFAULT false,
    latency_ms       integer     NOT NULL DEFAULT 0,
    -- texts embedded in this batch, or 1 for a generate call
    n_items          integer     NOT NULL DEFAULT 1,
    ok               boolean     NOT NULL DEFAULT true,
    error            text,
    saved            boolean     NOT NULL DEFAULT false
);

-- Both indexes serve /api/metrics: the recent-log tail and the per-minute timeseries
-- read by created_at, every aggregate groups by kind.
CREATE INDEX IF NOT EXISTS api_calls_created_at_idx ON api_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS api_calls_kind_idx ON api_calls (kind);
