import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { ApiError } from '../api';
import {
  COST_WINDOWS,
  WINDOW_LABEL,
  getCostingSummary,
  inrCost,
  rateUsd,
  shareOf,
  usdCost,
  type CostWindow,
  type CostingByKind,
  type CostingByModel,
  type CostingSummary,
} from '../lib/costing';
import { formatMs } from '../lib/format';
import { rise, stagger, transition } from '../lib/motion';
import { KIND_INK, KIND_LABEL, Panel, integer } from './figures';
import CostingTraceDrawer from './CostingTraceDrawer';
import CostingTraces from './CostingTraces';

/**
 * The ledger, not the summary.
 *
 * Signals says how the system is doing; this says what each individual action
 * spent, and lets you open one and read it call by call. Every figure comes
 * from /api/costing, which computes cost from one pricing function — the same
 * one the trace writer uses, so no two screens here can disagree about money.
 *
 * Two rules it keeps. The real bill is zero, because this runs on the free
 * tier, and the server says so in its own words — that sentence is rendered
 * verbatim rather than paraphrased, so the UI can never overstate the spend.
 * And every cost is printed at whatever precision it actually has: Flash
 * pricing lands in the sixth decimal, and rounding that to $0.00 would quietly
 * turn a real number into a lie.
 */

const POLL_MS = 6000;

/* ── Small shared pieces ────────────────────────────────────────────────── */

function StripTile({
  label,
  value,
  note,
  tone = 'paper',
  title,
}: {
  label: string;
  value: string;
  note: ReactNode;
  tone?: 'paper' | 'cache' | 'signal' | 'quiet';
  title?: string;
}) {
  const ink =
    tone === 'cache'
      ? 'text-cache'
      : tone === 'signal'
        ? 'text-signal'
        : tone === 'quiet'
          ? 'text-paper-dim'
          : 'text-paper';

  return (
    <div className="bg-ink-850 px-4 py-3.5 transition-colors duration-200 hover:bg-ink-800" title={title}>
      <p className="eyebrow">{label}</p>
      <p className={`mt-1.5 truncate font-mono text-[1.35rem] leading-none tabular-nums ${ink}`}>
        {value}
      </p>
      <p className="mt-2 text-[12.5px] leading-snug text-paper-mute">{note}</p>
    </div>
  );
}

function WindowSwitcher({
  value,
  onChange,
}: {
  value: CostWindow;
  onChange: (w: CostWindow) => void;
}) {
  return (
    <div
      className="inline-flex overflow-hidden rounded-lg border border-line bg-ink-850"
      role="group"
      aria-label="Time window"
    >
      {COST_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onChange(w)}
          aria-pressed={value === w}
          title={WINDOW_LABEL[w]}
          className={`px-2.5 py-1.5 font-mono text-2xs uppercase tracking-micro transition-colors duration-150 ${
            value === w
              ? 'bg-signal/12 text-signal'
              : 'text-paper-mute hover:bg-ink-800 hover:text-paper'
          }`}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

/* ── 1 · the headline ───────────────────────────────────────────────────── */

function Headline({ summary }: { summary: CostingSummary }) {
  const reduce = useReducedMotion() ?? false;
  const t = summary.totals;
  const would = Math.max(t.would_have_cost_usd, t.cost_usd + t.saved_usd);
  const savedShare = shareOf(t.saved_usd, would);
  const wantedCalls = t.api_calls + t.saved_calls;

  return (
    <section
      className="rounded-2xl border border-cache/35 bg-cache/[0.06] px-4 py-4"
      aria-label="What the cache saved"
    >
      <p className="eyebrow">what the cache saved · {WINDOW_LABEL[summary.window] ?? summary.window}</p>

      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-[2.6rem] leading-none tabular-nums text-cache">
          {usdCost(t.saved_usd)}
        </span>
        <span className="font-mono text-[1.15rem] leading-none tabular-nums text-cache-dim">
          {inrCost(t.saved_inr)}
        </span>
      </div>

      <p className="mt-3 max-w-[46rem] text-[14px] leading-[1.6] text-paper-dim">
        This traffic would have cost{' '}
        <span className="font-mono tabular-nums text-paper">{usdCost(would)}</span> at the list
        rates below. It cost{' '}
        <span className="font-mono tabular-nums text-paper">{usdCost(t.cost_usd)}</span>, because{' '}
        <span className="text-cache">{integer(t.saved_calls)}</span> of {integer(wantedCalls)}{' '}
        model calls were never made.
      </p>

      {/* Spent against prevented, on the counterfactual bill. */}
      <div
        className="mt-3.5 flex h-3 w-full gap-0.5"
        role="img"
        aria-label={`${usdCost(t.cost_usd)} spent, ${usdCost(t.saved_usd)} prevented by the cache.`}
      >
        <motion.div
          className="rounded-l-[4px] bg-signal last:rounded-r-[4px]"
          initial={false}
          animate={{ width: `${(1 - savedShare) * 100}%` }}
          transition={transition(reduce, 0.45)}
          title={`spent ${usdCost(t.cost_usd)}`}
        />
        <motion.div
          className="rounded-r-[4px] bg-cache first:rounded-l-[4px]"
          initial={false}
          animate={{ width: `${savedShare * 100}%` }}
          transition={transition(reduce, 0.45)}
          title={`prevented ${usdCost(t.saved_usd)}`}
        />
      </div>

      <div className="mt-2 flex flex-wrap justify-between gap-x-4 font-mono text-2xs uppercase tracking-micro">
        <span className="text-signal">spent {usdCost(t.cost_usd)}</span>
        <span className="text-cache">
          {(savedShare * 100).toFixed(0)}% prevented · {usdCost(t.saved_usd)}
        </span>
      </div>

      {/* The caveat on every figure above, in the server's own words. The UI
          does not get to decide what the free tier means. */}
      <p className="mt-3.5 border-t border-cache/20 pt-3 text-[13px] leading-[1.6] text-paper-mute">
        {summary.projection.note}
      </p>
    </section>
  );
}

/* ── 2 · by model ───────────────────────────────────────────────────────── */

function ByModel({ rows }: { rows: CostingByModel[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-paper-mute">
        No model has been called in this window.
      </p>
    );
  }

  const peak = Math.max(1e-12, ...rows.map((r) => r.cost_usd));

  return (
    <div className="scroll-quiet -mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[42rem] border-collapse">
        <caption className="sr-only">
          Every model called in this window, with calls, tokens, cost, average latency and
          failures.
        </caption>
        <thead>
          <tr className="text-left font-mono text-2xs uppercase tracking-micro text-paper-faint">
            <th scope="col" className="pb-1.5 pr-3 font-normal">
              model
            </th>
            <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
              calls
            </th>
            <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
              tokens
            </th>
            <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
              cost
            </th>
            <th scope="col" className="pb-1.5 pr-3 font-normal">
              share
            </th>
            <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
              avg latency
            </th>
            <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
              failures
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model} className="border-t border-line-soft align-baseline">
              <td className="max-w-[15rem] truncate py-2 pr-3 font-mono text-2xs text-paper" title={r.model}>
                {r.model}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
                {integer(r.calls)}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
                {integer(r.total_tokens)}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums text-paper">
                {usdCost(r.cost_usd)}
              </td>
              <td className="w-[7rem] py-2 pr-3">
                <span className="block h-1.5 w-full rounded-[2px] bg-ink-800" aria-hidden="true">
                  <span
                    className="block h-full rounded-[2px] bg-signal"
                    style={{ width: `${Math.max(2, (r.cost_usd / peak) * 100)}%` }}
                  />
                </span>
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
                {formatMs(r.avg_latency_ms)}
              </td>
              <td
                className={`whitespace-nowrap py-2 pr-3 text-right font-mono text-2xs tabular-nums ${
                  r.failures > 0 ? 'text-alert' : 'text-paper-faint'
                }`}
              >
                {r.failures > 0 ? integer(r.failures) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── 3 · by kind ────────────────────────────────────────────────────────── */

function ByKind({ rows }: { rows: CostingByKind[] }) {
  const reduce = useReducedMotion() ?? false;

  if (rows.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-paper-mute">
        No calls of any kind in this window.
      </p>
    );
  }

  const peak = Math.max(1, ...rows.map((r) => r.calls + r.saved));

  return (
    <ul className="space-y-3.5">
      {rows.map((r) => (
        <li key={r.kind}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="inline-flex items-baseline gap-2 font-mono text-2xs uppercase tracking-micro text-paper-dim">
              <span
                className="translate-y-[-1px] inline-block h-1.5 w-1.5 rounded-[1px]"
                style={{ backgroundColor: KIND_INK[r.kind] ?? 'rgb(var(--paper-faint))' }}
                aria-hidden="true"
              />
              {KIND_LABEL[r.kind] ?? r.kind}
            </span>

            <span className="font-mono text-2xs tabular-nums text-paper-mute">
              <span className="text-[13px] text-paper">{integer(r.calls)}</span> made
              {r.saved > 0 && (
                <>
                  {' · '}
                  <span className="text-cache">{integer(r.saved)} prevented</span>
                </>
              )}
              {' · '}
              <span className="text-paper-dim">{usdCost(r.cost_usd)}</span>
            </span>
          </div>

          <div className="mt-1.5 flex h-2 w-full gap-0.5" aria-hidden="true">
            {r.calls > 0 && (
              <motion.div
                className="rounded-l-[3px] last:rounded-r-[3px]"
                style={{ backgroundColor: KIND_INK[r.kind] ?? 'rgb(var(--paper-faint))' }}
                initial={false}
                animate={{ width: `${(r.calls / peak) * 100}%` }}
                transition={transition(reduce, 0.4)}
              />
            )}
            {r.saved > 0 && (
              <motion.div
                className="rounded-r-[3px] bg-cache first:rounded-l-[3px]"
                initial={false}
                animate={{ width: `${(r.saved / peak) * 100}%` }}
                transition={transition(reduce, 0.4)}
              />
            )}
            {r.calls + r.saved === 0 && <div className="w-full rounded-[3px] bg-ink-800" />}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ── 4 · the projection ─────────────────────────────────────────────────── */

function Projection({ summary }: { summary: CostingSummary }) {
  const reduce = useReducedMotion() ?? false;
  const p = summary.projection;
  const worst = Math.max(1e-12, p.monthly_without_cache_usd, p.monthly_cost_usd);

  const bars = [
    {
      key: 'with',
      label: 'with the cache',
      value: p.monthly_cost_usd,
      className: 'bg-cache',
      ink: 'text-cache',
    },
    {
      key: 'without',
      label: 'without it',
      value: p.monthly_without_cache_usd,
      className: 'bg-signal',
      ink: 'text-signal',
    },
  ];

  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div className="rounded-lg border border-line bg-ink-800 px-3.5 py-3">
          <p className="eyebrow">a month at this rate</p>
          <p className="mt-2 font-mono text-[1.8rem] leading-none tabular-nums text-paper">
            {usdCost(p.monthly_cost_usd)}
          </p>
          <p className="mt-1.5 font-mono text-2xs tabular-nums text-paper-mute">
            {inrCost(p.monthly_cost_inr)}
          </p>
          <p className="mt-2.5 text-[12.5px] leading-snug text-paper-mute">
            Extrapolated from{' '}
            <span className="font-mono text-2xs text-paper-dim">{p.basis}</span> of traffic at{' '}
            <span className="font-mono text-2xs tabular-nums text-paper-dim">
              {integer(p.traces_per_day)}
            </span>{' '}
            actions a day. A projection, not a bill.
          </p>
        </div>

        <div className="min-w-0 space-y-3.5">
          {bars.map((b) => (
            <div key={b.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="eyebrow">{b.label}</span>
                <span className={`font-mono text-[13px] tabular-nums ${b.ink}`}>
                  {usdCost(b.value)}
                </span>
              </div>
              <div className="mt-1.5 h-2.5 w-full rounded-[3px] bg-ink-800" aria-hidden="true">
                <motion.div
                  className={`h-full rounded-[3px] ${b.className}`}
                  initial={false}
                  animate={{ width: `${Math.max(2, (b.value / worst) * 100)}%` }}
                  transition={transition(reduce, 0.45)}
                />
              </div>
            </div>
          ))}

          <p className="rounded-lg border-l-2 border-cache/60 bg-cache/[0.05] px-3.5 py-2.5 text-[13px] leading-[1.6] text-paper-dim">
            Both figures are this window’s spend rate multiplied out to a month — nothing is
            forecast and no growth is assumed. The free-tier note at the top of the page applies
            to them too.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── The view ───────────────────────────────────────────────────────────── */

function Skeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="h-44 animate-breathe rounded-2xl border border-line bg-ink-850" />
      <div className="grid gap-px overflow-hidden rounded-xl border border-line bg-line-soft sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-breathe bg-ink-850" />
        ))}
      </div>
      <div className="h-40 animate-breathe rounded-xl border border-line bg-ink-850" />
      <div className="h-56 animate-breathe rounded-xl border border-line bg-ink-850" />
    </div>
  );
}

export default function CostingView() {
  const reduce = useReducedMotion() ?? false;
  const [window_, setWindow] = useState<CostWindow>('24h');
  const [summary, setSummary] = useState<CostingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(
    async (w: CostWindow, signal?: AbortSignal) => {
      // A slow backend shouldn't stack a request every six seconds.
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const next = await getCostingSummary(w, signal);
        setSummary(next);
        setError(null);
        setMissing(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // The costing endpoints can legitimately not be there yet. That is an
        // empty state, not a failure to shout about.
        if (err instanceof ApiError && err.status === 404) {
          setMissing(true);
          setError(null);
          setSummary(null);
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not read the costing endpoint.');
      } finally {
        inFlight.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    void load(window_, controller.signal);
    const timer = globalThis.setInterval(() => void load(window_), POLL_MS);
    return () => {
      controller.abort();
      globalThis.clearInterval(timer);
    };
  }, [load, window_, attempt]);

  const stale = error !== null && summary !== null;
  const totals = summary?.totals ?? null;
  const idle = totals !== null && totals.traces === 0 && totals.api_calls === 0;

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full min-w-0 max-w-[74rem] px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p className="eyebrow">costing</p>
            <h1 className="mt-2 max-w-[38rem] text-[1.75rem] font-semibold leading-[1.14] tracking-[-0.022em] text-paper sm:text-[2.05rem]">
              Every model call, and what each chat cost
            </h1>
            <p className="mt-3 max-w-[42rem] text-[14.5px] leading-[1.65] text-paper-dim">
              One row per question asked, priced from the tokens the API reported. Open one and
              the whole action comes apart — embed, cache lookup, retrieve, generate — with the
              cost of each step it actually took.
            </p>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            <p className="flex items-center gap-2 font-mono text-2xs uppercase tracking-micro text-paper-mute">
              <span
                className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-alert' : 'bg-cache'} ${
                  stale || reduce ? '' : 'animate-breathe'
                }`}
                aria-hidden="true"
              />
              {stale ? 'stale' : `live · ${POLL_MS / 1000}s`}
            </p>
            <WindowSwitcher value={window_} onChange={setWindow} />
          </div>
        </header>

        {error && (
          <div className="mt-5 rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
            <p className="font-mono text-2xs uppercase tracking-micro text-alert">
              {stale ? 'costing stopped updating' : 'costing unavailable'}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
            <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
              <RefreshCw size={11} />
              try again
            </button>
          </div>
        )}

        {missing && (
          <div className="mt-6 rounded-xl border border-dashed border-line-strong bg-ink-850 px-4 py-5">
            <p className="eyebrow">no cost data yet</p>
            <p className="mt-2 max-w-[42rem] text-[14px] leading-[1.65] text-paper-dim">
              The costing ledger has nothing to show for{' '}
              {WINDOW_LABEL[window_] ?? window_}. Once a question is asked or a document indexed,
              every call it makes — and every call the cache prevents — is recorded here with its
              price.
            </p>
            <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-3">
              <RefreshCw size={11} />
              check again
            </button>
          </div>
        )}

        <div className="mt-6">
          {!summary && !error && !missing && <Skeleton />}

          {summary && (
            <motion.div
              variants={stagger(reduce, 0.05)}
              initial="hidden"
              animate="show"
              className="space-y-5"
            >
              <motion.div variants={rise(reduce)}>
                <Headline summary={summary} />
              </motion.div>

              {idle && (
                <motion.p
                  variants={rise(reduce)}
                  className="rounded-xl border border-dashed border-line-strong bg-ink-850 px-4 py-3.5 text-[13.5px] leading-relaxed text-paper-mute"
                >
                  No cost data yet in {WINDOW_LABEL[summary.window] ?? summary.window} — ask a
                  question on the{' '}
                  <span className="font-mono text-2xs uppercase tracking-micro text-paper-dim">
                    ask
                  </span>{' '}
                  tab, or widen the window above, and every panel here fills in from the real
                  ledger.
                </motion.p>
              )}

              {/* The four facts underneath the hero, sharing one frame. */}
              <motion.div
                variants={rise(reduce)}
                className="grid gap-px overflow-hidden rounded-xl border border-line bg-line-soft sm:grid-cols-2 xl:grid-cols-4"
              >
                <StripTile
                  label="what it cost"
                  value={usdCost(summary.totals.cost_usd)}
                  tone="paper"
                  note={
                    <>
                      {inrCost(summary.totals.cost_inr)} at the rates below, across{' '}
                      {integer(summary.totals.traces)}{' '}
                      {summary.totals.traces === 1 ? 'action' : 'actions'}.
                    </>
                  }
                />
                <StripTile
                  label="would have cost"
                  value={usdCost(summary.totals.would_have_cost_usd)}
                  tone="signal"
                  note="The same traffic with no cache in front of it — the counterfactual, not an invoice."
                />
                <StripTile
                  label="calls"
                  value={integer(summary.totals.api_calls)}
                  tone="paper"
                  note={
                    <>
                      Sent to the API.{' '}
                      <span className="text-cache">
                        {integer(summary.totals.saved_calls)} prevented
                      </span>{' '}
                      by the cache.
                    </>
                  }
                />
                <StripTile
                  label="tokens"
                  value={integer(summary.totals.total_tokens)}
                  tone="paper"
                  note={
                    <>
                      {integer(summary.totals.prompt_tokens)} prompt ·{' '}
                      {integer(summary.totals.thinking_tokens)} thinking ·{' '}
                      {integer(summary.totals.output_tokens)} output.
                    </>
                  }
                />
              </motion.div>

              {summary.per_chat && (
                <motion.div variants={rise(reduce)}>
                  <Panel
                    title="the median chat"
                    hint="Medians, not averages — one expensive outlier shouldn't set your expectation of what a question costs."
                  >
                    <dl className="grid grid-cols-3 gap-4">
                      <div>
                        <dt className="eyebrow">cost</dt>
                        <dd className="mt-1.5 font-mono text-[1.35rem] leading-none tabular-nums text-paper">
                          {usdCost(summary.per_chat.median_cost_usd)}
                        </dd>
                      </div>
                      <div>
                        <dt className="eyebrow">tokens</dt>
                        <dd className="mt-1.5 font-mono text-[1.35rem] leading-none tabular-nums text-paper">
                          {integer(summary.per_chat.median_tokens)}
                        </dd>
                      </div>
                      <div>
                        <dt className="eyebrow">latency</dt>
                        <dd className="mt-1.5 font-mono text-[1.35rem] leading-none tabular-nums text-paper">
                          {formatMs(summary.per_chat.median_latency_ms)}
                        </dd>
                      </div>
                    </dl>
                  </Panel>
                </motion.div>
              )}

              <motion.div variants={rise(reduce)} className="grid gap-4 lg:grid-cols-2">
                <Panel
                  title="by model"
                  hint="Fallbacks mean a single question can be answered by whichever model was available. Each one is priced separately."
                >
                  <ByModel rows={summary.by_model ?? []} />
                </Panel>

                <Panel
                  title="by kind"
                  hint="A question costs at most two calls: one to embed it, one to answer it. Ingest spends embed_document calls in batches."
                >
                  <ByKind rows={summary.by_kind ?? []} />
                </Panel>
              </motion.div>

              <motion.div variants={rise(reduce)}>
                <Panel
                  title="projection"
                  aside={
                    <span className="font-mono text-2xs tabular-nums text-paper-faint">
                      from {summary.projection.basis}
                    </span>
                  }
                >
                  <Projection summary={summary} />
                </Panel>
              </motion.div>

              <motion.div variants={rise(reduce)}>
                <Panel
                  title="traces · one row per action"
                  hint="A row with no model and no cost is a cache hit: the question was recognised and answered without asking the model anything. Select any row to open it."
                >
                  <CostingTraces openTrace={openTrace} onOpen={setOpenTrace} />
                </Panel>
              </motion.div>

              <motion.p
                variants={rise(reduce)}
                className="pb-2 font-mono text-2xs leading-relaxed tabular-nums text-paper-faint"
              >
                rates · chat in {rateUsd(summary.pricing.chat_input_per_1m_usd)} · out{' '}
                {rateUsd(summary.pricing.chat_output_per_1m_usd)} · embed{' '}
                {rateUsd(summary.pricing.embed_input_per_1m_usd)} · per 1M tokens · tier{' '}
                {summary.pricing.tier} · $1 = ₹{summary.pricing.usd_inr_rate} · as of{' '}
                {summary.pricing.as_of} ·{' '}
                <a
                  href={summary.pricing.source}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal"
                >
                  source
                  <ExternalLink size={10} />
                </a>
              </motion.p>
            </motion.div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {openTrace !== null && (
          <CostingTraceDrawer traceId={openTrace} onClose={() => setOpenTrace(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
