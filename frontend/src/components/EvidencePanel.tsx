import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, FileSearch } from 'lucide-react';
import type { Citation } from '../types';
import { formatPct } from '../lib/format';
import { stagger, transition } from '../lib/motion';
import CitationCard from './CitationCard';

/**
 * The evidence behind the answer, folded away.
 *
 * Five chunks run to ~5,000 characters between them. Shown by default they
 * bury the thing the reader asked for, so the default is one line: how many
 * sources, how close the best one was, and which file they came from. That
 * line is enough to judge whether the answer is worth trusting; the cards
 * behind it are for when it isn't.
 */
export default function EvidencePanel({
  citations,
  turnId,
  open,
  onToggle,
  highlight,
  jumpTarget,
  onOpenDocument,
}: {
  citations: Citation[];
  turnId: string;
  open: boolean;
  onToggle: (next: boolean) => void;
  highlight: number | null;
  /** `{ n, seq }` of the citation the reader just clicked; `seq` re-fires repeats. */
  jumpTarget: { n: number; seq: number } | null;
  onOpenDocument: (documentId: number) => void;
}) {
  const reduce = useReducedMotion() ?? false;

  if (citations.length === 0) {
    return (
      <p className="text-[12px] text-paper-faint">
        Nothing in the corpus cleared the similarity floor, so this answer has no sources.
      </p>
    );
  }

  const top = Math.max(...citations.map((c) => c.similarity));
  const files = Array.from(new Set(citations.map((c) => c.filename)));
  const fileLabel = files.length === 1 ? files[0] : `${files[0]} +${files.length - 1} more`;
  const bodyId = `evidence-${turnId}`;

  return (
    <section aria-label="Retrieved sources">
      {/* One quiet line by default. It says enough to judge whether the answer
          is worth trusting; the cards behind it are for when it isn't. */}
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        className={[
          'group -ml-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left',
          'text-[12px] transition-colors duration-150 hover:bg-ink-850',
          open ? 'text-paper-mute' : 'text-paper-faint hover:text-paper-mute',
        ].join(' ')}
      >
        <motion.span
          aria-hidden="true"
          className="block shrink-0"
          animate={{ rotate: open ? 90 : 0 }}
          transition={transition(reduce, 0.18)}
        >
          <ChevronRight size={12} />
        </motion.span>

        <FileSearch size={12} strokeWidth={2.2} className="shrink-0 text-signal/70" />

        <span className="min-w-0 flex-1 truncate tabular-nums">
          {citations.length} source{citations.length === 1 ? '' : 's'}
          <span className="mx-1.5">·</span>
          top match <span className="text-paper-dim">{formatPct(top)}</span>
          <span className="mx-1.5">·</span>
          <span className="text-paper-mute">{fileLabel}</span>
        </span>

        <span className="hidden shrink-0 opacity-0 transition-opacity group-hover:opacity-100 sm:inline">
          {open ? 'hide' : 'check them'}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={bodyId}
            key="cards"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition(reduce, 0.24)}
            className="overflow-hidden"
          >
            <motion.ul
              variants={stagger(reduce)}
              initial="hidden"
              animate="show"
              className="mt-1.5 space-y-2"
            >
              {citations.map((c) => (
                <CitationCard
                  key={`${c.chunk_id}-${c.n}`}
                  citation={c}
                  anchorId={`cite-${turnId}-${c.n}`}
                  highlighted={highlight === c.n}
                  expandSignal={jumpTarget && jumpTarget.n === c.n ? jumpTarget.seq : 0}
                  onOpenDocument={onOpenDocument}
                />
              ))}
            </motion.ul>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
