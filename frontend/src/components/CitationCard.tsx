import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { Citation } from '../types';
import SimilarityRing from './SimilarityRing';
import { rise, transition } from '../lib/motion';

/**
 * One retrieved chunk, as evidence. Clamped to three lines by default — these
 * run to ~1,200 characters and five of them expanded would bury the answer —
 * but the full text is always one click away, because "trust me, it was
 * relevant" is exactly what this demo exists to disprove.
 *
 * Arriving here from an inline citation opens the chunk automatically: the
 * reader clicked [3] to read source 3, not to be shown its first two lines.
 */
export default function CitationCard({
  citation,
  anchorId,
  highlighted,
  expandSignal,
  onOpenDocument,
}: {
  citation: Citation;
  anchorId: string;
  highlighted: boolean;
  /** Bumped each time an inline citation points at this card. 0 = never. */
  expandSignal?: number;
  onOpenDocument: (documentId: number) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (expandSignal) setOpen(true);
  }, [expandSignal]);

  return (
    <motion.li
      id={anchorId}
      variants={rise(reduce, 6)}
      className={[
        'scroll-mt-24 rounded-lg border bg-ink-850 transition-colors duration-300',
        highlighted ? 'border-signal/70 bg-signal/[0.06]' : 'border-line hover:border-line-strong',
      ].join(' ')}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span
          className={[
            'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-2xs tabular-nums transition-colors duration-300',
            highlighted ? 'bg-signal text-ink-950' : 'bg-ink-700 text-signal',
          ].join(' ')}
          aria-hidden="true"
        >
          {citation.n}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button
              type="button"
              onClick={() => onOpenDocument(citation.document_id)}
              className="truncate text-left text-[13px] text-paper decoration-line-strong underline-offset-4 hover:underline"
              title={`Open all chunks from ${citation.filename}`}
            >
              {citation.filename}
            </button>
            <span className="font-mono text-2xs tabular-nums text-paper-mute">
              chunk {citation.chunk_index}
            </span>
          </div>

          {!open && (
            <p className="mt-1 line-clamp-3 font-serif text-[13px] leading-relaxed text-paper-dim">
              {citation.content}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center pl-1">
          <SimilarityRing value={citation.similarity} />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${anchorId}-body`}
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition(reduce, 0.24)}
            className="overflow-hidden"
          >
            <div className="border-t border-line-soft px-3 py-3">
              <p className="whitespace-pre-wrap font-serif text-[13.5px] leading-relaxed text-paper-dim">
                {citation.content}
              </p>
              <p className="mt-2.5 font-mono text-2xs tabular-nums text-paper-faint">
                {citation.content.length} chars · chunk id {citation.chunk_id} · similarity{' '}
                {citation.similarity.toFixed(4)}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`${anchorId}-body`}
        className="flex w-full items-center gap-1 rounded-b-lg border-t border-line-soft px-3 py-1.5
                   font-mono text-2xs uppercase tracking-micro text-paper-faint
                   transition-colors duration-150 hover:bg-ink-800 hover:text-paper-dim"
      >
        <motion.span
          className="block"
          animate={{ rotate: open ? 90 : 0 }}
          transition={transition(reduce, 0.18)}
        >
          <ChevronRight size={11} />
        </motion.span>
        {open ? 'collapse chunk' : 'show full chunk'}
      </button>
    </motion.li>
  );
}
