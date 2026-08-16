/**
 * The infra endpoints — types and fetchers, kept out of api.ts on purpose.
 *
 * Everything under /api/infra is read-only by design: there is no endpoint
 * that takes SQL, and table access is limited to a fixed whitelist. These
 * types mirror the frozen contract exactly; where the contract shows a value
 * that can legitimately be absent (no index built yet, a cache with no TTL)
 * the type is widened to null rather than guessed at.
 */

import { ApiError } from '../api';

const API = '/api';

const OFFLINE = 'Can’t reach the API. Check that the backend is running on port 8000.';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(OFFLINE, 0);
  }
  if (!res.ok) {
    let detail = res.statusText
      ? `${res.status} ${res.statusText}`
      : `Request failed (${res.status})`;
    try {
      const body: unknown = await res.json();
      if (
        body &&
        typeof body === 'object' &&
        typeof (body as { detail?: unknown }).detail === 'string'
      ) {
        detail = (body as { detail: string }).detail;
      }
    } catch {
      // Body wasn't JSON. Keep the status-line fallback.
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

/* ── GET /api/infra ─────────────────────────────────────────────────────── */

export interface InfraServer {
  postgres_version: string;
  pgvector_version: string | null;
  database: string;
  host: string;
  port: number;
  database_bytes: number;
  database_pretty: string;
  connections: { active: number; max: number };
}

/**
 * Note the nulls. The contract's example shows a populated database; the
 * server returns null for anything it cannot measure yet — no vector column,
 * no text to compare against, no index built. An empty corpus hits all of them
 * at once, so every one of these is rendered with a fallback.
 */
export interface InfraVectors {
  dimensions: number | null;
  stored: number;
  bytes_per_vector: number;
  vector_bytes: number;
  text_bytes: number;
  /** null when there is no text to divide by. */
  expansion_ratio: number | null;
  /** Sampled over the first N chunks, so speak of "measured", not "every". */
  l2_norm: { min: number | null; mean: number | null; max: number | null };
  /** null when no vector index exists yet. */
  index_method: string | null;
  index_ops: string | null;
  index_bytes: number | null;
  distance_operator: string;
}

export interface InfraColumn {
  name: string;
  type: string;
  nullable: boolean;
  is_vector: boolean;
}

export interface InfraIndex {
  name: string;
  method: string;
  size_pretty: string;
  is_vector: boolean;
  definition: string;
}

export interface InfraTable {
  name: string;
  /** Plain English, written by the server. The UI never invents this. */
  role: string;
  rows: number;
  total_bytes: number;
  total_pretty: string;
  heap_pretty: string;
  index_pretty: string;
  toast_pretty: string;
  columns: InfraColumn[];
  indexes: InfraIndex[];
}

export type CacheWhere = 'postgres' | 'memory';

export interface InfraCacheLayer {
  layer: string;
  where: CacheWhere;
  what: string;
  rows: number;
  size_pretty: string;
  key: string;
  ttl: string | null;
}

export interface InfraCounters {
  exact_hits: number;
  semantic_hits: number;
  misses: number;
}

export interface InfraOverview {
  server: InfraServer;
  vectors: InfraVectors;
  tables: InfraTable[];
  caches: InfraCacheLayer[];
  counters: InfraCounters;
}

export function getInfra(signal?: AbortSignal): Promise<InfraOverview> {
  return getJson<InfraOverview>('/infra', signal);
}

/* ── GET /api/infra/table/{name} ────────────────────────────────────────── */

/**
 * A vector column, as it comes back from the row browser. Never the full 768
 * floats — a page of those would be megabytes of JSON — so `head` carries the
 * first eight values and dims/bytes/l2_norm tell the rest of the story.
 */
export interface VectorCell {
  __vector__: true;
  dims: number;
  bytes: number;
  l2_norm: number | null;
  head: number[];
}

/** Any other column comes back as-is. `<name>__truncated: true` marks a clipped one. */
export type CellValue = string | number | boolean | null | VectorCell;

export function isVectorCell(value: CellValue): value is VectorCell {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __vector__?: unknown }).__vector__ === true
  );
}

export interface InfraRowsPage {
  table: string;
  total: number;
  limit: number;
  offset: number;
  columns: { name: string; type: string; is_vector?: boolean }[];
  rows: Record<string, CellValue>[];
}

export const ROWS_PER_PAGE = 25;

export function getInfraTable(
  name: string,
  limit = ROWS_PER_PAGE,
  offset = 0,
  signal?: AbortSignal,
): Promise<InfraRowsPage> {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return getJson<InfraRowsPage>(`/infra/table/${encodeURIComponent(name)}?${q}`, signal);
}

/* ── GET /api/infra/vector/{chunk_id} ───────────────────────────────────── */

export interface VectorNeighbour {
  chunk_id: number;
  filename: string;
  chunk_index: number;
  similarity: number;
  preview: string;
}

export interface InfraVectorDetail {
  chunk_id: number;
  document_id: number;
  filename: string;
  chunk_index: number;
  content: string;
  dims: number;
  bytes: number;
  l2_norm: number;
  /** All four are null for a zero-length vector — guarded rather than assumed. */
  stats: {
    min: number | null;
    max: number | null;
    mean: number | null;
    abs_mean: number | null;
  };
  values: number[];
  /** The 5 nearest other chunks, by the same `<=>` query retrieval uses. */
  neighbours: VectorNeighbour[];
}

export function getInfraVector(
  chunkId: number,
  signal?: AbortSignal,
): Promise<InfraVectorDetail> {
  return getJson<InfraVectorDetail>(`/infra/vector/${chunkId}`, signal);
}

/* ── GET /api/infra/explain ─────────────────────────────────────────────── */

export interface ExplainPlan {
  plan: string;
  uses_index: boolean;
  ms: number;
}

export interface InfraExplain {
  query: string;
  rows_in_table: number;
  chosen: ExplainPlan;
  forced_index: ExplainPlan;
  /** Server-generated plain English. Rendered verbatim, never composed here. */
  verdict: string;
  note: string;
}

export function getInfraExplain(signal?: AbortSignal): Promise<InfraExplain> {
  return getJson<InfraExplain>('/infra/explain', signal);
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const PRETTY_UNITS: Record<string, number> = {
  bytes: 1,
  byte: 1,
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

/**
 * Turn a pg_size_pretty string ("216 kB") back into bytes, so the heap /
 * index / toast split can be drawn as one proportional bar. Returns null on
 * anything unexpected — the caller then just prints the three strings.
 */
export function parsePretty(pretty: string | null | undefined): number | null {
  if (!pretty) return null;
  const match = /^\s*(-?[\d.]+)\s*([a-zA-Z]+)\s*$/.exec(pretty);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = PRETTY_UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(amount) || unit === undefined) return null;
  return amount * unit;
}

/** Fixed-width signed float, so a column of them lines up on the decimal point. */
export function signedFixed(value: number | null | undefined, digits = 6): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const body = Math.abs(value).toFixed(digits);
  return `${value < 0 ? '-' : '+'}${body}`;
}

/** A measurement the server could not take prints as an em dash, never as 0. */
export function fixed(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}
