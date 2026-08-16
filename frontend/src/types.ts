/**
 * Mirrors CONTRACT.md exactly. That contract is frozen — if something here
 * disagrees with it, this file is the thing that's wrong.
 */

/* ── Health ─────────────────────────────────────────────────────────────── */

export interface Health {
  status: string;
  db: boolean;
  gemini: boolean;
  chunks: number;
  documents: number;
}

/* ── Documents ──────────────────────────────────────────────────────────── */

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** Where a document's text came from. A pasted link is an ordinary document. */
export type DocumentSource = 'file' | 'url';

export interface DocumentMeta {
  id: number;
  /** For a URL document this is the article title, trimmed to 120 chars. */
  filename: string;
  mime_type: string;
  size_bytes: number;
  n_chunks: number;
  n_chars: number;
  status: DocumentStatus;
  created_at: string;
  /** Present on the upload response only. */
  ingest_ms?: number;
  /** Present when status is 'failed'. */
  error?: string;
  source_type: DocumentSource;
  /** The final URL after redirects. Null for files. */
  source_url: string | null;
  /** Article title for URLs. Null for files. */
  title: string | null;
  /** e.g. "martinfowler.com". Null for files. */
  site_name: string | null;
}

export interface DocumentListResponse {
  documents: DocumentMeta[];
}

/* ── Preflight (POST /api/documents/preflight) ──────────────────────────── */
/** What ingesting a file *would* cost. Zero API calls, nothing written. */

export interface PreflightChunkChars {
  min: number;
  mean: number;
  max: number;
}

/** One of the first five chunks, as the splitter would produce it. */
export interface PreflightPreviewChunk {
  index: number;
  n_chars: number;
  /** First ~160 characters. */
  preview: string;
}

export interface PreflightEmbedding {
  /** Chunks whose exact text is already in embedding_cache — these are free. */
  already_cached: number;
  to_embed: number;
  api_calls_needed: number;
  estimated_tokens: number;
  /** Always true today: embedding responses carry no usage metadata. */
  tokens_estimated: boolean;
}

/** A ready document with identical extracted text already exists. */
export interface PreflightDuplicate {
  document_id: number;
  filename: string;
}

export interface Preflight {
  filename: string;
  mime_type: string;
  size_bytes: number;
  n_chars: number;
  /** Null for anything that isn't a PDF. */
  n_pages: number | null;
  n_chunks: number;
  chunk_chars: PreflightChunkChars;
  /** The first five chunks only. */
  preview_chunks: PreflightPreviewChunk[];
  embedding: PreflightEmbedding;
  duplicate: PreflightDuplicate | null;
  warnings: string[];
}

/* ── URL preflight (POST /api/documents/url/preflight) ──────────────────── */
/** Fetch and scrape a page, then quote it. Zero API calls, nothing written. */

/**
 * What the scraper found. `excerpt` is the reader's proof that scraping worked:
 * real body text, not nav or a cookie banner. It is third-party content and is
 * always rendered as plain text — never as HTML.
 */
export interface PreflightArticle {
  title: string;
  /** Null when the page names no author. */
  author: string | null;
  /** ISO date, or null when the page carries no publication date. */
  published: string | null;
  reading_minutes: number;
  n_words: number;
  /** The first ~320 characters of the real article text. */
  excerpt: string;
}

/**
 * `url` — the same normalised URL is already in the corpus.
 * `content` — a *different* URL produced byte-identical text.
 */
export type ExistingKind = 'url' | 'content';

/** The document this link (or this text) is already in the corpus as. */
export interface PreflightExisting {
  document_id: number;
  filename: string;
  created_at: string;
  kind: ExistingKind;
  /** The URL matches but the page text has changed — offer re-index, not "done". */
  changed: boolean;
}

export interface UrlPreflight {
  /** The URL as it was asked for. */
  url: string;
  /** Where the redirects ended up. */
  final_url: string;
  site_name: string;
  mime_type: string;
  /** Bytes fetched. */
  size_bytes: number;
  fetch_ms: number;
  n_chars: number;
  n_chunks: number;
  chunk_chars: PreflightChunkChars;
  /** The first five chunks only. */
  preview_chunks: PreflightPreviewChunk[];
  article: PreflightArticle;
  embedding: PreflightEmbedding;
  /** Null when the page is new to the corpus. */
  existing: PreflightExisting | null;
  warnings: string[];
}

/* ── Chat ───────────────────────────────────────────────────────────────── */

export interface Citation {
  n: number;
  chunk_id: number;
  document_id: number;
  filename: string;
  chunk_index: number;
  /** 0..1 cosine similarity. */
  similarity: number;
  content: string;
}

export type CacheKind = 'exact' | 'semantic' | 'miss';

/** The closest cached question that still failed the threshold. Present on misses. */
export interface CacheNearest {
  question: string;
  /** 0..1 cosine similarity against the cached question's embedding. */
  similarity: number;
}

export interface CacheInfo {
  hit: boolean;
  kind: CacheKind;
  similarity: number | null;
  matched_question: string | null;
  age_seconds: number | null;
  saved_api_calls: number;
  /** Null on a hit, and null on a miss with an empty cache. */
  nearest: CacheNearest | null;
  /** The configured semantic cut-off the lookup was judged against. */
  threshold: number;
}

export interface Timings {
  embed: number;
  cache_lookup: number;
  retrieve: number;
  generate: number;
  total: number;
}

export interface ChatRequest {
  question: string;
  /** Omit or null to search every document. */
  document_ids?: number[] | null;
  top_k?: number;
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  cached: boolean;
  cache: CacheInfo;
  timings_ms: Timings;
}

/* ── Stream events (POST /api/chat/stream) ──────────────────────────────── */
/** Order is always: cache → retrieval → token* → done. */

export interface CacheEvent {
  type: 'cache';
  cache: CacheInfo;
}

export interface RetrievalEvent {
  type: 'retrieval';
  citations: Citation[];
}

export interface TokenEvent {
  type: 'token';
  text: string;
}

export interface DoneEvent {
  type: 'done';
  cached: boolean;
  cache: CacheInfo;
  timings_ms: Timings;
}

export interface ErrorEvent {
  type: 'error';
  detail: string;
}

export type StreamEvent = CacheEvent | RetrievalEvent | TokenEvent | DoneEvent | ErrorEvent;

/* ── Ingest events (POST /api/documents/stream) ─────────────────────────── */
/** Order: started → extracting → extracted → chunking → chunk* → chunked →
 *  embedding → embedding* → indexing → done. Every frame is a thing that
 *  actually happened.
 *
 *  The URL stream (POST /api/documents/url/stream) is the same sequence with
 *  three frames in front and one after: started → resolving → fetching →
 *  fetched → extracting → article → extracted → … → done. */

/**
 * `resolving | fetching | fetched` only ever appear on the URL stream, at the
 * front of the run. Everything from `extracting` on is the file path, unchanged.
 */
export type IngestStage =
  | 'resolving'
  | 'fetching'
  | 'fetched'
  | 'extracting'
  | 'extracted'
  | 'chunking'
  | 'embedding'
  | 'indexing';

/**
 * Always the first frame. It carries the row id the server just created, which
 * is the only way a client that abandons the run can clean up after itself:
 * abort the fetch, then DELETE /api/documents/{document_id}.
 */
export interface IngestStartedEvent {
  type: 'started';
  document_id: number;
}

export interface IngestStageEvent {
  type: 'stage';
  stage: IngestStage;
  label: string;
  /** On `extracted` only. */
  n_chars?: number;
  /** On `resolving` only. */
  host?: string;
  /* On `fetched` only — what came back off the wire. */
  status?: number;
  bytes?: number;
  content_type?: string;
  final_url?: string;
  /**
   * True when the body was reused from the preflight's page cache, so pressing
   * Index did not hit the site a second time. `fetch_ms: 0` is the proof.
   */
  from_cache?: boolean;
  fetch_ms?: number;
}

/**
 * Emitted exactly once on the URL stream, immediately before `extracted`. This
 * is "here is what I found" — the reader confirms the right thing was scraped
 * before a single embedding is paid for.
 */
export interface IngestArticleEvent {
  type: 'article';
  title: string;
  site_name: string;
  author: string | null;
  published: string | null;
  n_words: number;
  reading_minutes: number;
  excerpt: string;
}

/** One per chunk, emitted as the splitter produces it. */
export interface IngestChunkEvent {
  type: 'chunk';
  index: number;
  n_chars: number;
  /** First ~90 characters, whitespace collapsed. */
  preview: string;
}

export interface IngestChunkedEvent {
  type: 'chunked';
  n_chunks: number;
  label: string;
}

/** One per completed embedding batch, plus one after the cache lookup. */
export interface IngestEmbeddingEvent {
  type: 'embedding';
  done: number;
  total: number;
  /** Chunks served from embedding_cache — these cost no API call. */
  cached: number;
  /** Cumulative Gemini embed requests actually sent. */
  api_calls: number;
}

export interface IngestDoneEvent {
  type: 'done';
  document: DocumentMeta;
}

export type IngestEvent =
  | IngestStartedEvent
  | IngestStageEvent
  | IngestArticleEvent
  | IngestChunkEvent
  | IngestChunkedEvent
  | IngestEmbeddingEvent
  | IngestDoneEvent
  | ErrorEvent;

/* ── Cache inspection ───────────────────────────────────────────────────── */

export interface CacheEntry {
  id: number;
  question: string;
  hits: number;
  answer_preview: string;
  created_at: string;
  last_hit_at: string | null;
}

export interface CacheListResponse {
  threshold: number;
  entries: CacheEntry[];
}

export interface CacheClearResponse {
  deleted: number;
}

/* ── Chunks ─────────────────────────────────────────────────────────────── */

export interface Chunk {
  id: number;
  chunk_index: number;
  n_chars: number;
  content: string;
}

export interface ChunksResponse {
  chunks: Chunk[];
}

/* ── Stats ──────────────────────────────────────────────────────────────── */

export interface Stats {
  documents: number;
  chunks: number;
  cache_entries: number;
  cache_hits: number;
  cache_misses: number;
  /** 0..1 */
  hit_rate: number;
  exact_hits: number;
  semantic_hits: number;
  saved_api_calls: number;
  embed_cache_rows: number;
  threshold: number;
}

/* ── Metrics (GET /api/metrics) ─────────────────────────────────────────── */

/** The three things this app can spend a Gemini call on. */
export type ApiCallKind = 'generate' | 'embed_query' | 'embed_document';

export interface TokenSplit {
  prompt: number;
  output: number;
  /** Reasoning tokens. Billed at the output rate, never shown to the reader. */
  thinking: number;
  total: number;
}

export interface KindTotals {
  calls: number;
  failed: number;
  calls_saved: number;
  /** Texts embedded / prompts sent — a batched embed call carries many items. */
  items: number;
  items_saved: number;
  tokens: TokenSplit;
  /** True for both embed kinds: those responses carry no usage metadata. */
  tokens_estimated: boolean;
}

export interface MetricsTotals {
  api_calls: number;
  failed_calls: number;
  calls_saved: number;
  by_kind: Record<ApiCallKind, KindTotals>;
  tokens: TokenSplit & { estimated: number; measured: number };
}

export interface LatencyShape {
  n: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface LatencyMetrics {
  overall: LatencyShape;
  by_kind: Record<ApiCallKind, LatencyShape>;
}

export interface EstimatedTokensSaved extends TokenSplit {
  estimated: boolean;
  /** How the extrapolation was done, in the server's own words. */
  basis: string;
}

export interface CacheMetrics {
  threshold: number;
  enabled: boolean;
  ttl_hours: number;
  lookups: number;
  hits: number;
  misses: number;
  exact_hits: number;
  semantic_hits: number;
  /** 0..1 */
  hit_rate: number;
  saved_api_calls: Record<ApiCallKind, number> & { total: number };
  estimated_tokens_saved: EstimatedTokensSaved;
}

export interface Money {
  usd: number;
  inr: number;
}

export interface CostRates {
  unit: string;
  chat_model: string;
  chat_input: number;
  chat_output: number;
  embed_model: string;
  embed_input: number;
  thinking_billed_as: string;
  usd_inr: number;
  source: string;
  as_of: string;
}

export interface CostMetrics {
  tier: string;
  actual_cost_usd: number;
  actual_cost_inr: number;
  note: string;
  rates: CostRates;
  would_have_cost: Money;
  breakdown: {
    generate_input: Money;
    generate_output: Money;
    generate_thinking: Money;
    embed_input: Money;
  };
  saved_by_cache: Money & { estimated: boolean };
}

/** One row of the api_calls ledger. `saved` rows are calls that never happened. */
export interface ApiCallRecord {
  id: number;
  created_at: string;
  kind: ApiCallKind;
  model: string;
  saved: boolean;
  ok: boolean;
  error: string | null;
  latency_ms: number;
  n_items: number;
  tokens_estimated: boolean;
  tokens: TokenSplit;
}

export interface TimeseriesPoint {
  /** ISO timestamp of the bucket start. */
  t: string;
  calls: number;
  saved: number;
  tokens: number;
  thinking_tokens: number;
}

export interface Timeseries {
  bucket: string;
  minutes: number;
  points: TimeseriesPoint[];
}

export interface Metrics {
  totals: MetricsTotals;
  latency_ms: LatencyMetrics;
  cache: CacheMetrics;
  cost: CostMetrics;
  /** Newest first, capped server-side at 50. */
  recent: ApiCallRecord[];
  timeseries: Timeseries;
}

/* ── Pipeline (GET /api/pipeline) ───────────────────────────────────────── */

export interface PipelineModels {
  chat: string;
  embed: string;
  thinking_level: string;
  temperature: number;
}

export interface PipelineEmbedding {
  dim: number;
  /** Read out of pg_attribute — the real on-disk width, not the setting. */
  stored_dim: number | null;
  normalized: boolean;
  why_normalized: string;
  task_types: { documents: string; queries: string };
  why_task_types: string;
}

export interface PipelineChunking {
  chunk_size: number;
  chunk_overlap: number;
  overlap_ratio: number;
}

export interface PipelineIndex {
  name: string | null;
  method: string | null;
  opclass: string | null;
  definition: string | null;
}

export interface PipelineRetrieval {
  top_k: number;
  min_similarity: number;
  metric: string;
  distance_operator: string;
  similarity_formula: string;
  index: PipelineIndex;
}

export interface PipelineCacheLayer {
  name: string;
  keyed_on: string;
  avoids: string;
  rows: number;
}

export interface PipelineCache {
  enabled: boolean;
  semantic_threshold: number;
  ttl_hours: number;
  layers: PipelineCacheLayer[];
}

export interface PipelineCorpus {
  documents: number;
  ready_documents: number;
  chunks: number;
  total_chunk_chars: number;
  avg_chunk_chars: number;
  min_chunk_chars: number;
  max_chunk_chars: number;
  vector_bytes: number;
  embedding_cache_rows: number;
  embedding_cache_vector_bytes: number;
  query_cache_rows: number;
}

export interface PipelineLimits {
  max_upload_bytes: number;
  allowed_extensions: string[];
}

export interface Pipeline {
  models: PipelineModels;
  embedding: PipelineEmbedding;
  chunking: PipelineChunking;
  retrieval: PipelineRetrieval;
  cache: PipelineCache;
  corpus: PipelineCorpus;
  limits: PipelineLimits;
}

/* ── Client-side view models ────────────────────────────────────────────── */

/**
 * The five top-level screens. Mirrored into the URL hash.
 *
 * `database` and `costing` were one `infra` destination with a segmented control
 * inside it. They are siblings of the rest now — see the legacy hash mapping in
 * App.tsx, which still answers to the links that shape left behind.
 */
export type View = 'ask' | 'pipeline' | 'signals' | 'database' | 'costing';

export type Phase = 'embedding' | 'retrieving' | 'generating' | 'done' | 'error';

export interface UserTurn {
  id: string;
  role: 'user';
  text: string;
  scopedTo: number[] | null;
}

export interface AssistantTurn {
  id: string;
  role: 'assistant';
  question: string;
  phase: Phase;
  text: string;
  citations: Citation[] | null;
  cache: CacheInfo | null;
  timings: Timings | null;
  error: string | null;
  startedAt: number;
  /**
   * The model that actually wrote this answer, read back from the api_calls
   * ledger once the run settles. Null on a cache hit (no model was called),
   * and null whenever the ledger row can't be identified — the footer simply
   * omits it rather than printing the configured default as if it were fact.
   */
  model: string | null;
}

export type Turn = UserTurn | AssistantTurn;

/** One chunk as it came off the splitter, kept for the live stack in the run. */
export interface ChunkTile {
  index: number;
  nChars: number;
  preview: string;
}

/** Where the run is. 'queued' is before the first frame arrives. */
export type RunStage = IngestStage | 'queued' | 'chunked' | 'done';

/** The `article` frame, as the run holds it. */
export interface RunArticle {
  title: string;
  siteName: string;
  author: string | null;
  published: string | null;
  nWords: number;
  readingMinutes: number;
  excerpt: string;
}

/** The `fetched` frame — what actually came back off the wire, or out of the cache. */
export interface RunFetched {
  status: number;
  bytes: number;
  contentType: string | null;
  finalUrl: string | null;
  /** The preflight already had this page; the site was not hit twice. */
  fromCache: boolean;
  fetchMs: number;
}

/**
 * A run of the ingest stream, as the modal sees it.
 *
 * Every field is something a server frame said, or a clock reading taken when a
 * frame arrived. Nothing here is interpolated, and no rate is derived from
 * anything but two real timestamps.
 */
export interface IngestRunState {
  startedAt: number;
  /** Which stream this is. A URL run has two extra steps at the front. */
  source: DocumentSource;
  /** From the `started` frame. Null until it lands — cancel handles that. */
  documentId: number | null;
  stage: RunStage;
  /** The server's own words for the current stage. */
  label: string;
  nChars: number | null;
  /** The most recent chunk previews; `nChunksSeen` is the true count. */
  chunks: ChunkTile[];
  /** Every chunk's length, in order — the live histogram is drawn from this. */
  chunkChars: number[];
  nChunksSeen: number;
  /** Set by the `chunked` frame, once splitting is finished. */
  nChunks: number | null;
  embed: { done: number; total: number; cached: number; apiCalls: number } | null;
  /** URL runs only. Set by the `fetched` frame. */
  fetched: RunFetched | null;
  /** URL runs only. Set by the one `article` frame, before any embedding. */
  article: RunArticle | null;
  /** performance.now() at the first and last frame of each measured phase. */
  splitFrom: number | null;
  splitTo: number | null;
  embedFrom: number | null;
  embedTo: number | null;
  /** The finished document, from the `done` frame. */
  document: DocumentMeta | null;
  error: string | null;
}
