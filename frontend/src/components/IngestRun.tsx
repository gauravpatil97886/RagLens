import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Check, Download } from 'lucide-react';
import type { DocumentSource, IngestRunState, Preflight, RunStage, UrlPreflight } from '../types';
import { formatBytes, formatMs } from '../lib/format';
import { transition } from '../lib/motion';
import ArticleCard from './ArticleCard';
import { Figure, FigureRow, LedgerFrame } from './CostLedger';

/**
 * The run.
 *
 * The same ledger as the quote, one tense later. Every tick, tile, bar and rate
 * on this screen is either a frame the server sent or a division of two real
 * clock readings taken when frames arrived. Nothing is on a timer pretending to
 * be progress: a stage that is instant ticks instantly and a rate that cannot
 * yet be measured says so.
 */

/**
 * Where each server stage sits in the pipeline, and whether it ends it.
 *
 * A link run is the file run with one step in front of it: the page has to
 * arrive before there is any text to extract. The three fetch stages collapse
 * into that one step, because the reader does not care whether DNS or the
 * request is the slow part — they care whether the page is here yet.
 */
type Step = { index: number; complete: boolean };

const FILE_STEP_OF: Record<RunStage, Step> = {
  queued: { index: 0, complete: false },
  // Only ever reached if a URL frame arrives on a file run, which it cannot.
  resolving: { index: 0, complete: false },
  fetching: { index: 0, complete: false },
  fetched: { index: 0, complete: false },
  extracting: { index: 0, complete: false },
  extracted: { index: 0, complete: true },
  chunking: { index: 1, complete: false },
  chunked: { index: 1, complete: true },
  embedding: { index: 2, complete: false },
  indexing: { index: 3, complete: false },
  done: { index: 3, complete: true },
};

const URL_STEP_OF: Record<RunStage, Step> = {
  queued: { index: 0, complete: false },
  resolving: { index: 0, complete: false },
  fetching: { index: 0, complete: false },
  fetched: { index: 0, complete: true },
  extracting: { index: 1, complete: false },
  extracted: { index: 1, complete: true },
  chunking: { index: 2, complete: false },
  chunked: { index: 2, complete: true },
  embedding: { index: 3, complete: false },
  indexing: { index: 4, complete: false },
  done: { index: 4, complete: true },
};

const FILE_STEPS = ['extracting text', 'splitting into chunks', 'embedding chunks', 'writing vectors'];

const URL_STEPS = [
  'fetching the page',
  'finding the article text',
  'splitting into chunks',
  'embedding chunks',
  'writing vectors',
];

const PIPELINE: Record<DocumentSource, { steps: string[]; stepOf: Record<RunStage, Step> }> = {
  file: { steps: FILE_STEPS, stepOf: FILE_STEP_OF },
  url: { steps: URL_STEPS, stepOf: URL_STEP_OF },
};

/** The newest few previews. Older ones scroll off; the histogram keeps them all. */
const TICKER = 3;

/**
 * A throughput, measured over two real timestamps.
 *
 * Returns '—' before there is anything to divide and 'instant' when the window
 * is too short to divide honestly — a splitter that emitted eleven chunks in
 * three milliseconds has no meaningful rate, and inventing one would be a lie
 * with a decimal point in it.
 */
function formatRate(count: number, from: number | null, to: number | null): string {
  if (from === null || to === null || count <= 0) return '—';
  const ms = to - from;
  if (ms < 50) return 'instant';
  const perSecond = count / (ms / 1000);
  return `${perSecond < 10 ? perSecond.toFixed(1) : Math.round(perSecond)}/s`;
}

/**
 * Every chunk the splitter has produced, one bar each, height against the
 * configured ceiling. This is the histogram the quote could only show as a
 * range — the real shape of the document, drawn as it is cut.
 */
function ChunkHistogram({ lengths, ceiling }: { lengths: number[]; ceiling: number | null }) {
  if (lengths.length === 0) return null;
  const scale = Math.max(ceiling ?? 0, ...lengths, 1);
  // A long document has hundreds of bars; drop the gutter before they thin out
  // to nothing, so the row still fits the dialog at its real length.
  const dense = lengths.length > 90;

  return (
    <div>
      <div
        className={[
          'flex h-16 items-stretch overflow-hidden rounded-lg border border-line bg-ink-800 px-2 py-1.5',
          dense ? 'gap-0' : 'gap-[2px]',
        ].join(' ')}
        role="img"
        aria-label={`${lengths.length} chunks, ${Math.min(...lengths).toLocaleString()} to ${Math.max(...lengths).toLocaleString()} characters each${ceiling === null ? '' : `, against a ceiling of ${ceiling.toLocaleString()}`}`}
      >
        {lengths.map((n, i) => (
          // The track is the ceiling. What is missing from the top of a column
          // is the headroom that chunk left unused — which is the thing worth
          // seeing, and it is invisible without something to measure against.
          <span
            key={i}
            className={`flex ${dense ? 'min-w-px' : 'min-w-[2px]'} flex-1 items-end rounded-[1px] bg-ink-700`}
            title={`chunk ${i} · ${n.toLocaleString()} characters`}
          >
            <span
              className="animate-raise w-full origin-bottom rounded-[1px] bg-signal/70"
              style={{ height: `${Math.max(4, (n / scale) * 100)}%` }}
            />
          </span>
        ))}
      </div>

      <p className="mt-1.5 font-mono text-2xs tabular-nums text-paper-faint">
        each column is one chunk · full height is{' '}
        {ceiling === null
          ? `the longest, ${Math.max(...lengths).toLocaleString()} chars`
          : `the ${ceiling.toLocaleString()}-character ceiling`}
      </p>
    </div>
  );
}

/**
 * Where the page came from.
 *
 * The preflight already downloaded this page, and the server kept the bytes for
 * a few minutes — so pressing Index reuses them instead of knocking on the site
 * again. `from_cache` says that happened and `fetch_ms: 0` proves it. It is
 * worth saying out loud: the reader pressed a button called Index, and the
 * thing they might reasonably worry about is having made a stranger's server
 * serve the same page twice for one decision.
 */
function FetchNote({ fetched }: { fetched: NonNullable<IngestRunState['fetched']> }) {
  const reused = fetched.fromCache;

  return (
    <div
      className={[
        'flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5',
        reused ? 'border-cache/30 bg-cache/[0.05]' : 'border-line bg-ink-800',
      ].join(' ')}
    >
      <Download size={14} className={`mt-0.5 shrink-0 ${reused ? 'text-cache' : 'text-paper-mute'}`} />
      <p className="text-[12.5px] leading-relaxed text-paper-dim">
        {reused ? (
          <>
            Reused the page from the check a moment ago — the site was not hit twice.{' '}
            <span className="font-mono tabular-nums text-cache">{formatMs(fetched.fetchMs)}</span> to
            read {formatBytes(fetched.bytes)} back out of memory.
          </>
        ) : (
          <>
            Fetched {formatBytes(fetched.bytes)} in{' '}
            <span className="font-mono tabular-nums text-paper">{formatMs(fetched.fetchMs)}</span>
            {fetched.status === 200 ? '' : ` · HTTP ${fetched.status}`}.
          </>
        )}
      </p>
    </div>
  );
}

export default function IngestRun({
  run,
  report,
  ceiling,
}: {
  run: IngestRunState;
  /** The quote this run was committed from, for the prediction-versus-reality line. */
  report: Preflight | UrlPreflight | null;
  ceiling: number | null;
}) {
  const reduce = useReducedMotion() ?? false;
  const [now, setNow] = useState(() => Date.now());

  const finished = run.stage === 'done' || run.error !== null;

  // A wall clock, ticking only while something is actually running.
  useEffect(() => {
    if (finished) return;
    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, [finished]);

  const embed = run.embed;
  const doc = run.document;
  const { steps, stepOf } = PIPELINE[run.source];
  const step = stepOf[run.stage];
  const settled = step.complete ? step.index + 1 : step.index;
  const ratio = embed && embed.total > 0 ? embed.done / embed.total : 0;

  const wallElapsed = (finished ? (run.embedTo ?? run.splitTo ?? now) : now) - run.startedAt;

  /**
   * Where the text came from — shown only on a link run, and only once the
   * frames that say so have arrived.
   *
   * The same two pieces in both tenses: how the page got here, and what was
   * pulled out of it. They appear mid-run, the moment the server sends them,
   * so the reader can see the wrong page was scraped while there is still a
   * Cancel button on screen — not afterwards.
   */
  const provenance =
    run.source !== 'url' ? null : (
      <>
        {run.fetched && (
          <motion.div
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition(reduce)}
          >
            <FetchNote fetched={run.fetched} />
          </motion.div>
        )}

        {run.article && (
          <motion.section
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition(reduce)}
          >
            <h3 className="eyebrow">here is what was read</h3>
            <div className="mt-2.5">
              <ArticleCard
                title={run.article.title}
                siteName={run.article.siteName}
                author={run.article.author}
                published={run.article.published}
                readingMinutes={run.article.readingMinutes}
                nWords={run.article.nWords}
                excerpt={run.article.excerpt}
                url={run.fetched?.finalUrl ?? null}
              />
            </div>
          </motion.section>
        )}
      </>
    );

  const measure = [
    // A link run measures one more thing than a file run: the page arriving.
    ...(run.source === 'url' ? [run.fetched === null ? null : formatBytes(run.fetched.bytes)] : []),
    run.nChars === null ? null : `${run.nChars.toLocaleString()} chars`,
    run.nChunks === null
      ? run.nChunksSeen > 0
        ? `${run.nChunksSeen}…`
        : null
      : `${run.nChunks} chunks`,
    embed ? `${embed.done}/${embed.total}` : null,
    doc ? `${doc.n_chunks} indexed` : null,
  ];

  /* ── Failure ───────────────────────────────────────────────────────────── */
  if (run.error) {
    return (
      <LedgerFrame
        tone="alert"
        eyebrow="this run stopped"
        headline="Indexing did not finish"
        footer={
          <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-paper-dim">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-alert" />
            <span>
              The partial document has been removed, so the corpus is unchanged. Any embeddings the
              run did pay for are still in the cache, so trying again will be cheaper than this was.
            </span>
          </p>
        }
      >
        <p className="mt-3 rounded-xl border border-line bg-ink-800 px-3.5 py-2.5 text-[13px] leading-relaxed text-paper-dim">
          {run.error}
        </p>
      </LedgerFrame>
    );
  }

  /* ── Done ──────────────────────────────────────────────────────────────── */
  if (doc) {
    const madeCalls = embed?.apiCalls ?? 0;
    const predictedCalls = report?.embedding.api_calls_needed ?? null;
    const matched = predictedCalls !== null && predictedCalls === madeCalls;
    const free = madeCalls === 0;

    return (
      <div className="space-y-5">
        <LedgerFrame
          tone={free ? 'cache' : 'signal'}
          eyebrow="what indexing cost"
          headline={
            free
              ? `Indexed ${doc.n_chunks.toLocaleString()} chunks without calling the model once`
              : `Indexed — ${doc.n_chunks.toLocaleString()} chunk${doc.n_chunks === 1 ? '' : 's'} in ${formatMs(doc.ingest_ms ?? wallElapsed)}`
          }
          footer={
            predictedCalls === null ? (
              <p className="text-[12.5px] leading-relaxed text-paper-dim">
                {doc.filename} is in the corpus and in scope for the next question.
              </p>
            ) : (
              <div className="flex items-start gap-2 text-[12.5px] leading-relaxed text-paper-dim">
                {matched ? (
                  <Check size={14} strokeWidth={3} className="mt-0.5 shrink-0 text-cache" />
                ) : (
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
                )}
                <span>
                  Preflight predicted{' '}
                  <span className="font-mono tabular-nums text-paper">{predictedCalls}</span>{' '}
                  API call{predictedCalls === 1 ? '' : 's'}. The run made{' '}
                  <span className="font-mono tabular-nums text-paper">{madeCalls}</span>
                  {matched
                    ? ' — the quote was exact.'
                    : '. An estimate and a run can disagree: the embedding cache changes in between.'}
                </span>
              </div>
            )
          }
        >
          <FigureRow>
            <Figure
              value={madeCalls.toLocaleString()}
              label={madeCalls === 1 ? 'API call made' : 'API calls made'}
              tone={free ? 'cache' : 'signal'}
            />
            <Figure
              value={formatMs(doc.ingest_ms ?? wallElapsed)}
              label={doc.ingest_ms === undefined ? 'elapsed, measured here' : 'server-side'}
              tone="paper"
            />
            <Figure
              value={(embed?.cached ?? 0).toLocaleString()}
              label="served from cache"
              tone={(embed?.cached ?? 0) > 0 ? 'cache' : 'mute'}
            />
          </FigureRow>
        </LedgerFrame>

        {provenance}

        {run.chunkChars.length > 0 && (
          <section>
            <h3 className="eyebrow">
              {run.chunkChars.length.toLocaleString()} chunks, as they were cut
            </h3>
            <div className="mt-2.5">
              <ChunkHistogram lengths={run.chunkChars} ceiling={ceiling} />
            </div>
          </section>
        )}
      </div>
    );
  }

  /* ── Running ───────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-5">
      <LedgerFrame
        tone="signal"
        eyebrow="what it is costing"
        headline={
          embed
            ? `${embed.done.toLocaleString()} of ${embed.total.toLocaleString()} chunks embedded`
            : run.label || 'Starting'
        }
      >
        {embed && (
          <div className="mt-3">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={embed.total}
              aria-valuenow={embed.done}
              aria-label="Chunks embedded"
              className="h-1.5 overflow-hidden rounded-full bg-ink-750"
            >
              <motion.div
                className="h-full rounded-full bg-signal"
                initial={{ width: 0 }}
                animate={{ width: `${Math.round(ratio * 100)}%` }}
                transition={transition(reduce, 0.25)}
              />
            </div>
          </div>
        )}

        {/* The same three figures the quote showed, filling in for real. The
            middle one is the quote itself, so the estimate stays on screen and
            is answerable while the run is still happening. */}
        <FigureRow>
          <Figure
            value={(embed?.apiCalls ?? 0).toLocaleString()}
            label={(embed?.apiCalls ?? 0) === 1 ? 'API call so far' : 'API calls so far'}
            tone={embed && embed.apiCalls === 0 && embed.cached > 0 ? 'cache' : 'signal'}
          />
          {report ? (
            <Figure
              value={report.embedding.api_calls_needed.toLocaleString()}
              label="predicted by preflight"
              tone="mute"
            />
          ) : (
            <Figure value={formatMs(wallElapsed)} label="elapsed" tone="paper" />
          )}
          <Figure
            value={(embed?.cached ?? 0).toLocaleString()}
            label="from cache"
            tone={(embed?.cached ?? 0) > 0 ? 'cache' : 'mute'}
          />
        </FigureRow>
      </LedgerFrame>

      {provenance}

      {/* ── The pipeline, ticking off ─────────────────────────────────────── */}
      <section>
        <h3 className="eyebrow">stages</h3>
        <ul className="mt-2.5 space-y-1.5">
          {steps.map((label, i) => {
            const state = i < settled ? 'done' : i === settled ? 'active' : 'pending';
            return (
              <li
                key={label}
                className={[
                  'flex items-center gap-2.5 font-mono text-[12px]',
                  state === 'active'
                    ? 'text-signal'
                    : state === 'done'
                      ? 'text-paper-mute'
                      : 'text-paper-faint',
                ].join(' ')}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {state === 'done' ? (
                    <Check size={11} strokeWidth={3} />
                  ) : state === 'active' ? (
                    <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-signal" />
                  ) : (
                    <span className="h-1 w-1 rounded-full bg-paper-faint/60" />
                  )}
                </span>
                <span className="flex-1 truncate">{label}</span>
                {measure[i] && <span className="shrink-0 tabular-nums text-paper-mute">{measure[i]}</span>}
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Speed, measured ───────────────────────────────────────────────── */}
      <section>
        <h3 className="eyebrow">throughput, measured between frames</h3>
        <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          {[
            {
              label: 'splitting',
              value: formatRate(run.nChunksSeen, run.splitFrom, run.splitTo),
              hint: 'Chunks per second, from the first chunk frame to the newest one.',
            },
            {
              label: 'embedding',
              value: formatRate(embed?.done ?? 0, run.embedFrom, run.embedTo),
              hint: 'Chunks per second, from the first embedding frame to the newest one.',
            },
            {
              label: 'chunks seen',
              value: run.nChunksSeen.toLocaleString(),
              hint: 'One per chunk frame the server has sent.',
            },
            {
              label: 'elapsed',
              value: formatMs(wallElapsed),
              hint: 'Wall clock since the request left the browser.',
            },
          ].map((row) => (
            <div key={row.label} title={row.hint}>
              <dd className="font-mono text-[15px] tabular-nums text-paper">{row.value}</dd>
              <dt className="mt-0.5 text-[11.5px] text-paper-mute">{row.label}</dt>
            </div>
          ))}
        </dl>
      </section>

      {/* ── Chunks, as they land ──────────────────────────────────────────── */}
      {run.chunkChars.length > 0 && (
        <section>
          <h3 className="eyebrow">chunks as they land</h3>
          <div className="mt-2.5">
            <ChunkHistogram lengths={run.chunkChars} ceiling={ceiling} />
          </div>

          <ul className="mt-2 space-y-1">
            <AnimatePresence initial={false} mode="popLayout">
              {run.chunks.slice(-TICKER).map((chunk) => (
                <motion.li
                  key={chunk.index}
                  layout={!reduce}
                  initial={{ opacity: 0, x: reduce ? 0 : -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={transition(reduce, 0.15)}
                  className={[
                    '-mx-1 flex items-baseline gap-2 rounded px-1 font-mono text-[11.5px]',
                    reduce ? '' : 'animate-land',
                  ].join(' ')}
                >
                  <span className="shrink-0 tabular-nums text-signal">
                    {String(chunk.index).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-paper-mute">{chunk.preview}</span>
                  <span className="shrink-0 tabular-nums text-paper-faint">{chunk.nChars}c</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>
      )}
    </div>
  );
}
