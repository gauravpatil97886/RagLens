import { motion, useReducedMotion } from 'framer-motion';
import type { MetricsTotals } from '../types';
import { transition } from '../lib/motion';
import { KIND_INK, KIND_LABEL, KIND_NOTE, KIND_ORDER, integer } from './figures';

/**
 * Three kinds of call, one bar each, on a shared scale so they are actually
 * comparable. Every bar carries both halves of its story: what was sent
 * (marigold, deepening with the kind's cost) and what the cache prevented
 * (mint), so a kind with a busy cache reads as a short bar with a long tail.
 */
export default function KindBreakdown({ totals }: { totals: MetricsTotals }) {
  const reduce = useReducedMotion() ?? false;

  const peak = Math.max(
    1,
    ...KIND_ORDER.map((k) => totals.by_kind[k].calls + totals.by_kind[k].calls_saved),
  );

  return (
    <ul className="space-y-3.5">
      {KIND_ORDER.map((kind) => {
        const k = totals.by_kind[kind];
        const wanted = k.calls + k.calls_saved;
        return (
          <li key={kind}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="inline-flex items-baseline gap-2 font-mono text-2xs uppercase tracking-micro text-paper-dim">
                <span
                  className="translate-y-[-1px] inline-block h-1.5 w-1.5 rounded-[1px]"
                  style={{ backgroundColor: KIND_INK[kind] }}
                  aria-hidden="true"
                />
                {KIND_LABEL[kind]}
              </span>

              <span className="font-mono text-2xs tabular-nums text-paper-mute">
                <span className="text-[13px] text-paper">{integer(k.calls)}</span> made
                {k.calls_saved > 0 && (
                  <>
                    {' · '}
                    <span className="text-cache">{integer(k.calls_saved)} prevented</span>
                  </>
                )}
                {k.failed > 0 && (
                  <>
                    {' · '}
                    <span className="text-alert">{integer(k.failed)} failed</span>
                  </>
                )}
              </span>
            </div>

            <div className="mt-1.5 flex h-2 w-full gap-0.5" aria-hidden="true">
              {k.calls > 0 && (
                <motion.div
                  className="rounded-l-[3px] last:rounded-r-[3px]"
                  style={{ backgroundColor: KIND_INK[kind] }}
                  initial={false}
                  animate={{ width: `${(k.calls / peak) * 100}%` }}
                  transition={transition(reduce, 0.4)}
                />
              )}
              {k.calls_saved > 0 && (
                <motion.div
                  className="rounded-r-[3px] bg-cache first:rounded-l-[3px]"
                  initial={false}
                  animate={{ width: `${(k.calls_saved / peak) * 100}%` }}
                  transition={transition(reduce, 0.4)}
                />
              )}
              {wanted === 0 && <div className="w-full rounded-[3px] bg-ink-800" />}
            </div>

            <p className="mt-1.5 text-[12.5px] leading-snug text-paper-mute">
              {KIND_NOTE[kind]}
              {k.items !== k.calls && k.calls > 0 && (
                <>
                  {' '}
                  <span className="font-mono text-2xs tabular-nums text-paper-faint">
                    {integer(k.items)} items in {integer(k.calls)} call
                    {k.calls === 1 ? '' : 's'}
                  </span>
                </>
              )}
              {/* Only worth saying when a saved call covered more than one item —
                  for generate, calls and items are the same thing. */}
              {k.items_saved > k.calls_saved && (
                <>
                  {' '}
                  <span className="font-mono text-2xs tabular-nums text-cache-dim">
                    {integer(k.items_saved)} texts served from the embedding cache
                  </span>
                </>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
