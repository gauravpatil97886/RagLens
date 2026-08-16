import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { ApiError } from '../api';
import {
  getCostingTraces,
  usdCost,
  type CostingTrace,
  type CostingTracesPage,
  type TraceKind,
} from '../lib/costing';
import { formatMs } from '../lib/format';
import { clockTime, integer } from './figures';

/**
 * The ledger, one row per user action.
 *
 * The row that matters most is the one that cost nothing. A cache hit comes
 * back with `model: null`, `api_calls: 0` and `cost_usd: 0.0`, and if that row
 * looked like every other row the cache would be invisible — so it is tinted
 * mint, ruled mint down its left edge, and says so in words. Colour is never
 * the only carrier: the verdict is spelled out in the same cell.
 */

const PAGE = 25;
const POLL_MS = 6000;

type CachedFilter = 'all' | 'cached' | 'made';

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded-lg border px-2.5 py-1 font-mono text-2xs uppercase tracking-micro transition-colors duration-150 ${
        active
          ? 'border-signal/45 bg-signal/10 text-signal'
          : 'border-line bg-ink-800 text-paper-mute hover:border-line-strong hover:text-paper'
      }`}
    >
      {children}
    </button>
  );
}

function Verdict({ trace }: { trace: CostingTrace }) {
  if (!trace.ok) {
    return (
      <span className="rounded border border-alert/40 bg-alert/[0.08] px-1.5 py-0.5 font-mono text-2xs uppercase tracking-micro text-alert">
        failed
      </span>
    );
  }
  if (trace.cached) {
    return (
      <span className="rounded border border-cache/40 bg-cache/[0.12] px-1.5 py-0.5 font-mono text-2xs uppercase tracking-micro text-cache">
        cached{trace.cache_kind ? ` · ${trace.cache_kind}` : ''}
      </span>
    );
  }
  if (trace.kind === 'ingest') {
    return (
      <span className="rounded border border-line px-1.5 py-0.5 font-mono text-2xs uppercase tracking-micro text-paper-mute">
        ingest
      </span>
    );
  }
  return (
    <span className="rounded border border-line px-1.5 py-0.5 font-mono text-2xs uppercase tracking-micro text-paper-mute">
      {trace.cache_kind === 'miss' || trace.cache_kind === null ? 'model' : trace.cache_kind}
    </span>
  );
}

function Row({
  trace,
  open,
  onOpen,
}: {
  trace: CostingTrace;
  open: boolean;
  onOpen: (id: string) => void;
}) {
  const cached = trace.cached;

  return (
    <tr
      onClick={() => onOpen(trace.trace_id)}
      className={`cursor-pointer border-t border-line-soft align-baseline transition-colors duration-150 ${
        cached ? 'bg-cache/[0.05] hover:bg-cache/[0.09]' : 'hover:bg-ink-800'
      } ${open ? 'bg-signal/[0.07]' : ''}`}
    >
      <td
        className={`whitespace-nowrap py-2 pl-3 pr-3 font-mono text-2xs tabular-nums text-paper-mute ${
          cached ? 'border-l-2 border-cache/70' : 'border-l-2 border-transparent'
        }`}
        title={trace.created_at}
      >
        {clockTime(trace.created_at)}
      </td>

      <td className="max-w-[22rem] py-2 pr-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(trace.trace_id);
          }}
          className="block w-full truncate text-left text-[13px] leading-snug text-paper-dim underline-offset-4 hover:text-paper hover:underline"
          title={trace.label}
        >
          {trace.label}
        </button>
      </td>

      <td className="whitespace-nowrap py-2 pr-3">
        <Verdict trace={trace} />
      </td>

      <td className="max-w-[10rem] truncate py-2 pr-3 font-mono text-2xs text-paper-faint">
        {trace.model ?? <span className="text-cache">no model called</span>}
      </td>

      <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
        {trace.total_tokens > 0 ? integer(trace.total_tokens) : <span className="text-cache">0</span>}
      </td>

      <td
        className={`whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums ${
          cached ? 'text-cache' : 'text-paper'
        }`}
      >
        {usdCost(trace.cost_usd)}
      </td>

      <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
        {formatMs(trace.latency_ms)}
      </td>

      <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums text-paper-faint">
        {trace.kind === 'chat' ? integer(trace.n_citations) : '—'}
      </td>
    </tr>
  );
}

function Skeleton() {
  return (
    <div className="space-y-1.5 px-1 py-2" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-7 animate-breathe rounded bg-ink-800" />
      ))}
    </div>
  );
}

export default function CostingTraces({
  openTrace,
  onOpen,
}: {
  openTrace: string | null;
  onOpen: (id: string) => void;
}) {
  const [page, setPage] = useState<CostingTracesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState<TraceKind | null>(null);
  const [cached, setCached] = useState<CachedFilter>('all');
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    const load = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const next = await getCostingTraces(
          {
            limit: PAGE,
            offset,
            kind,
            cached: cached === 'all' ? null : cached === 'cached',
          },
          controller.signal,
        );
        if (!live) return;
        setPage(next);
        setError(null);
        setMissing(false);
      } catch (err) {
        if (!live || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (err instanceof ApiError && err.status === 404) {
          setMissing(true);
          setError(null);
        } else {
          setError(err instanceof ApiError ? err.message : 'Could not read the trace ledger.');
        }
      } finally {
        inFlight.current = false;
      }
    };

    void load();
    // Only the first page follows the live cadence — repaginating under someone
    // who is reading page three would be hostile.
    const timer = offset === 0 ? window.setInterval(() => void load(), POLL_MS) : null;

    return () => {
      live = false;
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [offset, kind, cached, attempt]);

  const from = !page || page.total === 0 ? 0 : page.offset + 1;
  const to = page ? Math.min(page.offset + page.limit, page.total) : 0;
  const canPrev = offset > 0;
  const canNext = page ? to < page.total : false;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={kind === null} onClick={() => { setKind(null); setOffset(0); }}>
            all
          </Chip>
          <Chip active={kind === 'chat'} onClick={() => { setKind('chat'); setOffset(0); }}>
            chat
          </Chip>
          <Chip active={kind === 'ingest'} onClick={() => { setKind('ingest'); setOffset(0); }}>
            ingest
          </Chip>

          <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />

          <Chip active={cached === 'all'} onClick={() => { setCached('all'); setOffset(0); }}>
            any
          </Chip>
          <Chip
            active={cached === 'cached'}
            onClick={() => { setCached('cached'); setOffset(0); }}
            title="Actions the cache answered — no model call, no cost."
          >
            cached
          </Chip>
          <Chip
            active={cached === 'made'}
            onClick={() => { setCached('made'); setOffset(0); }}
            title="Actions that reached the model."
          >
            called the model
          </Chip>
        </div>

        {page && page.total > 0 && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xs tabular-nums text-paper-mute">
              {integer(from)}–{integer(to)} of <span className="text-paper-dim">{integer(page.total)}</span>
            </span>
            <button
              type="button"
              className="btn px-2 py-1"
              disabled={!canPrev}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              <ChevronLeft size={11} />
              <span className="normal-case tracking-normal">prev</span>
            </button>
            <button
              type="button"
              className="btn px-2 py-1"
              disabled={!canNext}
              onClick={() => setOffset(offset + PAGE)}
            >
              <span className="normal-case tracking-normal">next</span>
              <ChevronRight size={11} />
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
          <p className="font-mono text-2xs uppercase tracking-micro text-alert">
            trace ledger unavailable
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
          <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
            <RefreshCw size={11} />
            try again
          </button>
        </div>
      )}

      {missing && (
        <p className="mt-3 rounded-lg border border-dashed border-line-strong bg-ink-800 px-3.5 py-3 text-[13px] leading-relaxed text-paper-mute">
          No trace data yet. Traces are recorded per user action; this endpoint has nothing to
          return until the ledger has been written to.
        </p>
      )}

      {!page && !error && !missing && <Skeleton />}

      {page && page.traces.length === 0 && (
        <p className="mt-3 rounded-lg border border-dashed border-line-strong bg-ink-800 px-3.5 py-3 text-[13px] leading-relaxed text-paper-mute">
          Nothing matches that filter.
        </p>
      )}

      {page && page.traces.length > 0 && (
        <div className="scroll-quiet mt-3 -mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[52rem] border-collapse">
            <caption className="sr-only">
              Every recorded action, newest first. Select a row to open its trace.
            </caption>
            <thead>
              <tr className="text-left font-mono text-2xs uppercase tracking-micro text-paper-faint">
                <th scope="col" className="pb-1.5 pl-3 pr-3 font-normal">
                  time
                </th>
                <th scope="col" className="pb-1.5 pr-3 font-normal">
                  what was asked
                </th>
                <th scope="col" className="pb-1.5 pr-3 font-normal">
                  verdict
                </th>
                <th scope="col" className="pb-1.5 pr-3 font-normal">
                  model
                </th>
                <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
                  tokens
                </th>
                <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
                  cost
                </th>
                <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
                  latency
                </th>
                <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
                  cites
                </th>
              </tr>
            </thead>
            <tbody>
              {page.traces.map((trace) => (
                <Row
                  key={trace.trace_id}
                  trace={trace}
                  open={openTrace === trace.trace_id}
                  onOpen={onOpen}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
