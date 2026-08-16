import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Copy, ShieldCheck } from 'lucide-react';
import type { Preflight, PreflightEmbedding } from '../types';
import { rise, stagger, transition } from '../lib/motion';
import { formatBytes } from '../lib/format';
import { Figure, FigureRow, LedgerFrame } from './CostLedger';

/**
 * The quote.
 *
 * This is the state the whole dialog exists for. The server has read the file,
 * split it, and checked every chunk against the embedding cache — all without
 * making a single model call and without writing a row. So this screen can say
 * exactly what pressing "Index it" will spend, and say it before the reader has
 * spent anything.
 *
 * Every number here came from the preflight response. The only thing this
 * component computes is the width of a bar.
 */

/**
 * Chunk lengths, drawn against the configured ceiling.
 *
 * Preflight reports min/mean/max rather than every chunk, so this is a range
 * band and not a histogram — the live run draws the real per-chunk bars once the
 * frames start arriving. Drawing a fake histogram here from three numbers would
 * be exactly the kind of invention this app exists to argue against.
 */
export function SizeBand({
  min,
  mean,
  max,
  ceiling,
  reduce,
}: {
  min: number;
  mean: number;
  max: number;
  ceiling: number | null;
  reduce: boolean;
}) {
  const scale = Math.max(ceiling ?? 0, max, 1);
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;
  const width = `${Math.max(1.5, ((max - min) / scale) * 100)}%`;

  return (
    <div>
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-3 h-1 rounded-full bg-ink-700" />

        <motion.div
          className="absolute top-3 h-1 rounded-full bg-signal/50"
          style={{ left: pct(min) }}
          initial={{ width: 0 }}
          animate={{ width }}
          transition={transition(reduce, 0.4)}
        />

        {/* The mean, as a tick you can line the band up against. */}
        <span
          aria-hidden="true"
          className="absolute top-[7px] h-[13px] w-[2px] -translate-x-1/2 rounded-full bg-signal"
          style={{ left: pct(mean) }}
        />

        {ceiling !== null && (
          <span
            aria-hidden="true"
            className="absolute top-[5px] h-[17px] w-px bg-paper-faint"
            style={{ left: pct(ceiling) }}
            title={`Configured chunk size: ${ceiling.toLocaleString()} characters`}
          />
        )}
      </div>

      <dl className="-mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-2xs tabular-nums">
        <div className="flex items-baseline gap-1.5">
          <dt className="text-paper-faint">min</dt>
          <dd className="text-paper-mute">{min.toLocaleString()}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-paper-faint">mean</dt>
          <dd className="text-signal">{mean.toLocaleString()}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-paper-faint">max</dt>
          <dd className="text-paper-mute">{max.toLocaleString()}</dd>
        </div>
        {ceiling !== null && (
          <div className="flex items-baseline gap-1.5">
            <dt className="text-paper-faint">ceiling</dt>
            <dd className="text-paper-mute">{ceiling.toLocaleString()}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/**
 * The three figures that are the quote, in the frame they always appear in.
 *
 * Shared by the file quote and the link quote so the two flows read as one
 * feature: same tone rule (mint when the answer is zero), same figure order,
 * same position in the dialog. Only the footer sentence differs, because how
 * the reading was taken differs — in memory for a file, over one HTTP request
 * for a page.
 */
export function QuoteLedger({
  embed,
  nChunks,
  footer,
}: {
  embed: PreflightEmbedding;
  nChunks: number;
  footer: ReactNode;
}) {
  const free = embed.api_calls_needed === 0;
  // No tilde on a zero: nothing is approximate about none.
  const tokens = `${embed.tokens_estimated && embed.estimated_tokens > 0 ? '~' : ''}${embed.estimated_tokens.toLocaleString()}`;

  return (
    <LedgerFrame
      tone={free ? 'cache' : 'signal'}
      eyebrow="what indexing this would cost"
      headline={
        free
          ? nChunks === embed.already_cached
            ? 'Free — every chunk is already embedded'
            : 'Free — nothing here needs a new embedding'
          : `${embed.to_embed.toLocaleString()} of ${nChunks.toLocaleString()} chunks need embedding`
      }
      footer={footer}
    >
      <FigureRow>
        <Figure
          value={embed.api_calls_needed.toLocaleString()}
          label={embed.api_calls_needed === 1 ? 'API call' : 'API calls'}
          tone={free ? 'cache' : 'signal'}
          title="Chunks are embedded in batches, so this is fewer than the number of chunks."
        />
        <Figure
          value={tokens}
          label={
            embed.estimated_tokens === 0
              ? 'tokens'
              : embed.tokens_estimated
                ? 'tokens, estimated'
                : 'tokens'
          }
          tone="paper"
          title={
            embed.tokens_estimated
              ? 'Estimated at roughly four characters per token. Embedding responses carry no token counts, so this can never be measured exactly.'
              : undefined
          }
        />
        <Figure
          value={embed.already_cached.toLocaleString()}
          label="already cached"
          tone={embed.already_cached > 0 ? 'cache' : 'mute'}
          title="Chunks whose exact text is already in embedding_cache. These cost nothing."
        />
      </FigureRow>
    </LedgerFrame>
  );
}

export default function PreflightReport({
  report,
  ceiling,
}: {
  report: Preflight;
  /** `chunking.chunk_size` from /api/pipeline. Null if that call didn't land. */
  ceiling: number | null;
}) {
  const reduce = useReducedMotion() ?? false;
  const embed = report.embedding;
  const free = embed.api_calls_needed === 0;

  const shape = [
    report.n_pages === null ? null : `${report.n_pages.toLocaleString()} page${report.n_pages === 1 ? '' : 's'}`,
    `${report.n_chars.toLocaleString()} characters`,
    `${report.n_chunks.toLocaleString()} chunk${report.n_chunks === 1 ? '' : 's'}`,
    formatBytes(report.size_bytes),
  ].filter(Boolean) as string[];

  return (
    <motion.div variants={stagger(reduce, 0.05)} initial="hidden" animate="show" className="space-y-5">
      {/* ── The ledger, in the future tense ─────────────────────────────── */}
      <motion.div variants={rise(reduce, 6)}>
        <QuoteLedger
          embed={embed}
          nChunks={report.n_chunks}
          footer={
            <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-paper-dim">
              <ShieldCheck size={14} className={`mt-0.5 shrink-0 ${free ? 'text-cache' : 'text-signal'}`} />
              <span>
                Nothing has been spent. This reading was taken locally — preflight extracts and
                chunks the file in memory and makes <strong className="font-medium text-paper">zero</strong>{' '}
                API calls. The count above starts only when you press Index it.
              </span>
            </p>
          }
        />
      </motion.div>

      {/* ── Duplicate ───────────────────────────────────────────────────── */}
      {report.duplicate && (
        <motion.div
          variants={rise(reduce, 6)}
          className="flex items-start gap-2.5 rounded-xl border border-signal/35 bg-signal/[0.07] px-3.5 py-3"
        >
          <Copy size={15} className="mt-0.5 shrink-0 text-signal" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-signal">This document is already indexed</p>
            <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">
              The same text is in the corpus as{' '}
              <span className="font-medium text-paper">{report.duplicate.filename}</span> (document{' '}
              <span className="font-mono tabular-nums">{report.duplicate.document_id}</span>). Indexing
              it again adds a second copy, and both copies will compete to answer the same question.
              Cancel unless you meant to.
            </p>
          </div>
        </motion.div>
      )}

      {/* ── Warnings, in the server's own words ─────────────────────────── */}
      {report.warnings.length > 0 && (
        <motion.ul variants={rise(reduce, 6)} className="space-y-2">
          {report.warnings.map((warning) => (
            <li
              key={warning}
              className="flex items-start gap-2.5 rounded-xl border border-line bg-ink-800 px-3.5 py-2.5"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-signal" />
              <span className="text-[13px] leading-relaxed text-paper-dim">{warning}</span>
            </li>
          ))}
        </motion.ul>
      )}

      {/* ── The shape of the file ───────────────────────────────────────── */}
      <motion.section variants={rise(reduce, 6)}>
        <h3 className="eyebrow">the file</h3>
        <p className="mt-2 font-mono text-[12.5px] tabular-nums text-paper-dim">
          {shape.join(' · ')}
        </p>
      </motion.section>

      {/* ── Chunk sizes ─────────────────────────────────────────────────── */}
      <motion.section variants={rise(reduce, 6)}>
        <h3 className="eyebrow">
          chunk sizes{ceiling === null ? '' : ' against the configured ceiling'}
        </h3>
        <div className="mt-2.5">
          <SizeBand
            min={report.chunk_chars.min}
            mean={report.chunk_chars.mean}
            max={report.chunk_chars.max}
            ceiling={ceiling}
            reduce={reduce}
          />
        </div>
      </motion.section>

      {/* ── What chunking did to the document ───────────────────────────── */}
      {report.preview_chunks.length > 0 && (
        <motion.section variants={rise(reduce, 6)}>
          <h3 className="eyebrow">
            first {report.preview_chunks.length} chunk
            {report.preview_chunks.length === 1 ? '' : 's'} of {report.n_chunks.toLocaleString()}
          </h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-paper-mute">
            This is what the splitter would hand to the retriever. If a passage is cut somewhere
            it shouldn't be, you can see it here rather than in a bad answer later.
          </p>

          <ul className="mt-2.5 space-y-2">
            {report.preview_chunks.map((chunk) => (
              <li key={chunk.index} className="rounded-xl border border-line bg-ink-800">
                <div className="flex items-center gap-3 border-b border-line-soft px-3 py-1.5">
                  <span className="font-mono text-2xs tabular-nums text-signal">
                    {String(chunk.index).padStart(2, '0')}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-2xs tabular-nums text-paper-faint">
                    {chunk.n_chars.toLocaleString()} chars
                  </span>
                </div>
                {/* Serif: these are the document's words, not the app's. */}
                <p className="px-3 py-2.5 font-serif text-[13.5px] leading-relaxed text-paper-dim">
                  {chunk.preview}
                </p>
              </li>
            ))}
          </ul>
        </motion.section>
      )}
    </motion.div>
  );
}
