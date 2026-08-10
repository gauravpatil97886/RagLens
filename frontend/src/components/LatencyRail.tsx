import { motion, useReducedMotion } from 'framer-motion';
import type { Phase, Timings } from '../types';
import { formatMs } from '../lib/format';
import { DUR, EASE, transition } from '../lib/motion';

/**
 * The signature instrument.
 *
 * While a question is in flight it fills left to right, one segment per
 * pipeline stage, so the order (embed → cache lookup → retrieve → generate)
 * is something you watch happen rather than something you're told.
 * When `done` arrives it snaps to the real proportions from timings_ms.
 *
 * On a cache hit `generate` is 0, and the segment collapses to a dashed void.
 * That gap is the whole argument for the cache, so it is drawn, not omitted.
 */

type SegmentKey = 'embed' | 'cache_lookup' | 'retrieve' | 'generate';

interface Segment {
  key: SegmentKey;
  label: string;
  /** Tailwind background for the filled bar. */
  fill: string;
  dot: string;
}

const SEGMENTS: Segment[] = [
  { key: 'embed', label: 'embed', fill: 'bg-paper-faint', dot: 'bg-paper-faint' },
  { key: 'cache_lookup', label: 'cache', fill: 'bg-cache-dim', dot: 'bg-cache-dim' },
  { key: 'retrieve', label: 'retrieve', fill: 'bg-signal-dim', dot: 'bg-signal-dim' },
  { key: 'generate', label: 'generate', fill: 'bg-signal', dot: 'bg-signal' },
];

/** Which segment is lit while we're still waiting on the server. */
function liveState(phase: Phase, key: SegmentKey): 'done' | 'active' | 'pending' {
  const order: SegmentKey[] = ['embed', 'cache_lookup', 'retrieve', 'generate'];
  const activeIndex =
    phase === 'embedding' ? 0 : phase === 'retrieving' ? 2 : phase === 'generating' ? 3 : 4;
  const index = order.indexOf(key);
  // The cache lookup rides along with retrieval — it's sub-10ms in practice.
  if (phase === 'retrieving' && key === 'cache_lookup') return 'active';
  if (index < activeIndex) return 'done';
  if (index === activeIndex) return 'active';
  return 'pending';
}

interface Props {
  phase: Phase;
  timings: Timings | null;
  cacheHit: boolean;
}

export default function LatencyRail({ phase, timings, cacheHit }: Props) {
  const reduce = useReducedMotion() ?? false;
  const settled = timings !== null;

  // Proportional widths, with a floor so a 4ms stage stays visible.
  const total = timings ? Math.max(1, timings.total) : 1;
  const widthFor = (key: SegmentKey, state: 'done' | 'active' | 'pending'): number => {
    if (timings) {
      const value = timings[key];
      if (value <= 0) return 0;
      return Math.max(3, (value / total) * 100);
    }
    // Live: the rail is deliberately short of full — the run isn't over yet.
    return state === 'done' ? 24 : state === 'active' ? 30 : 8;
  };

  /**
   * When the run settles, the segments take their true widths one after another,
   * left to right, in the order the pipeline ran them. Four independent tweens
   * firing at once would say "these numbers changed"; a sequence says "this is
   * what happened, in this order". The whole settle lands inside 400ms.
   */
  const settleDelay = (index: number) => (settled && !reduce ? index * 0.045 : 0);

  return (
    <div className="mt-3">
      <div
        className="flex h-2 w-full items-stretch gap-px overflow-hidden rounded-full bg-ink-750"
        role="img"
        aria-label={
          timings
            ? `Timing breakdown: embed ${timings.embed} ms, cache lookup ${timings.cache_lookup} ms, retrieve ${timings.retrieve} ms, generate ${timings.generate} ms, total ${timings.total} ms.`
            : 'Timing breakdown, in progress.'
        }
      >
        {SEGMENTS.map((seg, i) => {
          const value = timings ? timings[seg.key] : null;
          const isVoid = settled && value === 0;
          const state = settled ? 'done' : liveState(phase, seg.key);

          if (isVoid) {
            // A zero-length stage still occupies the rail, as an empty slot.
            return (
              <motion.div
                key={seg.key}
                initial={false}
                animate={{ opacity: 1 }}
                transition={{ delay: settleDelay(i), duration: reduce ? 0.001 : DUR.fast }}
                className="relative w-6 shrink-0 rounded-full border border-dashed border-cache/50"
                title={`${seg.label} skipped — served from cache`}
              />
            );
          }

          return (
            <motion.div
              key={seg.key}
              className={[
                'relative h-full overflow-hidden rounded-full',
                state === 'pending' ? 'bg-ink-700' : seg.fill,
                state === 'pending' ? 'opacity-50' : '',
              ].join(' ')}
              initial={false}
              animate={{
                width: `${widthFor(seg.key, state)}%`,
                opacity: state === 'pending' ? 0.35 : 1,
              }}
              transition={
                reduce
                  ? { duration: 0.001 }
                  : { duration: settled ? 0.26 : 0.3, ease: EASE, delay: settleDelay(i) }
              }
            >
              {state === 'active' && !reduce && (
                <span className="absolute inset-y-0 left-0 w-1/2 animate-sweep bg-gradient-to-r from-transparent via-white/50 to-transparent" />
              )}
            </motion.div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1">
        {SEGMENTS.map((seg, i) => {
          const value = timings ? timings[seg.key] : null;
          const zeroed = value === 0;
          return (
            <motion.span
              key={seg.key}
              initial={false}
              animate={{ opacity: settled || value !== null ? 1 : 0.55 }}
              transition={{ delay: settleDelay(i), duration: reduce ? 0.001 : DUR.fast }}
              className={[
                'inline-flex items-center gap-1.5 font-mono text-2xs tabular-nums',
                zeroed ? 'text-cache' : 'text-paper-mute',
              ].join(' ')}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${zeroed ? 'bg-cache' : seg.dot}`} />
              {seg.label}
              <span className={zeroed ? 'text-cache' : 'text-paper-dim'}>
                {value === null ? '··' : `${value}`}
              </span>
            </motion.span>
          );
        })}

        <span className="ml-auto font-mono text-2xs tabular-nums text-paper-dim">
          {timings ? (
            <>
              total <span className="text-paper">{formatMs(timings.total)}</span>
            </>
          ) : (
            <span className="animate-breathe">measuring…</span>
          )}
        </span>
      </div>

      {settled && cacheHit && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={transition(reduce, 0.3)}
          className="mt-1.5 font-mono text-2xs text-cache-dim"
        >
          generate skipped — the model was never called
        </motion.p>
      )}
    </div>
  );
}
