import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import type { AssistantTurn } from '../types';
import { rise, transition } from '../lib/motion';
import AnswerText from './AnswerText';
import CacheBadge from './CacheBadge';
import EvidencePanel from './EvidencePanel';
import LatencyRail from './LatencyRail';

/**
 * One answer.
 *
 * The answer is the thing that was asked for, so it comes first and it is the
 * largest text on screen. Underneath it, in descending order of how often
 * anyone needs them: the evidence it was built from (one line until you ask),
 * then what the run cost.
 *
 * The pipeline order (cache → retrieve → generate) is still legible — it's the
 * LatencyRail's whole job — but it no longer dictates the reading order, which
 * is what put 5,000 characters of raw PDF above the answer.
 */
export default function AssistantMessage({
  turn,
  onOpenDocument,
}: {
  turn: AssistantTurn;
  onOpenDocument: (documentId: number) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [jumpTarget, setJumpTarget] = useState<{ n: number; seq: number } | null>(null);
  const seqRef = useRef(0);
  const fadeRef = useRef<number | null>(null);

  const citations = turn.citations;

  /** An inline [n] was clicked: open the evidence, scroll to card n, mark it. */
  const jumpToCitation = useCallback(
    (n: number) => {
      if (!citations?.some((c) => c.n === n)) return;
      seqRef.current += 1;
      setEvidenceOpen(true);
      setHighlight(n);
      setJumpTarget({ n, seq: seqRef.current });
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
      fadeRef.current = window.setTimeout(
        () => setHighlight((cur) => (cur === n ? null : cur)),
        2000,
      );
    },
    [citations],
  );

  // The card may not exist yet — the panel is mid-expand — so aim twice: once
  // on the next frame, once after the disclosure has finished opening.
  useEffect(() => {
    if (!jumpTarget) return;
    const scroll = () => {
      document
        .getElementById(`cite-${turn.id}-${jumpTarget.n}`)
        ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    };
    const frame = requestAnimationFrame(scroll);
    const settle = window.setTimeout(scroll, 340);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [jumpTarget, turn.id, reduce]);

  useEffect(() => () => {
    if (fadeRef.current) window.clearTimeout(fadeRef.current);
  }, []);

  const waiting = turn.phase === 'embedding' || turn.phase === 'retrieving';
  const hasAnswer = turn.text.length > 0 || turn.phase === 'generating';

  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition(reduce)}
      className="flex min-w-0 flex-col gap-3 pr-6"
    >
      {/* The answer. Everything else on this turn is a footnote to it. */}
      {hasAnswer && (
        <motion.div variants={rise(reduce)} initial="hidden" animate="show" className="min-w-0 max-w-[46rem]">
          <AnswerText text={turn.text} streaming={turn.phase === 'generating'} onCite={jumpToCitation} />
        </motion.div>
      )}

      {/* Before the first token there is nothing to read, so say what's happening. */}
      {waiting && !hasAnswer && (
        <div className="flex items-center gap-2 font-mono text-2xs uppercase tracking-micro text-paper-mute">
          <span className="animate-breathe">
            {turn.phase === 'embedding' ? 'embedding question' : 'searching chunks'}
          </span>
          <span className="h-px w-8 animate-breathe bg-signal/60" />
        </div>
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

      {/* The evidence, one line deep. Retrieval lands before the first token,
          so this appears immediately — folded, so the answer keeps the room. */}
      {citations && (
        <div className="min-w-0 max-w-[46rem]">
          <EvidencePanel
            citations={citations}
            turnId={turn.id}
            open={evidenceOpen}
            onToggle={setEvidenceOpen}
            highlight={highlight}
            jumpTarget={jumpTarget}
            onOpenDocument={onOpenDocument}
          />
        </div>
      )}

      {/* What the run cost, and where the answer came from. Quiet, and last. */}
      {turn.phase !== 'error' && (
        <div className="max-w-[46rem] border-t border-line-soft pt-2.5">
          {turn.cache && <CacheBadge cache={turn.cache} />}
          <LatencyRail phase={turn.phase} timings={turn.timings} cacheHit={turn.cache?.hit ?? false} />
        </div>
      )}
    </motion.div>
  );
}
