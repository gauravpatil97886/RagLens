import { motion, useReducedMotion } from 'framer-motion';
import type { CacheMetrics, MetricsTotals } from '../types';
import { useCountUp } from '../lib/useCountUp';
import { transition } from '../lib/motion';
import { KIND_INK, KIND_LABEL, KIND_ORDER, integer } from './figures';

/**
 * The headline, and the only hero number on the page.
 *
 * Every request the app *wanted* to make is one rail. What actually went to
 * Gemini is marigold; what the cache answered instead is mint. The point of
 * the whole demo is the length of the mint segment, so nothing else on this
 * screen is allowed to be this large.
 *
 * It deliberately wears no card. Everything else on the page is a panel sitting
 * on the page ground; the hero *is* the page ground, which is what makes it read
 * as one level above the stack rather than the first item in it.
 */
export default function SavedVsMade({
  totals,
  cache,
}: {
  totals: MetricsTotals;
  cache: CacheMetrics;
}) {
  const reduce = useReducedMotion() ?? false;

  const made = totals.api_calls;
  const saved = totals.calls_saved;
  const wanted = made + saved;
  const share = wanted > 0 ? saved / wanted : 0;

  const shownWanted = useCountUp(wanted, 620, reduce);
  const shownShare = useCountUp(share * 100, 620, reduce);

  const madePct = wanted > 0 ? (made / wanted) * 100 : 0;
  const savedPct = wanted > 0 ? (saved / wanted) * 100 : 0;

  return (
    <section
      className="border-y border-line py-6 sm:py-7"
      aria-label="Calls made versus calls the cache prevented"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="eyebrow">requests this app needed</p>
          <p className="mt-2 flex items-end gap-3.5 font-mono leading-[0.8] text-paper">
            <span className="text-[3.75rem] tracking-[-0.03em] tabular-nums sm:text-[5.25rem]">
              {Math.round(shownWanted)}
            </span>
            <span className="pb-1 text-2xs uppercase leading-[1.5] tracking-micro text-paper-mute">
              model calls
              <br />
              wanted
            </span>
          </p>
        </div>

        <p className="max-w-[24rem] text-[15.5px] leading-[1.6] text-paper-dim">
          <span className="font-mono text-[1.75rem] leading-none text-cache tabular-nums">
            {shownShare.toFixed(0)}%
          </span>{' '}
          of them never left this machine. The cache answered {integer(saved)} of{' '}
          {integer(wanted)} — {integer(made)} reached Gemini.
        </p>
      </div>

      {/* One rail, two segments, 2px of surface between them. */}
      <div className="mt-6 flex h-5 w-full gap-0.5" aria-hidden="true">
        {made > 0 && (
          <motion.div
            className="first:rounded-l-[4px] last:rounded-r-[4px]"
            style={{ backgroundColor: KIND_INK.generate }}
            initial={false}
            animate={{ width: `${madePct}%` }}
            transition={transition(reduce, 0.45)}
          />
        )}
        {saved > 0 && (
          <motion.div
            className="rounded-r-[4px] bg-cache first:rounded-l-[4px]"
            initial={false}
            animate={{ width: `${savedPct}%` }}
            transition={transition(reduce, 0.45)}
          />
        )}
        {wanted === 0 && <div className="w-full rounded-[4px] bg-ink-750" />}
      </div>

      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
        <span className="inline-flex items-baseline gap-1.5 font-mono text-2xs uppercase tracking-micro text-paper-mute">
          <span
            className="translate-y-[-1px] inline-block h-1.5 w-1.5 rounded-[1px]"
            style={{ backgroundColor: KIND_INK.generate }}
            aria-hidden="true"
          />
          made
          <span className="text-[13px] tabular-nums tracking-normal text-paper">
            {integer(made)}
          </span>
        </span>

        <span className="inline-flex items-baseline gap-1.5 font-mono text-2xs uppercase tracking-micro text-paper-mute">
          <span
            className="translate-y-[-1px] inline-block h-1.5 w-1.5 rounded-[1px] bg-cache"
            aria-hidden="true"
          />
          prevented
          <span className="text-[13px] tabular-nums tracking-normal text-cache">
            {integer(saved)}
          </span>
        </span>

        {totals.failed_calls > 0 && (
          <span
            className="inline-flex items-baseline gap-1.5 font-mono text-2xs uppercase tracking-micro text-paper-mute"
            title="Counted inside “made” — the request left, the API rejected it."
          >
            <span
              className="translate-y-[-1px] inline-block h-1.5 w-1.5 rounded-[1px] bg-alert"
              aria-hidden="true"
            />
            failed
            <span className="text-[13px] tabular-nums tracking-normal text-alert">
              {integer(totals.failed_calls)}
            </span>
          </span>
        )}

        <span className="ml-auto font-mono text-2xs tabular-nums text-paper-faint">
          {KIND_ORDER.filter((k) => cache.saved_api_calls[k] > 0)
            .map((k) => `${cache.saved_api_calls[k]} ${KIND_LABEL[k]}`)
            .join(' · ') || 'no calls prevented yet'}
        </span>
      </div>
    </section>
  );
}
