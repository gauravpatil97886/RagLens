import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { RefreshCw, X } from 'lucide-react';
import { ApiError } from '../api';
import {
  getCostingTrace,
  usdCost,
  type CostingSpan,
  type CostingTimings,
  type CostingTraceDetail,
} from '../lib/costing';
import { formatMs } from '../lib/format';
import { transition } from '../lib/motion';
import { Figure, KIND_INK, KIND_LABEL, clockTime, integer } from './figures';
import CostingWaterfall from './CostingWaterfall';

/**
 * One question, opened up.
 *
 * The list says a chat cost $0.0031; this says where every cent and every
 * millisecond of it went — the waterfall of steps, then the model calls those
 * steps made, one row each. It is the payoff of the whole surface, so nothing
 * here is summarised: if a call happened, its tokens and its price are printed.
 *
 * A cached trace has no spans at all. That is not an empty state to apologise
 * for — it is the argument, so it gets said in mint and in words.
 */

/** The chat pipeline's own order. Anything else the server sends follows. */
const TIMING_ORDER = ['embed', 'cache_lookup', 'retrieve', 'generate', 'total'];

const TIMING_LABEL: Record<string, string> = {
  embed: 'embed',
  cache_lookup: 'cache lookup',
  retrieve: 'retrieve',
  generate: 'generate',
  total: 'total',
};

function orderedTimings(timings: CostingTimings): { key: string; ms: number }[] {
  const keys = Object.keys(timings);
  keys.sort((a, b) => {
    const ai = TIMING_ORDER.indexOf(a);
    const bi = TIMING_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return keys
    .map((key) => ({ key, ms: timings[key] ?? 0 }))
    .filter((t) => Number.isFinite(t.ms));
}

function Stat({ label, value, tone = 'paper', title }: {
  label: string;
  value: string;
  tone?: 'paper' | 'cache' | 'alert' | 'mute';
  title?: string;
}) {
  const ink =
    tone === 'cache'
      ? 'text-cache'
      : tone === 'alert'
        ? 'text-alert'
        : tone === 'mute'
          ? 'text-paper-mute'
          : 'text-paper';
  return (
    <div className="min-w-0" title={title}>
      <p className="eyebrow">{label}</p>
      <p className={`mt-1 truncate font-mono text-[13px] tabular-nums ${ink}`}>{value}</p>
    </div>
  );
}

function SpanRow({ span }: { span: CostingSpan }) {
  const failed = !span.ok;
  return (
    <tr className={`border-t border-line-soft align-baseline ${failed ? 'bg-alert/[0.05]' : ''}`}>
      <td className="whitespace-nowrap py-1.5 pl-3 pr-3">
        <span className="inline-flex items-baseline gap-1.5 font-mono text-2xs uppercase tracking-micro text-paper-dim">
          <span
            className="translate-y-[-1px] inline-block h-1.5 w-1.5 rounded-[1px]"
            style={{ backgroundColor: KIND_INK[span.kind] }}
            aria-hidden="true"
          />
          {KIND_LABEL[span.kind] ?? span.kind}
        </span>
      </td>
      <td className="max-w-[11rem] truncate py-1.5 pr-3 font-mono text-2xs text-paper-faint">
        {span.model}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
        {integer(span.prompt_tokens)}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
        {span.output_tokens > 0 ? integer(span.output_tokens) : '—'}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper-faint">
        {span.thinking_tokens > 0 ? integer(span.thinking_tokens) : '—'}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper">
        <Figure
          value={integer(span.total_tokens)}
          estimated={span.tokens_estimated}
          why="Estimated: embedding responses carry no usage metadata, so the server counts from the text."
        />
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
        {formatMs(span.latency_ms)}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper">
        {usdCost(span.cost_usd)}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-2xs uppercase tracking-micro">
        {failed ? (
          <span className="text-alert" title={span.error ?? undefined}>
            failed
          </span>
        ) : span.saved ? (
          <span className="text-cache">cached</span>
        ) : (
          <span className="text-paper-mute">ok</span>
        )}
      </td>
    </tr>
  );
}

export default function CostingTraceDrawer({
  traceId,
  onClose,
}: {
  traceId: string;
  onClose: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [detail, setDetail] = useState<CostingTraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setDetail(null);
    setError(null);

    getCostingTrace(traceId, controller.signal)
      .then((next) => {
        if (live) setDetail(next);
      })
      .catch((err: unknown) => {
        if (!live || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (err instanceof ApiError && err.status === 404) {
          setError('That trace is not in the ledger — it may have been recorded before tracing existed.');
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not read that trace.');
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [traceId, attempt]);

  const trace = detail?.trace ?? null;
  const spans = detail?.spans ?? [];

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={transition(reduce, 0.18)}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-scrim/65 backdrop-blur-[2px]"
        aria-hidden="true"
      />

      <motion.aside
        role="dialog"
        aria-modal="true"
        aria-label="One trace, in full"
        initial={{ x: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }}
        transition={reduce ? { duration: 0.001 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[48rem] flex-col border-l border-line bg-ink-850 shadow-panel"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="eyebrow">
              one {trace?.kind ?? ''} trace · {traceId.slice(0, 8)}
            </p>
            <h2 className="mt-1 line-clamp-2 text-[15px] leading-snug text-paper">
              {trace ? trace.label : 'reading it out of the ledger'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-paper-mute transition-colors hover:text-paper"
            aria-label="Close panel"
          >
            <X size={16} />
          </button>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error && (
            <div className="rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
              <p className="font-mono text-2xs uppercase tracking-micro text-alert">
                trace unavailable
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
              <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
                <RefreshCw size={11} />
                try again
              </button>
            </div>
          )}

          {!detail && !error && (
            <div className="space-y-3" aria-hidden="true">
              <div className="h-24 animate-breathe rounded-lg border border-line bg-ink-800" />
              <div className="h-40 animate-breathe rounded-lg border border-line bg-ink-800" />
              <div className="h-40 animate-breathe rounded-lg border border-line bg-ink-800" />
            </div>
          )}

          {detail && trace && (
            <div className="space-y-5">
              {/* What the whole action came to. */}
              <div
                className={`grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border px-3.5 py-3 sm:grid-cols-4 ${
                  trace.cached
                    ? 'border-cache/30 bg-cache/[0.05]'
                    : 'border-line bg-ink-800'
                }`}
              >
                <Stat
                  label="cost"
                  value={usdCost(trace.cost_usd)}
                  tone={trace.cached ? 'cache' : 'paper'}
                  title={
                    trace.cached
                      ? 'The cache answered this. No model was called, so nothing was spent.'
                      : 'Computed from the pricing settings, from the tokens the API reported.'
                  }
                />
                <Stat label="latency" value={formatMs(trace.latency_ms)} />
                <Stat
                  label="tokens"
                  value={trace.total_tokens > 0 ? integer(trace.total_tokens) : '0'}
                />
                <Stat
                  label="model"
                  value={trace.model ?? 'none — cache hit'}
                  tone={trace.model ? 'paper' : 'cache'}
                  title={trace.model ?? 'No model answered this action.'}
                />
                <Stat
                  label="calls made"
                  value={integer(trace.api_calls)}
                  tone={trace.api_calls === 0 ? 'cache' : 'paper'}
                />
                <Stat
                  label="calls prevented"
                  value={integer(trace.saved_calls)}
                  tone={trace.saved_calls > 0 ? 'cache' : 'mute'}
                />
                <Stat label="citations" value={integer(trace.n_citations)} />
                <Stat
                  label="at"
                  value={clockTime(trace.created_at)}
                  title={trace.created_at}
                />
              </div>

              {!trace.ok && trace.error && (
                <div className="rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
                  <p className="font-mono text-2xs uppercase tracking-micro text-alert">
                    this action failed
                  </p>
                  <p className="mt-1 break-words font-mono text-2xs leading-relaxed text-paper-dim">
                    {trace.error}
                  </p>
                </div>
              )}

              <section aria-label="Waterfall">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="eyebrow text-paper-dim">where the time went</p>
                  <p className="font-mono text-2xs tabular-nums text-paper-faint">
                    {formatMs(trace.latency_ms)} wall clock
                  </p>
                </div>
                <div className="mt-2.5 rounded-lg border border-line bg-ink-800 px-3.5 py-3">
                  <CostingWaterfall entries={detail.waterfall ?? []} />
                </div>
              </section>

              {orderedTimings(detail.timings ?? {}).length > 0 && (
                <section aria-label="Stage timings">
                  <p className="eyebrow text-paper-dim">stage timings</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {orderedTimings(detail.timings ?? {}).map((t) => (
                      <li
                        key={t.key}
                        className="rounded border border-line bg-ink-800 px-2 py-1 font-mono text-2xs tabular-nums text-paper-mute"
                      >
                        {TIMING_LABEL[t.key] ?? t.key.replace(/_/g, ' ')}{' '}
                        <span className="text-paper">{formatMs(t.ms)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section aria-label="Model calls">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="eyebrow text-paper-dim">the model calls this action made</p>
                  <p className="font-mono text-2xs tabular-nums text-paper-faint">
                    {spans.length} {spans.length === 1 ? 'call' : 'calls'}
                  </p>
                </div>

                {spans.length === 0 ? (
                  <div className="mt-2.5 rounded-lg border border-cache/30 bg-cache/[0.06] px-3.5 py-3">
                    <p className="font-mono text-2xs uppercase tracking-micro text-cache">
                      no model call was made
                    </p>
                    <p className="mt-1.5 text-[13.5px] leading-[1.6] text-paper-dim">
                      {trace.cached
                        ? `The ${trace.cache_kind ?? 'answer'} cache recognised this question and returned a stored answer in ${formatMs(
                            trace.latency_ms,
                          )}. Every call this action would have made was prevented, so it cost nothing.`
                        : 'This action reached the model zero times — nothing was billed for it.'}
                    </p>
                  </div>
                ) : (
                  <div className="scroll-quiet mt-2.5 overflow-x-auto rounded-lg border border-line bg-ink-800">
                    <table className="w-full min-w-[44rem] border-collapse">
                      <caption className="sr-only">
                        Every API call this trace made, oldest first, with tokens, latency and cost.
                      </caption>
                      <thead>
                        <tr className="text-left font-mono text-2xs uppercase tracking-micro text-paper-faint">
                          <th scope="col" className="py-2 pl-3 pr-3 font-normal">
                            kind
                          </th>
                          <th scope="col" className="py-2 pr-3 font-normal">
                            model
                          </th>
                          <th scope="col" className="py-2 pr-3 text-right font-normal">
                            prompt
                          </th>
                          <th scope="col" className="py-2 pr-3 text-right font-normal">
                            output
                          </th>
                          <th scope="col" className="py-2 pr-3 text-right font-normal">
                            thinking
                          </th>
                          <th scope="col" className="py-2 pr-3 text-right font-normal">
                            tokens
                          </th>
                          <th scope="col" className="py-2 pr-3 text-right font-normal">
                            latency
                          </th>
                          <th scope="col" className="py-2 pr-3 text-right font-normal">
                            cost
                          </th>
                          <th scope="col" className="py-2 pr-3 font-normal">
                            result
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {spans.map((span) => (
                          <SpanRow key={span.id} span={span} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <p className="pb-1 font-mono text-2xs leading-relaxed text-paper-faint">
                trace {trace.trace_id}
                {trace.scope_key ? ` · scope ${trace.scope_key}` : ''}
              </p>
            </div>
          )}
        </div>
      </motion.aside>
    </>
  );
}
