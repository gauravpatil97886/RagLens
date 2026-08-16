/**
 * The costing endpoints — types and fetchers, kept out of api.ts on purpose.
 *
 * Signals answers "how is it doing right now". Costing answers "what did that
 * one question cost, step by step" — so everything here is per-call or
 * per-trace, and every field mirrors the frozen contract exactly. Where the
 * contract shows a value that can legitimately be absent (a cached trace has no
 * model, an ingest trace has no cache verdict) the type is widened to null
 * rather than guessed at.
 *
 * The money formatters live here too. Gemini Flash pricing lands in the sixth
 * decimal, so a cost printed with a currency formatter reads as $0.00 and a
 * cost printed with the default number formatter reads as 1.8e-6. Neither is
 * acceptable on a page whose entire job is to be believed about small numbers.
 */

import { ApiError } from '../api';
import type { ApiCallKind } from '../types';

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

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

export const COST_WINDOWS = ['1h', '24h', '7d', 'all'] as const;
export type CostWindow = (typeof COST_WINDOWS)[number];

export const WINDOW_LABEL: Record<CostWindow, string> = {
  '1h': 'the last hour',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  all: 'all time',
};

export type TraceKind = 'chat' | 'ingest';
export type CacheKind = 'miss' | 'exact' | 'semantic';

/* ── GET /api/costing/summary?window= ───────────────────────────────────── */

export interface CostingPricing {
  chat_input_per_1m_usd: number;
  chat_output_per_1m_usd: number;
  embed_input_per_1m_usd: number;
  usd_inr_rate: number;
  tier: string;
  source: string;
  as_of: string;
}

export interface CostingTotals {
  traces: number;
  api_calls: number;
  saved_calls: number;
  prompt_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cost_inr: number;
  saved_usd: number;
  saved_inr: number;
  would_have_cost_usd: number;
}

export interface CostingByModel {
  model: string;
  calls: number;
  total_tokens: number;
  cost_usd: number;
  avg_latency_ms: number;
  failures: number;
}

export interface CostingByKind {
  kind: ApiCallKind;
  calls: number;
  saved: number;
  cost_usd: number;
}

export interface CostingPerChat {
  median_cost_usd: number;
  median_tokens: number;
  median_latency_ms: number;
}

export interface CostingProjection {
  /** The window the rate was measured over — "24h", not a billing period. */
  basis: string;
  traces_per_day: number;
  monthly_cost_usd: number;
  monthly_cost_inr: number;
  monthly_without_cache_usd: number;
  /** The free-tier caveat. Written by the server, rendered verbatim. */
  note: string;
}

export interface CostingSummary {
  window: CostWindow;
  pricing: CostingPricing;
  totals: CostingTotals;
  by_model: CostingByModel[];
  by_kind: CostingByKind[];
  per_chat: CostingPerChat | null;
  projection: CostingProjection;
}

/* ── GET /api/costing/traces ────────────────────────────────────────────── */

export interface CostingTrace {
  trace_id: string;
  kind: TraceKind;
  /** The question asked, or the filename/URL ingested. */
  label: string;
  /** Chat only — an ingest never consults the answer cache. */
  cache_kind: CacheKind | null;
  cached: boolean;
  /** Null when the cache answered and no model was ever asked. */
  model: string | null;
  api_calls: number;
  saved_calls: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
  n_citations: number;
  ok: boolean;
  created_at: string;
  error?: string | null;
  scope_key?: string | null;
}

export interface CostingTracesPage {
  total: number;
  limit: number;
  offset: number;
  traces: CostingTrace[];
}

/* ── GET /api/costing/trace/{trace_id} ──────────────────────────────────── */

/** `{embed, cache_lookup, retrieve, generate, total}` for a chat; an ingest
 *  keys its own stages, so this stays open rather than being pinned to five. */
export type CostingTimings = Record<string, number | null>;

export interface CostingSpan {
  id: number;
  kind: ApiCallKind;
  model: string;
  prompt_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
  tokens_estimated: boolean;
  latency_ms: number;
  ok: boolean;
  error: string | null;
  saved: boolean;
  cost_usd: number;
  created_at: string;
}

export interface CostingWaterfallEntry {
  label: string;
  /** Milliseconds from the start of the action. Computed server-side. */
  start_ms: number;
  duration_ms: number;
  billable: boolean;
  /** A step that did not run — drawn as an outline, never as a filled bar. */
  skipped?: boolean;
  skipped_reason?: string | null;
}

export interface CostingTraceDetail {
  trace: CostingTrace;
  timings: CostingTimings;
  spans: CostingSpan[];
  waterfall: CostingWaterfallEntry[];
}

/* ── Fetchers ───────────────────────────────────────────────────────────── */

/**
 * A payload missing its totals is a backend bug, not a rendering problem — so
 * it becomes an ApiError the view can show calmly, rather than a white screen
 * three components deep. The optional collections are filled in rather than
 * rejected: a window with no calls in it legitimately has no rows.
 */
export async function getCostingSummary(
  window: CostWindow,
  signal?: AbortSignal,
): Promise<CostingSummary> {
  const raw = await getJson<CostingSummary>(
    `/costing/summary?window=${encodeURIComponent(window)}`,
    signal,
  );
  if (!raw || !raw.totals || !raw.pricing || !raw.projection) {
    throw new ApiError('The costing summary came back without its totals.', 0);
  }
  return {
    ...raw,
    window: raw.window ?? window,
    by_model: Array.isArray(raw.by_model) ? raw.by_model : [],
    by_kind: Array.isArray(raw.by_kind) ? raw.by_kind : [],
    per_chat: raw.per_chat ?? null,
  };
}

export async function getCostingTraces(
  opts: {
    limit?: number;
    offset?: number;
    /** null means "both kinds". */
    kind?: TraceKind | null;
    /** null means "cached and uncached". */
    cached?: boolean | null;
  },
  signal?: AbortSignal,
): Promise<CostingTracesPage> {
  const params = new URLSearchParams();
  params.set('limit', String(Math.min(200, Math.max(1, opts.limit ?? 50))));
  params.set('offset', String(Math.max(0, opts.offset ?? 0)));
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.cached === true || opts.cached === false) params.set('cached', String(opts.cached));

  const raw = await getJson<CostingTracesPage>(`/costing/traces?${params.toString()}`, signal);
  const traces = Array.isArray(raw?.traces) ? raw.traces : [];
  return {
    total: Number.isFinite(raw?.total) ? raw.total : traces.length,
    limit: Number.isFinite(raw?.limit) ? raw.limit : (opts.limit ?? 50),
    offset: Number.isFinite(raw?.offset) ? raw.offset : (opts.offset ?? 0),
    traces,
  };
}

export async function getCostingTrace(
  traceId: string,
  signal?: AbortSignal,
): Promise<CostingTraceDetail> {
  const raw = await getJson<CostingTraceDetail>(
    `/costing/trace/${encodeURIComponent(traceId)}`,
    signal,
  );
  if (!raw || !raw.trace) {
    throw new ApiError('That trace came back without its summary row.', 0);
  }
  return {
    trace: raw.trace,
    timings: raw.timings ?? {},
    spans: Array.isArray(raw.spans) ? raw.spans : [],
    waterfall: Array.isArray(raw.waterfall) ? raw.waterfall : [],
  };
}

/* ── Money ──────────────────────────────────────────────────────────────── */

/**
 * A cost, at whatever precision it takes to still be a number.
 *
 * Zero is only ever printed for a genuine zero — a cache hit spent nothing, and
 * that is the point. Anything real but smaller than the last printable digit
 * gets a `<`, so no true cost is ever quietly rounded away to nothing.
 */
export function usdCost(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0) return `−${usdCost(-value)}`;
  if (value < 0.000001) return '<$0.000001';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  if (value < 1000) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function inrCost(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '₹0.00';
  if (value < 0) return `−${inrCost(-value)}`;
  if (value < 0.0001) return '<₹0.0001';
  if (value < 1) return `₹${value.toFixed(4)}`;
  if (value < 100000) return `₹${value.toFixed(2)}`;
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

/** A published list price, quoted in cents rather than fractions of a cent. */
export function rateUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
}

/** Share of a whole, guarding the empty case rather than printing NaN%. */
export function shareOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.min(1, Math.max(0, part / whole));
}
