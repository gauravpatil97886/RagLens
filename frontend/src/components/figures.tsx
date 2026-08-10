import type { ReactNode } from 'react';
import type { ApiCallKind } from '../types';

/**
 * Shared vocabulary for the two instrument views (Dashboard, PipelineView).
 *
 * ── Colour ────────────────────────────────────────────────────────────────
 * The house palette reserves mint for cache semantics and coral for failure,
 * and allows exactly one accent: marigold. So the three call kinds are not a
 * categorical palette — they are one marigold ramp, ordered the way they are
 * ordered in reality, by what a call of that kind costs you. Generate sits at
 * the bright end because it is the expensive one.
 *
 * The ramp is validated as an ordinal scale against the ink-850 panel surface:
 * monotone lightness, adjacent ΔL ≥ 0.06, hue spread 5°, darkest step 3.08:1
 * contrast. Colour never carries identity alone here — every series is also
 * named in mono next to its mark.
 */

export const KIND_ORDER: ApiCallKind[] = ['generate', 'embed_query', 'embed_document'];

export const KIND_INK: Record<ApiCallKind, string> = {
  generate: 'rgb(var(--chart-1))',
  embed_query: 'rgb(var(--chart-2))',
  embed_document: 'rgb(var(--chart-3))',
};

export const KIND_LABEL: Record<ApiCallKind, string> = {
  generate: 'generate',
  embed_query: 'embed query',
  embed_document: 'embed document',
};

export const KIND_NOTE: Record<ApiCallKind, string> = {
  generate: 'One answer written by the chat model.',
  embed_query: 'One question turned into a vector before the search.',
  embed_document: 'One batch of chunks turned into vectors at ingest time.',
};

/** Token classes share the marigold ramp; thinking takes the bright end, because
 *  it is the finding. Assignment is fixed, so a segment never changes colour. */
export const TOKEN_INK = {
  thinking: 'rgb(var(--chart-1))',
  prompt: 'rgb(var(--chart-2))',
  output: 'rgb(var(--chart-3))',
} as const;

/* ── Numbers ──────────────────────────────────────────────────────────── */

export const integer = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Tight spaces only — the exact figure always stays available in a title. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Flash pricing lands in the fourth decimal. Rounding to cents would print $0.00. */
export function usd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

/** A published list price, which is quoted in cents, not fractions of a cent. */
export function rate(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function inr(value: number): string {
  if (value === 0) return '₹0.00';
  return `₹${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** Local wall-clock, to the second — the call log is read against your own clock. */
export function clockTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

/* ── Provenance ───────────────────────────────────────────────────────── */

/**
 * Estimated numbers must never look measured. Colour is spoken for, so the
 * distinction is typographic: a `≈` prefix and a dotted underline, with the
 * reason on hover. Measured numbers are plain.
 */
export function Figure({
  value,
  estimated = false,
  why,
  className = '',
}: {
  value: ReactNode;
  estimated?: boolean;
  why?: string;
  className?: string;
}) {
  if (!estimated) {
    return <span className={`tabular-nums ${className}`}>{value}</span>;
  }
  return (
    <span
      className={`tabular-nums underline decoration-paper-faint decoration-dotted underline-offset-[5px] ${className}`}
      title={why ?? 'Estimated, not measured.'}
    >
      <span aria-hidden="true">≈</span>
      <span className="sr-only">approximately </span>
      {value}
    </span>
  );
}

/* ── Card shell ───────────────────────────────────────────────────────── */

export function Panel({
  title,
  hint,
  aside,
  children,
  className = '',
}: {
  title: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`min-w-0 rounded-xl border border-line bg-ink-850 shadow-inset ${className}`}
      aria-label={title}
    >
      <header className="flex items-baseline justify-between gap-3 border-b border-line-soft px-4 py-2.5">
        <h2 className="eyebrow text-paper-dim">{title}</h2>
        {aside}
      </header>
      <div className="px-4 py-3.5">{children}</div>
      {hint && (
        <p className="border-t border-line-soft px-4 py-2.5 text-[12.5px] leading-relaxed text-paper-mute">
          {hint}
        </p>
      )}
    </section>
  );
}
