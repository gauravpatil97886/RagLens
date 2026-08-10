import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { ApiError, getMetrics } from '../api';
import type { Metrics } from '../types';
import { formatMs } from '../lib/format';
import { rise, stagger } from '../lib/motion';
import CallLog from './CallLog';
import CallSparkline from './CallSparkline';
import CostPanel from './CostPanel';
import KindBreakdown from './KindBreakdown';
import LatencyPanel from './LatencyPanel';
import MetricTile from './MetricTile';
import SavedVsMade from './SavedVsMade';
import TokenLedger from './TokenLedger';
import { Panel, integer } from './figures';

/**
 * What this demo has spent, and what it avoided spending.
 *
 * Every figure comes from GET /api/metrics, which reads the api_calls ledger.
 * Nothing here is seeded, sampled or padded — if the numbers look small it is
 * because the traffic was small.
 */

const POLL_MS = 5000;

function Skeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="h-36 animate-breathe rounded-xl border border-line bg-ink-850" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-breathe rounded-xl border border-line bg-ink-850" />
        ))}
      </div>
      <div className="h-40 animate-breathe rounded-xl border border-line bg-ink-850" />
    </div>
  );
}

export default function Dashboard() {
  const reduce = useReducedMotion() ?? false;
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    // A slow backend shouldn't stack requests every 5 seconds.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await getMetrics(signal);
      setMetrics(next);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : 'Could not read the metrics endpoint.');
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, attempt]);

  const stale = error !== null && metrics !== null;
  const idle = metrics !== null && metrics.totals.api_calls === 0 && metrics.totals.calls_saved === 0;

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[74rem] px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <p className="eyebrow">observability</p>
            <h1 className="mt-2 font-serif text-[1.75rem] leading-tight text-paper sm:text-[2.1rem]">
              What every answer actually cost
            </h1>
            <p className="mt-2 max-w-[42rem] font-serif text-[14.5px] leading-[1.65] text-paper-dim">
              Calls, tokens, latency and money — read straight out of the call ledger the
              backend writes on every request, including the ones it decided not to make.
            </p>
          </div>

          <p className="flex items-center gap-2 font-mono text-2xs uppercase tracking-micro text-paper-mute">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                stale ? 'bg-alert' : 'bg-cache'
              } ${stale || reduce ? '' : 'animate-breathe'}`}
              aria-hidden="true"
            />
            {stale ? 'stale' : `live · ${POLL_MS / 1000}s`}
          </p>
        </header>

        {error && (
          <div className="mt-5 rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
            <p className="font-mono text-2xs uppercase tracking-micro text-alert">
              {stale ? 'metrics stopped updating' : 'metrics unavailable'}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
            <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
              <RefreshCw size={11} />
              try again
            </button>
          </div>
        )}

        <div className="mt-6">
          {!metrics && !error && <Skeleton />}

          {metrics && (
            <motion.div
              variants={stagger(reduce, 0.05)}
              initial="hidden"
              animate="show"
              className="space-y-4"
            >
              <motion.div variants={rise(reduce)}>
                <SavedVsMade totals={metrics.totals} cache={metrics.cache} />
              </motion.div>

              {idle && (
                <motion.p
                  variants={rise(reduce)}
                  className="rounded-xl border border-dashed border-line-strong bg-ink-850 px-4 py-3.5 text-[13.5px] leading-relaxed text-paper-mute"
                >
                  No API calls recorded yet — ask a question on the{' '}
                  <span className="font-mono text-2xs uppercase tracking-micro text-paper-dim">
                    ask
                  </span>{' '}
                  tab and every panel below fills in from the real ledger.
                </motion.p>
              )}

              <motion.div variants={rise(reduce)} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricTile
                  label="cache hit rate"
                  value={metrics.cache.hit_rate * 100}
                  suffix="%"
                  tone="cache"
                  note={`${metrics.cache.hits} of ${metrics.cache.lookups} questions answered without asking the model — ${metrics.cache.exact_hits} exact, ${metrics.cache.semantic_hits} semantic.`}
                />
                <MetricTile
                  label="avg latency"
                  value={metrics.latency_ms.overall.avg}
                  suffix="ms"
                  note={`Across ${metrics.latency_ms.overall.n} measured calls. p95 is ${formatMs(
                    metrics.latency_ms.overall.p95,
                  )}.`}
                />
                <MetricTile
                  label="tokens used"
                  value={metrics.totals.tokens.total}
                  note={`${integer(metrics.totals.tokens.measured)} measured from responses, ${integer(
                    metrics.totals.tokens.estimated,
                  )} estimated for embeddings.`}
                />
                <MetricTile
                  label="failed calls"
                  value={metrics.totals.failed_calls}
                  tone={metrics.totals.failed_calls > 0 ? 'alert' : 'quiet'}
                  note={
                    metrics.totals.failed_calls > 0
                      ? 'Rejected by the API. The call log below names the reason for each one.'
                      : 'Nothing has been rejected by the API.'
                  }
                />
              </motion.div>

              <motion.div variants={rise(reduce)}>
                <Panel title={`traffic · per minute · last ${metrics.timeseries.minutes}m`}>
                  <CallSparkline series={metrics.timeseries} />
                </Panel>
              </motion.div>

              <motion.div variants={rise(reduce)} className="grid gap-4 lg:grid-cols-2">
                <Panel
                  title="calls by kind"
                  hint="A question costs at most two calls: one to embed it, one to answer it. Ingest spends embed_document calls in batches."
                >
                  <KindBreakdown totals={metrics.totals} />
                </Panel>

                <Panel title="latency distribution">
                  <LatencyPanel latency={metrics.latency_ms} />
                </Panel>
              </motion.div>

              <motion.div variants={rise(reduce)}>
                <Panel title="token usage">
                  <TokenLedger totals={metrics.totals} cache={metrics.cache} />
                </Panel>
              </motion.div>

              <motion.div variants={rise(reduce)}>
                <Panel title="cost">
                  <CostPanel cost={metrics.cost} />
                </Panel>
              </motion.div>

              <motion.div variants={rise(reduce)}>
                <Panel
                  title="call log"
                  aside={
                    <span className="font-mono text-2xs tabular-nums text-paper-faint">
                      last {metrics.recent.length}
                    </span>
                  }
                >
                  <CallLog recent={metrics.recent} />
                </Panel>
              </motion.div>

              <motion.p
                variants={rise(reduce)}
                className="pb-2 font-mono text-2xs leading-relaxed text-paper-faint"
              >
                <span className="underline decoration-paper-faint decoration-dotted underline-offset-[5px]">
                  ≈ dotted
                </span>{' '}
                marks an estimate — hover it for how it was derived. Every other number on this
                page was measured.
              </motion.p>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
