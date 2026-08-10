import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, AlertTriangle } from 'lucide-react';
import type { UploadTask } from '../types';
import { formatBytes, formatMs, truncateMiddle } from '../lib/format';
import { transition } from '../lib/motion';

/**
 * Live ingestion. Every line here is a frame the server actually sent — the stage
 * ticks when the stage finished, chunks appear as the splitter emits them, and the
 * bar is `done/total` embeddings, not a timer. Nothing is interpolated, so an instant
 * stage looks instant.
 */

/** Where each server stage sits in the four-step pipeline, and whether it ends it. */
const STEP_OF: Record<UploadTask['stage'], { index: number; complete: boolean }> = {
  queued: { index: 0, complete: false },
  extracting: { index: 0, complete: false },
  extracted: { index: 0, complete: true },
  chunking: { index: 1, complete: false },
  chunked: { index: 1, complete: true },
  embedding: { index: 2, complete: false },
  indexing: { index: 3, complete: false },
  done: { index: 3, complete: true },
};

const STEPS = ['extracting text', 'splitting into chunks', 'embedding chunks', 'writing vectors'];

/** The newest few chunks. Older ones scroll off — the count is the honest total. */
const TILES = 3;

export default function IngestCard({ task, onDismiss }: { task: UploadTask; onDismiss: (id: string) => void }) {
  const reduce = useReducedMotion() ?? false;
  const [elapsed, setElapsed] = useState(() => Date.now() - task.startedAt);

  const failed = task.error !== null;

  useEffect(() => {
    if (failed) return;
    const timer = window.setInterval(() => setElapsed(Date.now() - task.startedAt), 180);
    return () => window.clearInterval(timer);
  }, [task.startedAt, failed]);

  const step = STEP_OF[task.stage];
  // The first step a tick hasn't reached yet: everything before it really is finished.
  const settled = step.complete ? step.index + 1 : step.index;
  const embed = task.embed;
  const ratio = embed && embed.total > 0 ? embed.done / embed.total : 0;

  const measure = [
    task.nChars === null ? null : `${task.nChars.toLocaleString()} chars`,
    task.nChunks === null ? (task.nChunksSeen > 0 ? `${task.nChunksSeen}…` : null) : `${task.nChunks} chunks`,
    embed ? `${embed.done}/${embed.total}` : null,
    null,
  ];

  return (
    <motion.li
      layout={!reduce}
      initial={{ opacity: 0, y: reduce ? 0 : -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={transition(reduce)}
      className={[
        'overflow-hidden rounded-lg border px-3 py-2.5',
        failed ? 'border-alert/40 bg-alert/[0.06]' : 'border-signal/30 bg-signal/[0.04]',
      ].join(' ')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] text-paper" title={task.filename}>
          {truncateMiddle(task.filename, 24)}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-paper-faint">
          {formatBytes(task.size)}
        </span>
      </div>

      {failed ? (
        <div className="mt-2 flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-alert" />
          <div className="min-w-0 flex-1">
            <p className="text-2xs leading-relaxed text-paper-dim">{task.error}</p>
            <button
              type="button"
              onClick={() => onDismiss(task.id)}
              className="mt-1.5 font-mono text-2xs uppercase tracking-micro text-paper-mute hover:text-paper"
            >
              dismiss
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* The server's own words, for anyone listening rather than looking. */}
          <span className="sr-only" aria-live="polite">
            {task.label}
          </span>

          <ul className="mt-2 space-y-1">
            {STEPS.map((label, i) => {
              const state = i < settled ? 'done' : i === settled ? 'active' : 'pending';
              return (
                <li
                  key={label}
                  className={[
                    'flex items-center gap-2 font-mono text-2xs',
                    state === 'active' ? 'text-signal' : state === 'done' ? 'text-paper-mute' : 'text-paper-faint',
                  ].join(' ')}
                >
                  <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                    {state === 'done' ? (
                      <Check size={10} strokeWidth={3} />
                    ) : state === 'active' ? (
                      <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-signal" />
                    ) : (
                      <span className="h-1 w-1 rounded-full bg-paper-faint/60" />
                    )}
                  </span>
                  <span className="flex-1 truncate">{label}</span>
                  {measure[i] && (
                    <span className="shrink-0 tabular-nums text-paper-mute">{measure[i]}</span>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Chunks, materialising one frame at a time. */}
          <AnimatePresence initial={false}>
            {task.chunks.length > 0 && (
              <motion.ul
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transition(reduce, 0.15)}
                className="mt-2 space-y-1 border-l border-line-strong pl-2"
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {task.chunks.slice(-TILES).map((chunk) => (
                    <motion.li
                      key={chunk.index}
                      layout={!reduce}
                      initial={{ opacity: 0, x: reduce ? 0 : -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      transition={transition(reduce, 0.15)}
                      className="flex items-baseline gap-1.5 font-mono text-2xs"
                    >
                      <span className="shrink-0 tabular-nums text-signal-dim">
                        {String(chunk.index).padStart(2, '0')}
                      </span>
                      <span className="flex-1 truncate text-paper-faint">{chunk.preview}</span>
                      <span className="shrink-0 tabular-nums text-paper-faint">{chunk.nChars}c</span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </motion.ul>
            )}
          </AnimatePresence>

          {/* Embedding: a real determinate bar, plus what it cost. */}
          {embed && (
            <div className="mt-2.5">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={embed.total}
                aria-valuenow={embed.done}
                aria-label="chunks embedded"
                className="h-1 overflow-hidden rounded-full bg-ink-750"
              >
                <motion.div
                  className="h-full rounded-full bg-signal"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.round(ratio * 100)}%` }}
                  transition={transition(reduce, 0.2)}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-2xs tabular-nums">
                {/* Mint only when the cache is the reason the count is zero. */}
                <span className={embed.apiCalls === 0 && embed.cached > 0 ? 'text-cache' : 'text-paper-mute'}>
                  {embed.apiCalls} api call{embed.apiCalls === 1 ? '' : 's'}
                </span>
                {embed.cached > 0 && (
                  <>
                    <span className="text-paper-faint">·</span>
                    <span className="text-cache">{embed.cached} cached</span>
                  </>
                )}
              </div>
            </div>
          )}

          <p className="mt-2 font-mono text-2xs tabular-nums text-paper-faint">{formatMs(elapsed)}</p>
        </>
      )}
    </motion.li>
  );
}
