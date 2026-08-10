import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, Cpu, Timer, Zap } from 'lucide-react';
import type { CacheInfo, Phase, Timings } from '../types';
import { formatMs, formatPct } from '../lib/format';
import { transition } from '../lib/motion';
import CacheBadge from './CacheBadge';
import LatencyRail from './LatencyRail';

/**
 * What the run cost, in one line under the answer.
 *
 * Three facts, in the order you'd ask for them: how long it took, who wrote it,
 * and whether the cache had it already. All three are measured — the model name
 * is the ledger row for this turn's generate call, not the configured default,
 * and it simply isn't shown when the run never reached a model.
 *
 * Everything underneath (the stage-by-stage timing rail, the near-miss the
 * cache rejected) is one click away rather than always on, because after the
 * first few answers you stop reading it and start reading the answer.
 */
export default function AnswerMeta({
  phase,
  timings,
  cache,
  model,
  actions,
}: {
  phase: Phase;
  timings: Timings | null;
  cache: CacheInfo | null;
  /** The model that actually answered, read back from the call ledger. */
  model: string | null;
  /** Copy, ask again — sit on the far end of the same line. */
  actions?: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);

  const hit = cache?.hit ?? false;
  const settled = phase === 'done';

  // A model name is long and mostly boilerplate. The distinguishing part is
  // what changed when the fallback chain moved, so lead with that.
  const shortModel = model?.replace(/^gemini-/, '').replace(/-latest$/, '') ?? null;

  const verdict = !cache
    ? null
    : hit
      ? cache.kind === 'exact'
        ? 'exact cache hit'
        : `semantic cache hit · ${formatPct(cache.similarity ?? 0)}`
      : 'cache miss';

  return (
    <div className="text-[12px]">
      <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group -ml-2 flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5
                   text-paper-faint transition-colors duration-150 hover:bg-ink-850 hover:text-paper-mute"
      >
        <motion.span
          aria-hidden="true"
          className="block shrink-0"
          animate={{ rotate: open ? 90 : 0 }}
          transition={transition(reduce, 0.18)}
        >
          <ChevronRight size={12} />
        </motion.span>

        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <Timer size={12} className="shrink-0" />
          {timings ? formatMs(timings.total) : settled ? '—' : 'measuring'}
        </span>

        {hit ? (
          <span className="inline-flex items-center gap-1.5 text-cache-dim">
            <Zap size={12} className="shrink-0" />
            from cache
          </span>
        ) : shortModel ? (
          <span className="inline-flex min-w-0 items-center gap-1.5" title={model ?? undefined}>
            <Cpu size={12} className="shrink-0" />
            <span className="truncate font-mono text-[11.5px]">{shortModel}</span>
          </span>
        ) : null}

        {verdict && <span className="truncate">{verdict}</span>}

        <span className="ml-1 hidden shrink-0 opacity-0 transition-opacity group-hover:opacity-100 sm:inline">
          {open ? 'hide detail' : 'detail'}
        </span>
      </button>

        {actions && <div className="ml-auto shrink-0">{actions}</div>}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition(reduce, 0.24)}
            className="overflow-hidden"
          >
            <div className="mt-1 rounded-xl border border-line-soft bg-ink-850/70 px-3.5 py-3">
              {cache && <CacheBadge cache={cache} />}
              <LatencyRail phase={phase} timings={timings} cacheHit={hit} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
