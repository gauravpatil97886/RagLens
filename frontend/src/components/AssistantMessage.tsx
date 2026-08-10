import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { AssistantTurn } from '../types';
import { rise, stageEnter, transition } from '../lib/motion';
import AnswerMeta from './AnswerMeta';
import AnswerText from './AnswerText';
import { collectTerms, TermStrip } from './AnswerBlocks';
import CopyButton from './CopyButton';
import EvidencePanel from './EvidencePanel';
import { AnswerMark } from './Mark';

/**
 * One answer.
 *
 * Not a bubble. A bubble is the right shape for a sentence you typed and the
 * wrong shape for six paragraphs you have to read — so the answer runs the full
 * width of the reading column with a marker in the margin, and everything the
 * run produced besides the prose folds away underneath it: the evidence behind
 * one quiet line, the cost behind another.
 *
 * The pipeline order (cache → retrieve → generate) is still legible — it is the
 * timing rail's whole job — but it lives one click down now instead of
 * competing with the sentence you came here to read.
 */
export default function AssistantMessage({
  turn,
  isLast,
  onOpenDocument,
  onAskTerm,
  onAskAgain,
}: {
  turn: AssistantTurn;
  /** The newest turn keeps its controls visible; older ones reveal on hover. */
  isLast: boolean;
  onOpenDocument: (documentId: number) => void;
  /** Clicking a key term asks about it — omit to render the terms as plain chips. */
  onAskTerm?: (term: string) => void;
  /** Re-run this question. Omitted while another run is in flight. */
  onAskAgain?: (question: string) => void;
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

  useEffect(
    () => () => {
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
    },
    [],
  );

  const waiting = turn.phase === 'embedding' || turn.phase === 'retrieving';
  const hasAnswer = turn.text.length > 0 || turn.phase === 'generating';
  const settled = turn.phase === 'done';

  // The terms the answer put weight on. Recomputed only when the text settles,
  // never on every streamed token.
  const terms = useMemo(() => (settled ? collectTerms(turn.text) : []), [settled, turn.text]);

  const controls = settled && (
    <div
      className={[
        'flex items-center gap-0.5 transition-opacity duration-150',
        isLast ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover/turn:opacity-100',
      ].join(' ')}
    >
      {turn.text.length > 0 && <CopyButton text={turn.text} label="Copy" />}
      {onAskAgain && (
        <button
          type="button"
          onClick={() => onAskAgain(turn.question)}
          className="btn-ghost"
          title="Run the same question again. A second run usually comes straight back from the cache."
        >
          <RotateCcw size={13} />
          Ask again
        </button>
      )}
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition(reduce)}
      className="group/turn flex min-w-0 gap-3.5"
    >
      <AnswerMark phase={turn.phase} cacheHit={turn.cache?.hit ?? false} />

      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
        {/* The answer. Everything else on this turn is a footnote to it. */}
        {hasAnswer && (
          <motion.div variants={rise(reduce)} initial="hidden" animate="show" className="min-w-0">
            <AnswerText
              text={turn.text}
              streaming={turn.phase === 'generating'}
              onCite={jumpToCitation}
            />
          </motion.div>
        )}

        {/* Before the first token there is nothing to read, so say what is
            happening. The step names are the pipeline's own, in order, so the
            wait reads as progress through a known sequence rather than an
            indefinite spinner. */}
        {waiting && !hasAnswer && (
          <div className="flex items-center gap-2.5 py-1 text-[13px] text-paper-mute">
            <span>{turn.phase === 'embedding' ? 'Embedding your question' : 'Searching the chunks'}</span>
            <span className="relative h-[3px] w-16 overflow-hidden rounded-full bg-ink-750">
              <span className="absolute inset-y-0 left-0 w-1/2 animate-sweep rounded-full bg-signal" />
            </span>
          </div>
        )}

        {turn.phase === 'error' && turn.error && (
          <motion.div
            {...stageEnter(reduce, 0)}
            className="flex items-start gap-2.5 rounded-xl border border-alert/35 bg-alert/[0.07] px-3.5 py-3"
          >
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-alert" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-alert">That answer didn't finish</p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-paper-dim">{turn.error}</p>
              {onAskAgain && (
                <button
                  type="button"
                  onClick={() => onAskAgain(turn.question)}
                  className="btn-ghost mt-2 -ml-2"
                >
                  <RotateCcw size={13} />
                  Try again
                </button>
              )}
            </div>
          </motion.div>
        )}

        {terms.length > 0 && <TermStrip terms={terms} onAsk={onAskTerm} />}

        {/* The evidence, one line deep. Retrieval lands before the first token,
            so this appears immediately — folded, so the answer keeps the room. */}
        {citations && (
          <EvidencePanel
            citations={citations}
            turnId={turn.id}
            open={evidenceOpen}
            onToggle={setEvidenceOpen}
            highlight={highlight}
            jumpTarget={jumpTarget}
            onOpenDocument={onOpenDocument}
          />
        )}

        {/* What the run cost, and who wrote it. Quiet, and last. */}
        {turn.phase !== 'error' && (
          <AnswerMeta
            phase={turn.phase}
            timings={turn.timings}
            cache={turn.cache}
            model={turn.model}
            actions={controls}
          />
        )}
      </div>
    </motion.div>
  );
}
