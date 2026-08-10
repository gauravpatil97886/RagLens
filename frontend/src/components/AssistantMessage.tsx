import { useCallback, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, FileSearch } from 'lucide-react';
import type { AssistantTurn } from '../types';
import { formatPct } from '../lib/format';
import { rise, stagger, transition } from '../lib/motion';
import AnswerText from './AnswerText';
import CacheBadge from './CacheBadge';
import CitationCard from './CitationCard';
import LatencyRail from './LatencyRail';

/**
 * One answer, in the order the pipeline produced it:
 *   cache verdict → retrieved sources → generated text → what it cost.
 * The reading order is the execution order. That's the entire teaching claim
 * of this layout, so nothing is allowed to jump the queue.
 */
export default function AssistantMessage({
  turn,
  onOpenDocument,
}: {
  turn: AssistantTurn;
  onOpenDocument: (documentId: number) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [highlight, setHighlight] = useState<number | null>(null);

  const jumpToCitation = useCallback(
    (n: number) => {
      const el = document.getElementById(`cite-${turn.id}-${n}`);
      if (!el) return;
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      setHighlight(n);
      window.setTimeout(() => setHighlight((cur) => (cur === n ? null : cur)), 1600);
    },
    [turn.id, reduce],
  );

  const citations = turn.citations;
  const waiting = turn.phase === 'embedding' || turn.phase === 'retrieving';
  const topScore = citations && citations.length > 0 ? Math.max(...citations.map((c) => c.similarity)) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition(reduce)}
      className="flex flex-col gap-3 pr-6"
    >
      {/* Stage 1 — the cache verdict, before anything is generated. */}
      {turn.cache && <CacheBadge cache={turn.cache} />}

      {/* Stage 2 — what retrieval actually found. */}
      {waiting && !citations && (
        <div className="flex items-center gap-2 font-mono text-2xs uppercase tracking-micro text-paper-mute">
          <span className="animate-breathe">
            {turn.phase === 'embedding' ? 'embedding question' : 'searching chunks'}
          </span>
          <span className="h-px w-8 animate-breathe bg-signal/60" />
        </div>
      )}

      {citations && (
        <section aria-label="Retrieved sources">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5">
            <span className="inline-flex items-center gap-1.5 font-mono text-2xs uppercase tracking-micro text-signal">
              <FileSearch size={11} strokeWidth={2.5} />
              retrieved
            </span>
            <span className="font-mono text-2xs tabular-nums text-paper-mute">
              {citations.length === 0
                ? 'nothing above the similarity floor'
                : `${citations.length} chunk${citations.length === 1 ? '' : 's'}`}
            </span>
            {topScore !== null && (
              <span className="font-mono text-2xs tabular-nums text-paper-faint">
                top {formatPct(topScore)}
              </span>
            )}
          </div>

          {citations.length > 0 && (
            <motion.ul
              variants={stagger(reduce)}
              initial="hidden"
              animate="show"
              className="space-y-1.5"
            >
              {citations.map((c) => (
                <CitationCard
                  key={`${c.chunk_id}-${c.n}`}
                  citation={c}
                  anchorId={`cite-${turn.id}-${c.n}`}
                  highlighted={highlight === c.n}
                  onOpenDocument={onOpenDocument}
                />
              ))}
            </motion.ul>
          )}
        </section>
      )}

      {/* Stage 3 — the generated answer. */}
      {(turn.text.length > 0 || turn.phase === 'generating') && (
        <motion.div variants={rise(reduce)} initial="hidden" animate="show" className="max-w-[46rem]">
          <AnswerText
            text={turn.text}
            streaming={turn.phase === 'generating'}
            onCite={jumpToCitation}
          />
        </motion.div>
      )}

      {turn.phase === 'error' && turn.error && (
        <div className="flex max-w-[46rem] items-start gap-2.5 rounded-lg border border-alert/40 bg-alert/[0.07] px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-alert" />
          <div>
            <p className="font-mono text-2xs uppercase tracking-micro text-alert">answer failed</p>
            <p className="mt-1 text-[13.5px] leading-relaxed text-paper-dim">{turn.error}</p>
          </div>
        </div>
      )}

      {/* Stage 4 — what it cost. */}
      {turn.phase !== 'error' && (
        <div className="max-w-[46rem]">
          <LatencyRail phase={turn.phase} timings={turn.timings} cacheHit={turn.cache?.hit ?? false} />
        </div>
      )}
    </motion.div>
  );
}
