/** Formatting helpers. Every number the instrument shows passes through here. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

/** 0.8134 → "81%" */
export function formatPct(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Compact relative age from a seconds count. */
export function formatAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Relative age from an ISO timestamp. */
export function formatSince(iso: string | null): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  return formatAge((Date.now() - then) / 1000);
}

/**
 * A publication date, as a reader would write it.
 *
 * Scraped pages give this as anything from a full timestamp to a bare
 * `2023-08-08`, so an unparseable value is returned untouched rather than
 * turned into "Invalid Date". A date with no time in it is formatted in UTC:
 * read as local, midnight would slide it to the previous day west of Greenwich.
 */
export function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
  return new Date(at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  });
}

export function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Keep long filenames from blowing out the rail while staying recognisable. */
export function truncateMiddle(text: string, max = 28): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.62);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}
