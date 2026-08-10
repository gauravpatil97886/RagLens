import { motion, useReducedMotion } from 'framer-motion';
import { CornerDownLeft, Repeat2 } from 'lucide-react';
import type { DocumentMeta } from '../types';
import { stagger, rise, transition } from '../lib/motion';

/**
 * The thesis, stated once. Everything below it in the app is the evidence.
 */
export default function EmptyState({
  documents,
  onPick,
}: {
  documents: DocumentMeta[];
  onPick: (question: string) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const ready = documents.filter((d) => d.status === 'ready');
  const first = ready[0];

  const suggestions = first
    ? [
        `Summarise ${first.filename} in five bullet points.`,
        'What are the key dates, deadlines, or time limits mentioned?',
        'Which sections deal with costs, fees, or payment?',
      ]
    : [];

  return (
    <div className="flex min-h-full flex-col justify-center px-4 py-10 sm:px-8">
      <motion.div
        variants={stagger(reduce, 0.06)}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-[46rem]"
      >
        <motion.p variants={rise(reduce)} className="eyebrow">
          retrieval-augmented generation
        </motion.p>

        <motion.h1
          variants={rise(reduce)}
          className="mt-3 font-serif text-[2rem] leading-[1.18] text-paper sm:text-[2.6rem]"
        >
          Most demos show you the answer.
          <br />
          <span className="text-signal">This one shows you the retrieval.</span>
        </motion.h1>

        <motion.p
          variants={rise(reduce)}
          className="mt-4 max-w-[38rem] font-serif text-[15px] leading-[1.7] text-paper-dim"
        >
          Every question is embedded, checked against a semantic cache, matched against your
          chunks, and only then sent to a model. Each of those four steps is drawn on the
          timing rail under the answer, with the exact chunks that were retrieved above it.
        </motion.p>

        {ready.length === 0 ? (
          <motion.div
            variants={rise(reduce)}
            className="mt-8 rounded-xl border border-dashed border-line-strong bg-ink-850 px-5 py-5"
          >
            <p className="font-mono text-2xs uppercase tracking-micro text-signal">start here</p>
            <p className="mt-2 text-[14.5px] leading-relaxed text-paper-dim">
              Drop a PDF, Word file, Markdown, or plain text into the corpus panel. Ingestion
              runs on upload — you'll see the chunk count as soon as it lands.
            </p>
          </motion.div>
        ) : (
          <>
            <motion.p variants={rise(reduce)} className="eyebrow mt-9">
              try one
            </motion.p>
            <motion.ul variants={stagger(reduce)} className="mt-3 space-y-2">
              {suggestions.map((q) => (
                <motion.li key={q} variants={rise(reduce, 6)}>
                  <button
                    type="button"
                    onClick={() => onPick(q)}
                    className="group flex w-full items-center justify-between gap-4 rounded-lg border border-line
                               bg-ink-850 px-4 py-3 text-left text-[14.5px] text-paper-dim
                               transition-colors duration-150 hover:border-signal/45 hover:bg-ink-800 hover:text-paper"
                  >
                    <span>{q}</span>
                    <CornerDownLeft
                      size={14}
                      className="shrink-0 text-paper-faint transition-colors group-hover:text-signal"
                    />
                  </button>
                </motion.li>
              ))}
            </motion.ul>

            <motion.div
              variants={rise(reduce)}
              transition={transition(reduce)}
              className="mt-6 flex items-start gap-2.5 text-[13.5px] leading-relaxed text-paper-mute"
            >
              <Repeat2 size={15} className="mt-0.5 shrink-0 text-cache" />
              <p>
                Ask the same question twice. The second answer comes back from the cache with
                its generate step at zero — no model call, no cost.
              </p>
            </motion.div>
          </>
        )}
      </motion.div>
    </div>
  );
}
