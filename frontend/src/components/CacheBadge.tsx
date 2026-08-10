import { motion, useReducedMotion } from 'framer-motion';
import { Zap, Radar } from 'lucide-react';
import type { CacheInfo } from '../types';
import { formatAge, formatPct } from '../lib/format';
import { reward, transition } from '../lib/motion';

/**
 * Arrives before any token does. An exact hit reads as a solid mint chip;
 * a semantic hit shows the match strength and the question it matched, so
 * you can judge for yourself whether the two questions really are the same.
 * A miss gets one quiet line — present for contrast, never competing.
 */
export default function CacheBadge({ cache }: { cache: CacheInfo }) {
  const reduce = useReducedMotion() ?? false;

  if (!cache.hit) {
    // A miss with a near-match is the most instructive thing the cache does: it
    // shows you the bar, and how far under it the closest question fell.
    const near = cache.nearest;
    const shortfall = near ? cache.threshold - near.similarity : 0;

    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={transition(reduce, 0.2)}
        className="flex max-w-full flex-col gap-1"
      >
        <p className="font-mono text-2xs uppercase tracking-micro text-paper-faint">
          cache miss · generating fresh
        </p>

        {near && (
          <p className="font-mono text-2xs tabular-nums text-paper-mute">
            closest stored question{' '}
            <span className="text-paper-dim">{formatPct(near.similarity, 1)}</span>
            {' · needs '}
            <span className="text-cache-dim">{formatPct(cache.threshold, 0)}</span>
            {' · short by '}
            <span className="text-paper-dim">{formatPct(shortfall, 1)}</span>
          </p>
        )}

        {near && (
          <p className="max-w-prose font-serif text-sm italic leading-snug text-paper-faint">
            “{near.question}”
          </p>
        )}
      </motion.div>
    );
  }

  const exact = cache.kind === 'exact';

  return (
    <motion.div
      initial={{ opacity: 0, scale: reduce ? 1 : 0.94, y: reduce ? 0 : 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={reward(reduce)}
      className="inline-flex max-w-full flex-col gap-1.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-2xs uppercase tracking-micro',
            exact
              ? 'bg-cache text-ink-950'
              : 'border border-cache/45 bg-cache/10 text-cache',
          ].join(' ')}
        >
          {exact ? <Zap size={11} strokeWidth={2.5} /> : <Radar size={11} strokeWidth={2.5} />}
          {exact ? 'cache · exact' : `cache · semantic ${formatPct(cache.similarity ?? 0)}`}
        </span>

        <span className="font-mono text-2xs tabular-nums text-paper-mute">
          stored {formatAge(cache.age_seconds)}
        </span>

        {cache.saved_api_calls > 0 && (
          <span className="font-mono text-2xs tabular-nums text-cache-dim">
            +{cache.saved_api_calls} call{cache.saved_api_calls === 1 ? '' : 's'} saved
          </span>
        )}
      </div>

      {cache.matched_question && (
        <p className="max-w-prose font-serif text-sm italic leading-snug text-paper-dim">
          matched <span className="text-paper">“{cache.matched_question}”</span>
        </p>
      )}
    </motion.div>
  );
}
