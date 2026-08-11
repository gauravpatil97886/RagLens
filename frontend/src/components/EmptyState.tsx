import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Repeat2, Upload } from 'lucide-react';
import type { DocumentMeta, Stats } from '../types';
import { stagger, rise } from '../lib/motion';
import { formatPct } from '../lib/format';
import { Mark } from './Mark';

/**
 * The resting state of the conversation.
 *
 * It says what this thing is in one sentence, offers three questions built from
 * the documents that are actually loaded, and draws the corpus to scale so the
 * search space is a visible size rather than a claim. Then it gets out of the
 * way — the first question is meant to be typed within a few seconds of landing.
 */

/** The corpus, drawn as the search space it is. One bar per document, to scale. */
function SearchSpace({
  documents,
  stats,
  reduce,
}: {
  documents: DocumentMeta[];
  stats: Stats | null;
  reduce: boolean;
}) {
  const total = documents.reduce((sum, d) => sum + d.n_chunks, 0);
  const largest = Math.max(1, ...documents.map((d) => d.n_chunks));

  return (
    <div className="rounded-2xl border border-line bg-ink-850/70 px-4 py-3.5 shadow-inset">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[12.5px] font-medium text-paper-dim">What can be searched</h2>
        <span className="font-mono text-[11.5px] tabular-nums text-paper-faint">
          {total} chunks
        </span>
      </div>

      <ul className="mt-3 space-y-2.5">
        {documents.map((doc, i) => (
          <motion.li
            key={doc.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduce ? { duration: 0.001 } : { duration: 0.22, delay: 0.08 + i * 0.05 }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[12.5px] text-paper-dim" title={doc.filename}>
                {doc.filename}
              </span>
              <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-paper-faint">
                {doc.n_chunks}
              </span>
            </div>
            {/* Width is chunk count against the largest document — a real ratio. */}
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-ink-750">
              <motion.div
                className="h-full rounded-full bg-signal-dim"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: doc.n_chunks / largest }}
                style={{ transformOrigin: 'left' }}
                transition={
                  reduce
                    ? { duration: 0.001 }
                    : { duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.12 + i * 0.05 }
                }
              />
            </div>
          </motion.li>
        ))}
      </ul>

      {stats && stats.cache_entries > 0 && (
        <p className="mt-3 border-t border-line-soft pt-2.5 font-mono text-[11.5px] tabular-nums text-cache-dim">
          {stats.cache_entries} answers stored · {formatPct(stats.hit_rate, 0)} of questions reused one
        </p>
      )}
    </div>
  );
}

export default function EmptyState({
  documents,
  stats,
  onPick,
  onAddDocument,
}: {
  documents: DocumentMeta[];
  stats: Stats | null;
  /** Puts the question in the composer. It is not sent until you press Enter. */
  onPick: (question: string) => void;
  /** Opens the upload dialog. */
  onAddDocument: () => void;
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
    <div className="flex min-h-full flex-col justify-center px-4 py-12 sm:px-6">
      <motion.div
        variants={stagger(reduce, 0.06)}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-[47rem]"
      >
        <motion.div variants={rise(reduce)} className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[12.5px] text-paper-mute">Retrieval-augmented generation</span>
        </motion.div>

        <motion.h1
          variants={rise(reduce)}
          className="mt-4 text-[1.9rem] font-semibold leading-[1.18] tracking-[-0.022em] text-paper sm:text-[2.15rem]"
        >
          Most demos show you the answer.
          <br />
          <span className="text-signal">This one shows you the retrieval.</span>
        </motion.h1>

        <motion.p
          variants={rise(reduce)}
          className="mt-3.5 max-w-[36rem] text-[14.5px] leading-[1.65] text-paper-dim"
        >
          Every question is embedded, checked against a semantic cache, matched against your chunks,
          and only then sent to a model. Each answer carries the exact passages it was written from
          and what the run cost.
        </motion.p>

        {ready.length === 0 ? (
          <motion.div
            variants={rise(reduce)}
            className="mt-8 flex items-start gap-3 rounded-2xl border border-dashed border-line-strong bg-ink-850 px-5 py-5"
          >
            <Upload size={16} className="mt-0.5 shrink-0 text-signal" />
            <div>
              <p className="text-[14px] font-medium text-paper">Add a document to begin</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-paper-dim">
                Drop a PDF, Word file, Markdown, or plain text anywhere on this window. You get a
                reading of what indexing it costs — chunks, API calls, tokens — before anything is
                sent to a model.
              </p>
              <button type="button" onClick={onAddDocument} className="btn-solid mt-3">
                Add a document
              </button>
            </div>
          </motion.div>
        ) : (
          <>
            <motion.ul variants={stagger(reduce)} className="mt-8 space-y-2">
              {suggestions.map((q) => (
                <motion.li key={q} variants={rise(reduce, 6)}>
                  <button
                    type="button"
                    onClick={() => onPick(q)}
                    title="Puts this in the box — press Enter to ask it"
                    className="group flex w-full items-center justify-between gap-4 rounded-2xl border border-line
                               bg-ink-850 px-4 py-3 text-left text-[14px] text-paper-dim shadow-inset
                               transition-[color,border-color,background-color,transform] duration-150
                               hover:-translate-y-px hover:border-signal/40 hover:bg-ink-800 hover:text-paper"
                  >
                    <span>{q}</span>
                    <ArrowUpRight
                      size={15}
                      className="shrink-0 text-paper-faint transition-colors group-hover:text-signal"
                    />
                  </button>
                </motion.li>
              ))}
            </motion.ul>

            <motion.div
              variants={rise(reduce)}
              className="mt-5 flex items-start gap-2.5 text-[13px] leading-relaxed text-paper-mute"
            >
              <Repeat2 size={15} className="mt-0.5 shrink-0 text-cache" />
              <p>
                Ask the same question twice. The second answer comes back from the cache with its
                generate step at zero — no model call, no cost.
              </p>
            </motion.div>

            <motion.div variants={rise(reduce)} className="mt-8">
              <SearchSpace documents={ready} stats={stats} reduce={reduce} />
            </motion.div>
          </>
        )}
      </motion.div>
    </div>
  );
}
