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

export interface DocumentMeta {
  id: number;
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
}

export interface DocumentListResponse {
  documents: DocumentMeta[];
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

export interface CacheInfo {
  hit: boolean;
  kind: CacheKind;
  similarity: number | null;
  matched_question: string | null;
  age_seconds: number | null;
  saved_api_calls: number;
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
/** Order: extracting → extracted → chunking → chunk* → chunked → embedding →
 *  embedding* → indexing → done. Every frame is a thing that actually happened. */

export type IngestStage = 'extracting' | 'extracted' | 'chunking' | 'embedding' | 'indexing';

export interface IngestStageEvent {
  type: 'stage';
  stage: IngestStage;
  label: string;
  /** On `extracted` only. */
  n_chars?: number;
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
  | IngestStageEvent
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

/* ── Client-side view models ────────────────────────────────────────────── */

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
}

export type Turn = UserTurn | AssistantTurn;

/** One chunk as it came off the splitter, kept for the live stack in the ingest card. */
export interface ChunkTile {
  index: number;
  nChars: number;
  preview: string;
}

/**
 * An upload in flight. Every field here is something the server told us happened —
 * nothing is inferred from elapsed time except `startedAt`, which is a clock, not a guess.
 */
export interface UploadTask {
  id: string;
  filename: string;
  size: number;
  startedAt: number;
  /** 'queued' before the first frame; 'chunked' between the last chunk and embedding. */
  stage: IngestStage | 'queued' | 'chunked' | 'done';
  /** The server's own words for the current stage. */
  label: string;
  nChars: number | null;
  /** The most recent chunks; `nChunksSeen` is the true count. */
  chunks: ChunkTile[];
  nChunksSeen: number;
  /** Set by the `chunked` frame, once splitting is finished. */
  nChunks: number | null;
  embed: { done: number; total: number; cached: number; apiCalls: number } | null;
  error: string | null;
}
