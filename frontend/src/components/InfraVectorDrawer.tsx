import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, RefreshCw, X } from 'lucide-react';
import { ApiError } from '../api';
import {
  fixed,
  getInfraVector,
  signedFixed,
  type InfraVectorDetail,
  type VectorNeighbour,
} from '../lib/infra';
import { formatBytes } from '../lib/format';
import { transition } from '../lib/motion';
import { integer } from './figures';
import SimilarityRing from './SimilarityRing';

/**
 * One whole vector, all 768 floats of it.
 *
 * This is the answer to "can I actually see the data?", so nothing here is
 * summarised away: the values are printed in full, in mono, in a grid you can
 * scroll. The neighbours at the bottom are the payoff — the same `<=>` query
 * retrieval runs, pointed at a stored vector instead of a question, which is
 * what makes "near in 768-dimensional space" mean something.
 *
 * Its own slide-over rather than the shared InspectorPanel: 30rem is too
 * narrow to print eight columns of signed floats without wrapping.
 */

const COLS = 8;

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-mono text-[13px] tabular-nums text-paper">{value}</p>
    </div>
  );
}

function ValueGrid({ values }: { values: number[] }) {
  // Opacity carries magnitude, so the grid reads as texture before it reads as
  // numbers — the big components stand out of the noise floor. Colour is not
  // used: the palette reserves it for cache and failure semantics.
  const peak = useMemo(
    () => Math.max(1e-9, ...values.map((v) => Math.abs(v))),
    [values],
  );

  const rows = useMemo(() => {
    const out: { start: number; slice: number[] }[] = [];
    for (let i = 0; i < values.length; i += COLS) {
      out.push({ start: i, slice: values.slice(i, i + COLS) });
    }
    return out;
  }, [values]);

  return (
    <div className="scroll-quiet overflow-x-auto rounded-lg border border-line bg-ink-900">
      <div className="scroll-quiet max-h-[24rem] min-w-[36rem] overflow-y-auto px-2 py-2">
        {rows.map((row) => (
          <div
            key={row.start}
            className="grid grid-cols-[2.75rem_repeat(8,minmax(0,1fr))] gap-x-1.5 leading-[1.45]"
          >
            <span className="select-none pr-1 text-right font-mono text-2xs tabular-nums text-paper-faint">
              {String(row.start).padStart(3, '0')}
            </span>
            {row.slice.map((v, j) => (
              <span
                key={row.start + j}
                className="text-right font-mono text-2xs tabular-nums"
                style={{ color: `rgb(var(--paper) / ${(0.3 + 0.7 * (Math.abs(v) / peak)).toFixed(3)})` }}
                title={`[${row.start + j}] ${v}`}
              >
                {signedFixed(v, 4)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Neighbour({
  n,
  rank,
  onOpen,
}: {
  n: VectorNeighbour;
  rank: number;
  onOpen: (chunkId: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(n.chunk_id)}
        className="group flex w-full items-start gap-3 rounded-lg border border-line bg-ink-800 px-3 py-2.5 text-left transition-colors duration-150 hover:border-signal/45 hover:bg-ink-750"
      >
        <span className="mt-[3px] shrink-0 font-mono text-2xs tabular-nums text-paper-faint">
          {rank}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-x-2">
            <span className="shrink-0 font-mono text-2xs text-paper-dim">chunk {n.chunk_id}</span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-2xs text-paper-mute"
              title={n.filename}
            >
              {n.filename} · #{n.chunk_index}
            </span>
          </span>
          <span className="mt-1 block break-words font-serif text-[13px] leading-[1.55] text-paper-dim">
            {n.preview}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-signal">
          <SimilarityRing value={n.similarity} size={20} />
          <ArrowRight
            size={12}
            className="text-paper-faint transition-colors group-hover:text-signal"
          />
        </span>
      </button>
    </li>
  );
}

export default function InfraVectorDrawer({
  chunkId,
  onOpen,
  onClose,
}: {
  chunkId: number;
  onOpen: (chunkId: number) => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [detail, setDetail] = useState<InfraVectorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setDetail(null);
    setError(null);

    getInfraVector(chunkId, controller.signal)
      .then((next) => {
        if (live) setDetail(next);
      })
      .catch((err: unknown) => {
        if (!live || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(
          err instanceof ApiError ? err.message : 'Could not read that vector from the database.',
        );
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [chunkId, attempt]);

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={transition(reduce, 0.18)}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-scrim/65 backdrop-blur-[2px]"
        aria-hidden="true"
      />

      <motion.aside
        role="dialog"
        aria-modal="true"
        aria-label={`Vector for chunk ${chunkId}`}
        initial={{ x: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }}
        transition={reduce ? { duration: 0.001 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[46rem] flex-col border-l border-line bg-ink-850 shadow-panel"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] text-paper">
              One vector, in full · chunk {chunkId}
            </h2>
            <div className="mt-0.5 flex items-baseline gap-1.5 font-mono text-2xs tabular-nums text-paper-mute">
              {detail ? (
                <>
                  <span className="min-w-0 truncate" title={detail.filename}>
                    {detail.filename}
                  </span>
                  <span className="shrink-0">
                    · chunk {detail.chunk_index} · document {detail.document_id}
                  </span>
                </>
              ) : (
                <span>reading it out of Postgres</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-paper-mute transition-colors hover:text-paper"
            aria-label="Close panel"
          >
            <X size={16} />
          </button>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error && (
            <div className="rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
              <p className="font-mono text-2xs uppercase tracking-micro text-alert">
                vector unavailable
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
              <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
                <RefreshCw size={11} />
                try again
              </button>
            </div>
          )}

          {!detail && !error && (
            <div className="space-y-3" aria-hidden="true">
              <div className="h-16 animate-breathe rounded-lg border border-line bg-ink-800" />
              <div className="h-[24rem] animate-breathe rounded-lg border border-line bg-ink-800" />
              <div className="h-40 animate-breathe rounded-lg border border-line bg-ink-800" />
            </div>
          )}

          {detail && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-line bg-ink-800 px-3.5 py-3 sm:grid-cols-4">
                <Stat label="dimensions" value={integer(detail.dims)} />
                <Stat
                  label="on disk"
                  value={formatBytes(detail.bytes)}
                  title={`${integer(detail.bytes)} bytes — ${detail.dims} float4 plus a header`}
                />
                <Stat
                  label="‖v‖"
                  value={detail.l2_norm.toFixed(4)}
                  title="L2 norm. 1.0 means the vector was normalized before it was stored."
                />
                <Stat label="mean |value|" value={fixed(detail.stats.abs_mean, 4)} />
                <Stat label="min" value={signedFixed(detail.stats.min, 4)} />
                <Stat label="max" value={signedFixed(detail.stats.max, 4)} />
                <Stat label="mean" value={signedFixed(detail.stats.mean, 4)} />
                <Stat label="chunk id" value={String(detail.chunk_id)} />
              </div>

              <section aria-label="Vector values">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="eyebrow text-paper-dim">
                    all {integer(detail.dims)} values · 8 per row
                  </p>
                  <p className="font-mono text-2xs text-paper-faint">
                    darker digits are the larger components
                  </p>
                </div>
                <div className="mt-2">
                  <ValueGrid values={detail.values} />
                </div>
                <p className="mt-2 text-[12.5px] leading-relaxed text-paper-mute">
                  No single number in here means anything on its own. There is no “price”
                  dimension and no “leave policy” dimension — meaning is the direction all{' '}
                  {integer(detail.dims)} of them point in together, which is why the only useful
                  question to ask of a vector is which other vectors it is near.
                </p>
              </section>

              <section aria-label="Source text">
                <p className="eyebrow text-paper-dim">the text this vector was made from</p>
                <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-line bg-ink-800 px-3.5 py-3 font-serif text-[14px] leading-[1.65] text-paper-dim">
                  {detail.content}
                </p>
              </section>

              <section aria-label="Nearest neighbours">
                <p className="eyebrow text-signal">
                  its {detail.neighbours.length} nearest neighbours
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-paper-mute">
                  The same cosine search a question runs, pointed at this stored vector instead.
                  Open one to jump to its vector.
                </p>
                {detail.neighbours.length === 0 ? (
                  <p className="mt-2.5 rounded-lg border border-dashed border-line-strong bg-ink-800 px-3.5 py-3 text-[13px] text-paper-mute">
                    Nothing else is stored yet — a vector needs company before “near” means
                    anything.
                  </p>
                ) : (
                  <ol className="mt-2.5 space-y-2">
                    {detail.neighbours.map((n, i) => (
                      <Neighbour key={n.chunk_id} n={n} rank={i + 1} onOpen={onOpen} />
                    ))}
                  </ol>
                )}
              </section>
            </div>
          )}
        </div>
      </motion.aside>
    </>
  );
}
