import { useCallback, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { FileText, RefreshCw } from 'lucide-react';
import { ApiError, getPipeline } from '../api';
import type { DocumentMeta, Pipeline } from '../types';
import { formatBytes, truncateMiddle } from '../lib/format';
import { rise, stagger } from '../lib/motion';
import OverlapDiagram from './OverlapDiagram';
import StageCard, { Quoted, Why } from './StageCard';
import ThresholdScale from './ThresholdScale';
import { integer } from './figures';

/**
 * How this system actually works, with its own live numbers in it.
 *
 * Every parameter on this page is read from GET /api/pipeline, which in turn
 * reads the running settings object and the Postgres catalog. If someone
 * changes CHUNK_SIZE, the diagram redraws; if the index is dropped, the index
 * line goes blank. Nothing here is a screenshot of how it used to be.
 */

function ConfigStrip({ p }: { p: Pipeline }) {
  const items: { k: string; v: string; title?: string }[] = [
    { k: 'chat', v: p.models.chat },
    { k: 'embed', v: p.models.embed },
    { k: 'thinking', v: p.models.thinking_level },
    { k: 'temperature', v: String(p.models.temperature) },
    { k: 'vector', v: `${p.embedding.dim}d` },
    {
      k: 'index',
      v: p.retrieval.index.method ?? 'none',
      title: p.retrieval.index.definition ?? undefined,
    },
    { k: 'chunks', v: integer(p.corpus.chunks) },
    { k: 'documents', v: integer(p.corpus.documents) },
  ];

  return (
    <ul className="mt-5 flex flex-wrap gap-1.5">
      {items.map((i) => (
        <li
          key={i.k}
          title={i.title}
          className="rounded border border-line bg-ink-850 px-2 py-1 font-mono text-2xs tabular-nums text-paper-mute"
        >
          {i.k} <span className="text-paper">{i.v}</span>
        </li>
      ))}
    </ul>
  );
}

/** Where the splitter actually landed, against the size it was aiming at. */
function ChunkSpread({ p }: { p: Pipeline }) {
  const { chunk_size } = p.chunking;
  const { min_chunk_chars: min, avg_chunk_chars: avg, max_chunk_chars: max } = p.corpus;
  if (p.corpus.chunks === 0) return null;

  const pct = (v: number) => `${Math.min(100, (v / chunk_size) * 100)}%`;

  return (
    <div className="rounded-lg border border-line bg-ink-800 px-3.5 py-3">
      <p className="eyebrow">what the splitter produced · {integer(p.corpus.chunks)} chunks</p>
      <div
        className="relative mt-2.5 h-2.5 w-full rounded-[3px] bg-ink-750"
        role="img"
        aria-label={`Chunk lengths run from ${min} to ${max} characters, averaging ${avg}, against a ceiling of ${chunk_size}.`}
      >
        <div
          className="absolute inset-y-0 rounded-[3px] bg-signal/35"
          style={{ left: pct(min), width: `calc(${pct(max)} - ${pct(min)})` }}
        />
        <span
          className="absolute inset-y-[-2px] w-0.5 rounded-full bg-signal"
          style={{ left: `calc(${pct(avg)} - 1px)` }}
          title={`mean ${avg} characters`}
        />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-2xs tabular-nums text-paper-mute">
        <span>
          shortest <span className="text-paper-dim">{integer(min)}</span>
        </span>
        <span>
          mean <span className="text-signal">{integer(avg)}</span>
        </span>
        <span>
          longest <span className="text-paper-dim">{integer(max)}</span>
        </span>
        <span className="ml-auto text-paper-faint">ceiling {integer(chunk_size)}</span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-paper-mute">
        None of them hits the ceiling exactly. The splitter tries the widest natural boundary
        first — blank line, then newline, then sentence end, then word — and only cuts
        mid-word when a single token is longer than a whole chunk.
      </p>
    </div>
  );
}

function DocumentLinks({
  documents,
  onOpenDocument,
}: {
  documents: DocumentMeta[];
  onOpenDocument: (id: number) => void;
}) {
  const ready = documents.filter((d) => d.status === 'ready');
  if (ready.length === 0) return null;

  return (
    <div>
      <p className="eyebrow">see it on a real file</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {ready.map((doc) => (
          <li key={doc.id}>
            <button type="button" onClick={() => onOpenDocument(doc.id)} className="btn">
              <FileText size={11} />
              <span className="normal-case tracking-normal">{truncateMiddle(doc.filename, 24)}</span>
              <span className="tabular-nums text-signal">{doc.n_chunks}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PipelineView({
  documents,
  onOpenDocument,
}: {
  documents: DocumentMeta[];
  onOpenDocument: (id: number) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [p, setP] = useState<Pipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const readyCount = documents.filter((d) => d.status === 'ready').length;

  const load = useCallback((signal: AbortSignal) => {
    getPipeline(signal)
      .then((next) => {
        setP(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(
          err instanceof ApiError ? err.message : 'Could not read the pipeline configuration.',
        );
      });
  }, []);

  // Config is static; the corpus counts in it are not, so refetch when the
  // document set changes rather than polling for something that rarely moves.
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, attempt, readyCount]);

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[74rem] px-4 py-6 sm:px-6 sm:py-8">
        <header>
          <p className="eyebrow">how this works</p>
          <h1 className="mt-2 max-w-[38rem] font-serif text-[1.75rem] leading-tight text-paper sm:text-[2.1rem]">
            Two pipelines, twelve steps, and every number on this page is the one currently in
            force
          </h1>
          <p className="mt-2 max-w-[42rem] font-serif text-[14.5px] leading-[1.65] text-paper-dim">
            The left column runs once per uploaded file. The right column runs once per
            question, and tries twice to stop before it reaches the model.
          </p>
          {p && <ConfigStrip p={p} />}
        </header>

        {error && (
          <div className="mt-6 rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
            <p className="font-mono text-2xs uppercase tracking-micro text-alert">
              configuration unavailable
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
            <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
              <RefreshCw size={11} />
              try again
            </button>
          </div>
        )}

        {!p && !error && (
          <div className="mt-6 grid gap-4 lg:grid-cols-2" aria-hidden="true">
            <div className="h-[32rem] animate-breathe rounded-xl border border-line bg-ink-850" />
            <div className="h-[32rem] animate-breathe rounded-xl border border-line bg-ink-850" />
          </div>
        )}

        {p && (
          <motion.div
            variants={stagger(reduce, 0.06)}
            initial="hidden"
            animate="show"
            className="mt-6 grid items-start gap-4 lg:grid-cols-2"
          >
            {/* ── Ingest ─────────────────────────────────────────────────── */}
            <motion.section
              variants={rise(reduce)}
              className="min-w-0 rounded-xl border border-line bg-ink-850 px-4 py-4 shadow-inset sm:px-5 sm:py-5"
              aria-label="Ingest pipeline"
            >
              <p className="eyebrow text-paper-dim">ingest · once per file</p>
              <p className="mt-1.5 font-serif text-[14px] leading-[1.6] text-paper-mute">
                Everything below happens while the upload card is on screen. The card is not a
                progress animation — each stage you see is a server event.
              </p>

              <ol className="mt-5">
                <StageCard
                  n={1}
                  title="receive the file"
                  params={[
                    { k: 'max', v: formatBytes(p.limits.max_upload_bytes) },
                    ...p.limits.allowed_extensions.map((e) => ({ k: 'accepts', v: e })),
                  ]}
                >
                  <Why>
                    The file is posted to <code className="font-mono text-2xs text-paper">/api/documents/stream</code>,
                    which answers with a server-sent event stream rather than one response at the
                    end. Anything larger or with the wrong extension is refused before a byte is
                    parsed.
                  </Why>
                </StageCard>

                <StageCard n={2} title="extract text">
                  <Why>
                    PDF, DOCX, Markdown and plain text all collapse to one string. There is no OCR
                    and no layout analysis — a scanned PDF with no text layer produces nothing
                    here, and the document is marked failed rather than silently indexed empty.
                  </Why>
                </StageCard>

                <StageCard
                  n={3}
                  title="split into chunks"
                  params={[
                    { k: 'chunk_size', v: integer(p.chunking.chunk_size) },
                    { k: 'overlap', v: integer(p.chunking.chunk_overlap) },
                    {
                      k: 'ratio',
                      v: `${(p.chunking.overlap_ratio * 100).toFixed(1)}%`,
                      title: 'chunk_overlap ÷ chunk_size',
                    },
                  ]}
                >
                  <Why>
                    A whole document is the wrong unit to embed: one vector cannot represent forty
                    pages. So the text is cut into pieces small enough to be about one thing.
                  </Why>
                  <OverlapDiagram
                    chunkSize={p.chunking.chunk_size}
                    overlap={p.chunking.chunk_overlap}
                  />
                  <ChunkSpread p={p} />
                  <DocumentLinks documents={documents} onOpenDocument={onOpenDocument} />
                </StageCard>

                <StageCard
                  n={4}
                  title="embed every chunk"
                  params={[
                    { k: 'task_type', v: p.embedding.task_types.documents },
                    { k: 'model', v: p.models.embed },
                    {
                      k: 'cache',
                      v: `${integer(p.corpus.embedding_cache_rows)} rows`,
                      title: 'Keyed on sha256(text) + task type + dimension — re-uploading the same file costs nothing.',
                    },
                  ]}
                >
                  <Why>
                    Each chunk becomes a list of {p.embedding.dim} numbers. Chunks are sent in
                    batches, so a document of {integer(p.corpus.chunks)} chunks does not mean{' '}
                    {integer(p.corpus.chunks)} API calls — and anything already in the embedding
                    cache costs no call at all.
                  </Why>
                  <Quoted>{p.embedding.why_task_types}</Quoted>
                </StageCard>

                <StageCard
                  n={5}
                  title="normalize to unit length"
                  params={[
                    { k: 'dim', v: String(p.embedding.dim) },
                    {
                      k: 'stored',
                      v: p.embedding.stored_dim === null ? 'unknown' : String(p.embedding.stored_dim),
                      title: 'Read from pg_attribute — the real column width, not the setting.',
                    },
                    { k: 'L2', v: p.embedding.normalized ? 'yes' : 'no' },
                  ]}
                >
                  <Why>
                    This is the step most tutorials skip, and it is the one that decides whether
                    your similarity scores mean anything.
                  </Why>
                  <Quoted>{p.embedding.why_normalized}</Quoted>
                  {p.embedding.stored_dim !== null && (
                    <p className="font-mono text-2xs tabular-nums text-paper-mute">
                      configured {p.embedding.dim} · stored {p.embedding.stored_dim} ·{' '}
                      {p.embedding.stored_dim === p.embedding.dim ? (
                        <span className="text-cache">they agree</span>
                      ) : (
                        <span className="text-alert">
                          they disagree — the index was built at a different width
                        </span>
                      )}
                    </p>
                  )}
                </StageCard>

                <StageCard
                  n={6}
                  title="store and index"
                  last
                  params={[
                    { k: 'type', v: `vector(${p.embedding.stored_dim ?? p.embedding.dim})` },
                    { k: 'index', v: p.retrieval.index.method ?? 'none' },
                    { k: 'opclass', v: p.retrieval.index.opclass ?? '—' },
                    { k: 'on disk', v: formatBytes(p.corpus.vector_bytes) },
                  ]}
                >
                  <Why>
                    Vectors live in Postgres next to the text they came from, so a retrieved
                    chunk can be shown to you verbatim. The HNSW index makes nearest-neighbour
                    search approximate but fast; without it, every question would scan every
                    chunk.
                  </Why>
                  {p.retrieval.index.definition && (
                    <pre className="overflow-hidden whitespace-pre-wrap break-words rounded border border-line bg-ink-900 px-2.5 py-2 font-mono text-2xs leading-relaxed text-paper-mute">
                      {p.retrieval.index.definition}
                    </pre>
                  )}
                </StageCard>
              </ol>
            </motion.section>

            {/* ── Query ──────────────────────────────────────────────────── */}
            <motion.section
              variants={rise(reduce)}
              className="min-w-0 rounded-xl border border-line bg-ink-850 px-4 py-4 shadow-inset sm:px-5 sm:py-5"
              aria-label="Query pipeline"
            >
              <p className="eyebrow text-paper-dim">query · once per question</p>
              <p className="mt-1.5 font-serif text-[14px] leading-[1.6] text-paper-mute">
                Two of these steps can end the run early. The dashed mint markers are the exits.
              </p>

              <ol className="mt-5">
                <StageCard n={1} title="the question arrives">
                  <Why>
                    Along with the set of documents you have ticked. That set is part of every
                    cache key below: an answer retrieved from three documents is not a valid
                    answer for a different three.
                  </Why>
                </StageCard>

                <StageCard
                  n={2}
                  title="exact cache check"
                  tone="cache"
                  params={[
                    { k: 'keyed on', v: 'normalised text + scope' },
                    { k: 'rows', v: integer(p.corpus.query_cache_rows) },
                    { k: 'ttl', v: `${p.cache.ttl_hours}h` },
                  ]}
                >
                  <Why>
                    Case, spacing and punctuation are stripped, then it is a plain string
                    lookup — no vector, no API call. If it hits, the run ends here and both the
                    embedding and the generation are skipped.
                  </Why>
                </StageCard>

                <StageCard
                  n={3}
                  title="embed the question"
                  params={[
                    { k: 'task_type', v: p.embedding.task_types.queries },
                    { k: 'dim', v: String(p.embedding.dim) },
                  ]}
                >
                  <Why>
                    Note the task type differs from the one used at ingest. Same model, same
                    dimension, different instruction — the question is embedded as a question,
                    the chunks were embedded as passages.
                  </Why>
                </StageCard>

                <StageCard
                  n={4}
                  title="semantic cache check"
                  tone="cache"
                  params={[
                    { k: 'threshold', v: String(p.cache.semantic_threshold) },
                    { k: 'enabled', v: p.cache.enabled ? 'yes' : 'no' },
                    { k: 'rows', v: integer(p.corpus.query_cache_rows) },
                  ]}
                >
                  <Why>
                    Now that the question is a vector, it can be compared to questions already
                    answered. “What is the refund window?” and “how long do I have to send it
                    back?” are different strings but neighbouring vectors. A hit here still skips
                    the model — the expensive call — even though the embedding was already paid
                    for.
                  </Why>
                  <ThresholdScale
                    minSimilarity={p.retrieval.min_similarity}
                    cacheThreshold={p.cache.semantic_threshold}
                  />
                </StageCard>

                <StageCard
                  n={5}
                  title="search the chunks"
                  params={[
                    { k: 'top_k', v: String(p.retrieval.top_k) },
                    { k: 'min_similarity', v: String(p.retrieval.min_similarity) },
                    { k: 'metric', v: p.retrieval.metric },
                    { k: 'operator', v: p.retrieval.distance_operator },
                  ]}
                >
                  <Why>
                    The {p.retrieval.top_k} nearest chunks within the documents you selected,
                    ranked by cosine similarity and dropped if they score below{' '}
                    {p.retrieval.min_similarity}. Those are the chunks printed above each answer,
                    with their scores — nothing is retrieved that you cannot see.
                  </Why>
                  <pre className="overflow-hidden whitespace-pre-wrap break-words rounded border border-line bg-ink-900 px-2.5 py-2 font-mono text-2xs leading-relaxed text-paper-mute">
                    similarity = {p.retrieval.similarity_formula}
                  </pre>
                  <Why>
                    <code className="font-mono text-2xs text-paper">
                      {p.retrieval.distance_operator}
                    </code>{' '}
                    is cosine <em>distance</em>, so similarity is one minus it. That subtraction
                    is only meaningful because both vectors were normalized at step 5 of ingest.
                  </Why>
                </StageCard>

                <StageCard n={6} title="assemble a grounded prompt">
                  <Why>
                    The retrieved chunks are numbered and pasted above the question, each labelled
                    with its filename and chunk index, and the model is told to answer using only
                    those blocks and to cite them as [n]. That instruction is the whole of
                    “grounding” — there is no fine-tuning and no hidden knowledge base.
                  </Why>
                </StageCard>

                <StageCard
                  n={7}
                  title="generate the answer"
                  last
                  params={[
                    { k: 'model', v: p.models.chat },
                    { k: 'thinking', v: p.models.thinking_level },
                    { k: 'temperature', v: String(p.models.temperature) },
                  ]}
                >
                  <Why>
                    The only step here that costs real money on a paid tier, and the only one that
                    takes seconds rather than milliseconds. It also spends thinking tokens you
                    never see — the signals tab counts them.
                  </Why>
                </StageCard>
              </ol>
            </motion.section>

            {/* ── The three caches, side by side ─────────────────────────── */}
            <motion.section
              variants={rise(reduce)}
              className="min-w-0 rounded-xl border border-line bg-ink-850 px-4 py-4 shadow-inset sm:px-5 sm:py-5 lg:col-span-2"
              aria-label="Cache layers"
            >
              <p className="eyebrow text-paper-dim">three caches, three different jobs</p>
              <ul className="mt-3.5 grid gap-3 md:grid-cols-3">
                {p.cache.layers.map((layer) => (
                  <li
                    key={layer.name}
                    className="rounded-lg border border-cache/25 bg-cache/[0.05] px-3.5 py-3"
                  >
                    <p className="font-mono text-2xs uppercase tracking-micro text-cache">
                      {layer.name}
                    </p>
                    <p className="mt-2 font-mono text-[1.35rem] leading-none tabular-nums text-paper">
                      {integer(layer.rows)}
                      <span className="ml-1.5 font-mono text-2xs uppercase tracking-micro text-paper-mute">
                        rows
                      </span>
                    </p>
                    <dl className="mt-2.5 space-y-1 text-[12.5px] leading-snug">
                      <div>
                        <dt className="inline text-paper-faint">keyed on </dt>
                        <dd className="inline font-mono text-2xs text-paper-dim">
                          {layer.keyed_on}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-paper-faint">avoids </dt>
                        <dd className="inline font-mono text-2xs text-paper-dim">{layer.avoids}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              <p className="mt-3 max-w-[46rem] font-serif text-[14px] leading-[1.65] text-paper-dim">
                They are not interchangeable. The embedding cache saves work at ingest and on
                repeated questions; the exact query cache saves an embedding call and a
                generation; the semantic query cache saves only the generation, because the
                question had to be embedded to be recognised in the first place.
              </p>
            </motion.section>
          </motion.div>
        )}
      </div>
    </div>
  );
}
