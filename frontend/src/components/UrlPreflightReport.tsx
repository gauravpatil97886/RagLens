import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Check, GitCompare, Repeat2, ShieldCheck } from 'lucide-react';
import type { PreflightExisting, UrlPreflight } from '../types';
import { rise, stagger, transition } from '../lib/motion';
import { formatBytes, formatMs, formatSince } from '../lib/format';
import ArticleCard from './ArticleCard';
import { QuoteLedger, SizeBand } from './PreflightReport';

/**
 * The quote for a link.
 *
 * Same shape as the file quote, one source later: what was found, then what
 * indexing it would cost, then what chunking would do to it. The costing frame
 * is literally the same component, so the two ways into this dialog cannot
 * drift into looking like two different features.
 *
 * The one place it deliberately outranks the file version is `existing`. When
 * someone has already indexed this link, that is not a footnote under the
 * numbers — it is the first thing on the screen, because it is the answer to
 * the question the reader is actually asking, and because the number attached
 * to it is zero.
 */

/**
 * The reuse case.
 *
 * Three situations, one frame. Mint whenever indexing again is free, because
 * mint is this app's colour for "the cache already paid for this" and nothing
 * earns it more than a page a colleague fetched an hour ago. The zero is set at
 * display size on purpose: it is the entire argument of the feature, and a
 * figure the same size as every other figure would lose it.
 */
function ExistingNotice({
  existing,
  apiCalls,
  reduce,
}: {
  existing: PreflightExisting;
  /** From the quote, not assumed — the notice never claims a zero it wasn't told. */
  apiCalls: number;
  reduce: boolean;
}) {
  const free = apiCalls === 0;
  const added = formatSince(existing.created_at);

  const { eyebrow, headline, Glyph, body } = existing.changed
    ? {
        eyebrow: 'this link is already indexed, but the page moved on',
        headline: 'This page has changed since it was indexed',
        Glyph: Repeat2,
        body: (
          <>
            The copy in the corpus was taken {added}, and the page no longer says the same thing.
            Re-index to bring in the current version. The older copy stays in the corpus as{' '}
            <span className="font-medium text-paper">{existing.filename}</span> until you delete it,
            so answers can cite either one.
          </>
        ),
      }
    : existing.kind === 'content'
      ? {
          eyebrow: 'the same article, reached by a different link',
          headline: 'A different link produced the same article',
          Glyph: GitCompare,
          body: (
            <>
              The text behind this URL is byte-for-byte what is already in the corpus as{' '}
              <span className="font-medium text-paper">{existing.filename}</span> (document{' '}
              <span className="font-mono tabular-nums">{existing.document_id}</span>), added {added}.
              A mirror, or the same page with tracking parameters on it. Indexing it would put the
              same passages in twice, and both copies would compete to answer one question.
            </>
          ),
        }
      : {
          eyebrow: 'already in your corpus',
          headline: 'Someone already indexed this link',
          Glyph: Check,
          body: (
            <>
              It is in the corpus as{' '}
              <span className="font-medium text-paper">{existing.filename}</span> (document{' '}
              <span className="font-mono tabular-nums">{existing.document_id}</span>), added {added}.
              Every chunk of it is already embedded, so a second copy would cost nothing to make and
              would still be a second copy — two documents competing to answer the same question.
            </>
          ),
        };

  const tone = existing.changed ? 'signal' : free ? 'cache' : 'signal';
  const frame =
    tone === 'cache' ? 'border-cache/35 bg-cache/[0.06]' : 'border-signal/30 bg-signal/[0.055]';
  const accent = tone === 'cache' ? 'text-cache' : 'text-signal';

  return (
    <motion.section
      variants={rise(reduce, 6)}
      className={`rounded-2xl border px-4 py-3.5 ${frame}`}
    >
      <p className="eyebrow">{eyebrow}</p>

      <p className={`mt-2 flex items-start gap-2 text-[15px] font-medium leading-snug ${accent}`}>
        <Glyph size={16} className="mt-[3px] shrink-0" />
        <span>{headline}</span>
      </p>

      {/* The number, at the size the number deserves. */}
      <div className="mt-3.5 flex items-center gap-4">
        <motion.span
          initial={{ opacity: 0, scale: reduce ? 1 : 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={transition(reduce, 0.3)}
          className={`font-mono text-[3.25rem] font-medium leading-none tabular-nums ${accent}`}
        >
          {apiCalls.toLocaleString()}
        </motion.span>
        <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-paper-dim">
          {free ? (
            <>
              API calls to index it again. Every chunk is already in the embedding cache, so a
              second copy is free to make — which is exactly why it is worth not making.
            </>
          ) : (
            <>
              API call{apiCalls === 1 ? '' : 's'} to index the current version. What has not changed
              is still in the embedding cache, so only the new text is paid for.
            </>
          )}
        </span>
      </div>

      <div className={`mt-3 border-t pt-2.5 ${tone === 'cache' ? 'border-cache/20' : 'border-signal/20'}`}>
        <p className="text-[12.5px] leading-relaxed text-paper-dim">{body}</p>
      </div>
    </motion.section>
  );
}

export default function UrlPreflightReport({
  report,
  ceiling,
}: {
  report: UrlPreflight;
  /** `chunking.chunk_size` from /api/pipeline. Null if that call didn't land. */
  ceiling: number | null;
}) {
  const reduce = useReducedMotion() ?? false;
  const embed = report.embedding;
  const free = embed.api_calls_needed === 0;

  // The server sends the reuse fact twice — once as a structured `existing`
  // block and once as a sentence in `warnings`. The block above says it better
  // and says it bigger, so the sentence is dropped rather than printed under it.
  const warnings = report.existing
    ? report.warnings.filter((w) => !/already indexed/i.test(w))
    : report.warnings;

  const shape = [
    report.site_name,
    formatBytes(report.size_bytes),
    `${report.n_chars.toLocaleString()} characters`,
    `${report.n_chunks.toLocaleString()} chunk${report.n_chunks === 1 ? '' : 's'}`,
    `fetched in ${formatMs(report.fetch_ms)}`,
  ];

  // A redirect is worth surfacing: the page that was read is not the page that
  // was typed, and that is the sort of thing you want to notice before indexing.
  const redirected = report.final_url !== report.url;

  return (
    <motion.div variants={stagger(reduce, 0.05)} initial="hidden" animate="show" className="space-y-5">
      {/* ── The reuse case, first, because it is the answer ─────────────── */}
      {report.existing && (
        <ExistingNotice
          existing={report.existing}
          apiCalls={embed.api_calls_needed}
          reduce={reduce}
        />
      )}

      {/* ── Here is what I found ────────────────────────────────────────── */}
      <motion.section variants={rise(reduce, 6)}>
        <h3 className="eyebrow">here is what I found</h3>
        <div className="mt-2.5">
          <ArticleCard
            title={report.article.title}
            siteName={report.site_name}
            author={report.article.author}
            published={report.article.published}
            readingMinutes={report.article.reading_minutes}
            nWords={report.article.n_words}
            excerpt={report.article.excerpt}
            url={report.final_url}
          />
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-paper-mute">
          That opening is real body text pulled out of the page. If it reads like a cookie banner or
          a nav bar, the scrape found the wrong thing and this is the moment to walk away.
        </p>
      </motion.section>

      {/* ── The ledger, in the future tense ─────────────────────────────── */}
      <motion.div variants={rise(reduce, 6)}>
        <QuoteLedger
          embed={embed}
          nChunks={report.n_chunks}
          footer={
            <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-paper-dim">
              <ShieldCheck size={14} className={`mt-0.5 shrink-0 ${free ? 'text-cache' : 'text-signal'}`} />
              <span>
                Nothing has been spent. Fetching the page cost one HTTP request and{' '}
                <strong className="font-medium text-paper">zero</strong> API calls; the text was
                chunked in memory and checked against the embedding cache. The page is held for a
                few minutes, so pressing Index it doesn't download {report.site_name} twice.
              </span>
            </p>
          }
        />
      </motion.div>

      {/* ── Warnings, in the server's own words ─────────────────────────── */}
      {warnings.length > 0 && (
        <motion.ul variants={rise(reduce, 6)} className="space-y-2">
          {warnings.map((warning) => (
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

      {/* ── The shape of the page ───────────────────────────────────────── */}
      <motion.section variants={rise(reduce, 6)}>
        <h3 className="eyebrow">the page</h3>
        <p className="mt-2 font-mono text-[12.5px] tabular-nums text-paper-dim">
          {shape.join(' · ')}
        </p>
        {redirected && (
          <p className="mt-1.5 break-words text-[12.5px] leading-relaxed text-paper-mute">
            That link redirected. What was read is{' '}
            <span className="font-mono text-[12px] text-paper-dim">{report.final_url}</span>.
          </p>
        )}
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

      {/* ── What chunking did to the article ────────────────────────────── */}
      {report.preview_chunks.length > 0 && (
        <motion.section variants={rise(reduce, 6)}>
          <h3 className="eyebrow">
            first {report.preview_chunks.length} chunk
            {report.preview_chunks.length === 1 ? '' : 's'} of {report.n_chunks.toLocaleString()}
          </h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-paper-mute">
            This is what the splitter would hand to the retriever. Scraped pages are where stray
            navigation text shows up — if it is in here, it will be in an answer later.
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
                {/* Serif: the page's words, not the app's. Plain text, always. */}
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
