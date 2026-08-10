import { motion, useReducedMotion } from 'framer-motion';
import type { Phase } from '../types';

/**
 * The house mark: a long marigold pill and a short mint one — retrieval, then
 * cache. It is the latency rail compressed to two strokes, and it is the only
 * piece of decoration in the app that appears more than once.
 */
export function Mark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-[3px] ${className}`} aria-hidden="true">
      <span className="h-[5px] w-[15px] rounded-full bg-signal" />
      <span className="h-[5px] w-[9px] rounded-full bg-cache" />
    </span>
  );
}

/**
 * The marker beside every answer, and the one place in the conversation where
 * motion is spent.
 *
 * It is not an avatar: it reports the run. While the stream is open it carries a
 * marigold ring that breathes; when the answer came back from the cache it fills
 * mint, because the model genuinely was never called; a failed run goes coral.
 * Every state here is read off the stream — nothing is on a timer.
 */
export function AnswerMark({
  phase,
  cacheHit,
}: {
  phase: Phase;
  cacheHit: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const running = phase !== 'done' && phase !== 'error';
  const failed = phase === 'error';

  const shell = failed
    ? 'border-alert/45 bg-alert/10'
    : cacheHit && !running
      ? 'border-cache/45 bg-cache/10'
      : running
        ? 'border-signal/45 bg-signal/[0.08]'
        : 'border-line bg-ink-850';

  const label = failed
    ? 'This run failed'
    : running
      ? 'Answering'
      : cacheHit
        ? 'This answer came back from the cache'
        : 'Answered by the model';

  return (
    <span className="relative flex h-7 w-7 shrink-0 items-center justify-center" title={label}>
      {running && !reduce && (
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 rounded-[0.6rem] border border-signal/60"
          animate={{ opacity: [0.75, 0.15, 0.75], scale: [1, 1.14, 1] }}
          transition={{ duration: 1.9, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <span
        className={`relative flex h-7 w-7 items-center justify-center rounded-[0.6rem] border transition-colors duration-300 ${shell}`}
      >
        <Mark className="scale-[0.72]" />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
