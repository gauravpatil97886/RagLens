import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, Database, Maximize2, RefreshCw } from 'lucide-react';
import { ApiError } from '../api';
import {
  getInfra,
  getInfraExplain,
  getInfraTable,
  fixed,
  parsePretty,
  type ExplainPlan,
  type InfraCacheLayer,
  type InfraExplain,
  type InfraOverview,
  type InfraTable,
  type InfraVectors,
} from '../lib/infra';
import { formatBytes } from '../lib/format';
import { rise, stagger, transition } from '../lib/motion';
import { Panel, integer } from './figures';
import InfraTableBrowser from './InfraTableBrowser';
import InfraVectorDrawer from './InfraVectorDrawer';

/**
 * Look inside the database.
 *
 * A read-only window onto the Postgres/pgvector instance this demo runs on:
 * what is running, what a vector actually costs, what is in the six tables,
 * where the caches live, and whether the index is being used. There is no
 * endpoint here that accepts SQL and nothing on this page mutates anything.
 *
 * Two rules it keeps. Every number is measured — sizes come from
 * pg_total_relation_size, never estimated. And the one piece of judgement on
 * the page, the planner verdict, is written by the server and rendered
 * verbatim, so the explanation can never contradict the numbers beside it.
 */

const POLL_MS = 6000;

/* ── 1 · what is running ────────────────────────────────────────────────── */

function ServerStrip({ o }: { o: InfraOverview }) {
  const s = o.server;
  const items: { k: string; v: string; title?: string }[] = [
    { k: 'postgres', v: s.postgres_version },
    { k: 'pgvector', v: s.pgvector_version ?? 'not installed', title: 'Read from pg_extension.' },
    { k: 'database', v: s.database },
    { k: 'at', v: `${s.host}:${s.port}` },
    {
      k: 'on disk',
      v: s.database_pretty,
      title: `${integer(s.database_bytes)} bytes, from pg_database_size.`,
    },
    {
      k: 'connections',
      v: `${s.connections.active} / ${s.connections.max}`,
      title: 'Active backends against max_connections.',
    },
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

/* ── 2 · the vectors ────────────────────────────────────────────────────── */

function ExpansionBars({ v }: { v: InfraVectors }) {
  const reduce = useReducedMotion() ?? false;
  const peak = Math.max(1, v.vector_bytes, v.text_bytes);

  const bars = [
    {
      key: 'text',
      label: 'the text itself',
      bytes: v.text_bytes,
      className: 'bg-paper-faint',
    },
    {
      key: 'vectors',
      label: 'the vectors made from it',
      bytes: v.vector_bytes,
      className: 'bg-signal',
    },
  ];

  return (
    <div className="space-y-3">
      {bars.map((b) => (
        <div key={b.key}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="eyebrow">{b.label}</span>
            <span
              className="font-mono text-2xs tabular-nums text-paper-dim"
              title={`${integer(b.bytes)} bytes`}
            >
              {formatBytes(b.bytes)}
            </span>
          </div>
          <div className="mt-1.5 h-2.5 w-full rounded-[3px] bg-ink-800" aria-hidden="true">
            <motion.div
              className={`h-full rounded-[3px] ${b.className}`}
              initial={false}
              animate={{ width: `${(b.bytes / peak) * 100}%` }}
              transition={transition(reduce, 0.45)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function VectorsSection({
  v,
  onOpenOne,
  finding,
}: {
  v: InfraVectors;
  onOpenOne: () => void;
  finding: boolean;
}) {
  const empty = v.stored === 0;
  const dims = v.dimensions;
  const { min, max } = v.l2_norm;
  const measuredNorms = typeof min === 'number' && typeof max === 'number';
  const normalized = measuredNorms && Math.abs(min - 1) < 0.005 && Math.abs(max - 1) < 0.005;

  return (
    <Panel
      title="the vectors"
      hint="A vector is not a compressed copy of the text — it is a fixed-size fingerprint of what the text means. That is why the size does not depend on how long the chunk was: a six-word chunk and a four-hundred-word chunk both become exactly this many bytes."
      aside={
        <span className="font-mono text-2xs tabular-nums text-paper-faint">
          {integer(v.stored)} stored
        </span>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* The headline arithmetic. */}
        <div>
          <p className="font-mono text-[1.65rem] leading-none text-paper">
            {dims === null ? '—' : integer(dims)}
            <span className="ml-1.5 font-mono text-2xs uppercase tracking-micro text-paper-mute">
              dimensions each
            </span>
          </p>
          <p className="mt-2.5 text-[13.5px] leading-[1.6] text-paper-mute">
            {integer(v.stored)} {v.stored === 1 ? 'vector' : 'vectors'} stored, at{' '}
            <span className="font-mono tabular-nums text-paper-dim">
              {integer(v.bytes_per_vector)} B
            </span>{' '}
            apiece
            {dims !== null && <> — {integer(dims)} four-byte floats plus a four-byte header</>}.
          </p>

          <div className="mt-4 rounded-lg border border-line bg-ink-800 px-3.5 py-3">
            <p className="eyebrow">expansion</p>
            <p
              className={`mt-1 font-mono text-[2.1rem] leading-none ${
                v.expansion_ratio === null ? 'text-paper-faint' : 'text-signal'
              }`}
            >
              {fixed(v.expansion_ratio, 2)}
              {v.expansion_ratio !== null && <span className="text-[1.2rem]">×</span>}
            </p>
            <p className="mt-2 text-[12.5px] leading-snug text-paper-mute">
              {v.expansion_ratio === null ? (
                <>
                  Nothing is embedded yet. Once a document is indexed, this is the number to
                  watch: a corpus on disk is mostly vectors, not documents.
                </>
              ) : (
                <>
                  Every byte of text becomes {fixed(v.expansion_ratio, 2)} bytes of vector.
                  Embeddings are the expensive part of a corpus on disk, not the documents.
                </>
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={onOpenOne}
            disabled={v.stored === 0 || finding}
            className="btn btn-accent mt-3"
          >
            <Maximize2 size={11} />
            <span className="normal-case tracking-normal">
              {finding ? 'finding one…' : 'look inside one vector'}
            </span>
          </button>
        </div>

        <div className="min-w-0 space-y-5">
          <ExpansionBars v={v} />

          {/* L2 — the property everything downstream rests on. */}
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="eyebrow">vector length · ‖v‖</p>
              <p className="font-mono text-2xs tabular-nums text-paper-dim">
                min <span className="text-paper">{fixed(v.l2_norm.min, 4)}</span> · mean{' '}
                <span className="text-paper">{fixed(v.l2_norm.mean, 4)}</span> · max{' '}
                <span className="text-paper">{fixed(v.l2_norm.max, 4)}</span>
              </p>
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-paper-mute">
              {empty || !measuredNorms ? (
                <>
                  Nothing is stored yet, so there is no length to measure. When there is, every
                  one should read exactly 1.0 — that is what makes cosine similarity a valid
                  score rather than an arbitrary number.
                </>
              ) : normalized ? (
                <>
                  Every vector measured comes back on the unit sphere. That exact 1.0 is what
                  makes cosine similarity valid: with unit vectors, cosine distance and dot
                  product agree, and{' '}
                  <span className="font-mono text-2xs text-paper-dim">1 − distance</span> is a real
                  similarity score rather than an arbitrary number.
                </>
              ) : (
                <>
                  These are not all 1.0. Cosine similarity only behaves as a score when vectors are
                  normalized to unit length first — off the unit sphere,{' '}
                  <span className="font-mono text-2xs text-paper-dim">1 − distance</span> stops
                  being comparable between pairs.
                </>
              )}
            </p>
          </div>

          {/* How the search is actually done. */}
          <div>
            <p className="eyebrow">how they are searched</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {[
                { k: 'index', v: v.index_method ?? 'none' },
                { k: 'ops', v: v.index_ops ?? '—' },
                { k: 'operator', v: v.distance_operator },
                {
                  k: 'index size',
                  v: v.index_bytes === null ? '—' : formatBytes(v.index_bytes),
                  title:
                    v.index_bytes === null
                      ? 'No vector index exists on chunks yet.'
                      : `${integer(v.index_bytes)} bytes, from pg_indexes_size.`,
                },
              ].map((i) => (
                <li
                  key={i.k}
                  title={i.title}
                  className="rounded border border-line bg-ink-800 px-2 py-1 font-mono text-2xs tabular-nums text-paper-mute"
                >
                  {i.k} <span className="text-paper">{i.v}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ── 3 · the tables ─────────────────────────────────────────────────────── */

function SizeSplit({ t }: { t: InfraTable }) {
  const parts = [
    { key: 'heap', label: 'heap', pretty: t.heap_pretty, className: 'bg-paper-faint' },
    { key: 'index', label: 'index', pretty: t.index_pretty, className: 'bg-signal/70' },
    { key: 'toast', label: 'toast', pretty: t.toast_pretty, className: 'bg-ink-700' },
  ].map((p) => ({ ...p, bytes: parsePretty(p.pretty) }));

  const measured = parts.every((p) => p.bytes !== null);
  const sum = parts.reduce((acc, p) => acc + (p.bytes ?? 0), 0);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">where the {t.total_pretty} goes</p>
        <p className="font-mono text-2xs tabular-nums text-paper-faint" title={`${integer(t.total_bytes)} bytes`}>
          {t.total_pretty} total
        </p>
      </div>

      {measured && sum > 0 && (
        <div className="mt-1.5 flex h-2.5 w-full gap-0.5" aria-hidden="true">
          {parts.map((p) =>
            (p.bytes ?? 0) > 0 ? (
              <div
                key={p.key}
                className={`h-full rounded-[2px] ${p.className}`}
                style={{ width: `${((p.bytes ?? 0) / sum) * 100}%` }}
              />
            ) : null,
          )}
        </div>
      )}

      <dl className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-2xs tabular-nums text-paper-mute">
        {parts.map((p) => (
          <div key={p.key}>
            <dt className="inline text-paper-faint">{p.label} </dt>
            <dd className="inline text-paper-dim">{p.pretty}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5 text-[12.5px] leading-snug text-paper-mute">
        Heap is the rows themselves, index is what makes them findable, toast is the overflow
        store Postgres uses for values too big to sit inline.
      </p>
    </div>
  );
}

function TableCard({
  t,
  open,
  onToggle,
  onOpenVector,
}: {
  t: InfraTable;
  open: boolean;
  onToggle: () => void;
  onOpenVector: (chunkId: number) => void;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <li className="min-w-0 overflow-hidden rounded-xl border border-line bg-ink-850 shadow-inset">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-ink-800"
      >
        <ChevronRight
          size={13}
          className={`mt-1 shrink-0 text-paper-faint transition-transform duration-200 ${
            open ? 'rotate-90' : ''
          }`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[13.5px] text-paper">{t.name}</span>
            <span className="font-mono text-2xs tabular-nums text-paper-mute">
              {integer(t.rows)} {t.rows === 1 ? 'row' : 'rows'} · {t.total_pretty}
            </span>
            {t.indexes.some((i) => i.is_vector) && (
              <span className="rounded border border-signal/30 bg-signal/[0.08] px-1.5 py-0.5 font-mono text-2xs uppercase tracking-micro text-signal">
                vector index
              </span>
            )}
          </span>
          <span className="mt-1 block max-w-[46rem] text-[13px] leading-[1.6] text-paper-dim">
            {t.role}
          </span>
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: reduce ? 'auto' : 0, opacity: reduce ? 1 : 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: reduce ? 'auto' : 0, opacity: 0 }}
            transition={transition(reduce, 0.24)}
            className="overflow-hidden border-t border-line-soft"
          >
            <div className="space-y-4 px-4 py-3.5">
              <SizeSplit t={t} />

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="min-w-0">
                  <p className="eyebrow">columns</p>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {t.columns.map((c) => (
                      <li
                        key={c.name}
                        title={c.nullable ? `${c.name} is nullable` : `${c.name} is not null`}
                        className={`rounded border px-2 py-1 font-mono text-2xs ${
                          c.is_vector
                            ? 'border-signal/30 bg-signal/[0.07] text-signal'
                            : 'border-line bg-ink-800 text-paper-mute'
                        }`}
                      >
                        {c.name}{' '}
                        <span className="text-paper-faint">
                          {c.type}
                          {c.nullable ? '?' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="min-w-0">
                  <p className="eyebrow">indexes</p>
                  {t.indexes.length === 0 ? (
                    <p className="mt-1.5 text-[12.5px] text-paper-mute">
                      None. Every read of this table is a scan.
                    </p>
                  ) : (
                    <ul className="mt-1.5 space-y-1.5">
                      {t.indexes.map((idx) => (
                        <li
                          key={idx.name}
                          title={idx.definition}
                          className="rounded border border-line bg-ink-800 px-2 py-1.5"
                        >
                          <span className="font-mono text-2xs text-paper-dim">{idx.name}</span>
                          <span className="ml-2 font-mono text-2xs tabular-nums text-paper-faint">
                            {idx.method} · {idx.size_pretty}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div>
                <p className="eyebrow">the actual rows</p>
                <div className="mt-2">
                  <InfraTableBrowser table={t.name} onOpenVector={onOpenVector} />
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/* ── 5 · where the caches live ──────────────────────────────────────────── */

function CacheCard({ c }: { c: InfraCacheLayer }) {
  const inMemory = c.where === 'memory';
  return (
    <li
      className={`min-w-0 rounded-lg px-3.5 py-3 ${
        inMemory
          ? 'border border-dashed border-cache/35 bg-cache/[0.03]'
          : 'border border-cache/25 bg-cache/[0.05]'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-mono text-2xs uppercase tracking-micro text-cache">{c.layer}</p>
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-micro ${
            inMemory
              ? 'border border-dashed border-cache/45 text-cache-dim'
              : 'bg-cache/15 text-cache'
          }`}
          title={
            inMemory
              ? 'A process-local dictionary. It disappears when the server restarts.'
              : 'A real table. You can browse it above.'
          }
        >
          {c.where}
        </span>
      </div>

      <p className="mt-2 font-mono text-[1.35rem] leading-none tabular-nums text-paper">
        {integer(c.rows)}
        <span className="ml-1.5 font-mono text-2xs uppercase tracking-micro text-paper-mute">
          {c.rows === 1 ? 'entry' : 'entries'}
        </span>
        <span className="ml-2 font-mono text-2xs tabular-nums text-paper-faint">
          {c.size_pretty}
        </span>
      </p>

      <p className="mt-2 text-[12.5px] leading-[1.55] text-paper-dim">{c.what}</p>

      <dl className="mt-2 space-y-1 text-[12.5px] leading-snug">
        <div>
          <dt className="inline text-paper-faint">keyed on </dt>
          <dd className="inline font-mono text-2xs text-paper-mute">{c.key}</dd>
        </div>
        <div>
          <dt className="inline text-paper-faint">ttl </dt>
          <dd className="inline font-mono text-2xs text-paper-mute">
            {c.ttl ?? 'none — entries stay until they are cleared'}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function CachesSection({ o }: { o: InfraOverview }) {
  const inMemory = o.caches.filter((c) => c.where === 'memory').length;
  const inPostgres = o.caches.length - inMemory;
  const { exact_hits, semantic_hits, misses } = o.counters;

  return (
    <Panel
      title="where the caches live"
      hint={
        inMemory > 0
          ? `Not every cache is a table. ${inPostgres} of these ${o.caches.length} survive a restart because they are rows in Postgres; ${inMemory} ${inMemory === 1 ? 'is' : 'are'} a dictionary in the server process and ${inMemory === 1 ? 'is' : 'are'} gone the moment it stops.`
          : 'Every cache here is a table in Postgres, so all of them survive a restart.'
      }
      aside={
        <span className="font-mono text-2xs tabular-nums text-paper-faint">
          {exact_hits} exact · {semantic_hits} semantic · {misses} miss
          {misses === 1 ? '' : 'es'}
        </span>
      }
    >
      <ul className="grid gap-3 md:grid-cols-3">
        {o.caches.map((c) => (
          <CacheCard key={c.layer} c={c} />
        ))}
      </ul>
    </Panel>
  );
}

/* ── 6 · is the index used? ─────────────────────────────────────────────── */

function PlanCard({
  title,
  subtitle,
  plan,
  peakMs,
}: {
  title: string;
  subtitle: string;
  plan: ExplainPlan;
  peakMs: number;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <div className="min-w-0 rounded-lg border border-line bg-ink-800 px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="eyebrow text-paper-dim">{title}</p>
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-micro ${
            plan.uses_index
              ? 'border border-signal/30 bg-signal/[0.08] text-signal'
              : 'border border-line-strong text-paper-mute'
          }`}
        >
          {plan.uses_index ? 'uses the index' : 'scans the table'}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] leading-snug text-paper-mute">{subtitle}</p>

      <p className="mt-2.5 break-words font-mono text-[12.5px] leading-snug text-paper">
        {plan.plan}
      </p>

      <div className="mt-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="eyebrow">measured</span>
          <span className="font-mono text-[13px] tabular-nums text-paper">
            {plan.ms.toFixed(3)}
            <span className="ml-0.5 text-2xs text-paper-mute">ms</span>
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full rounded-[3px] bg-ink-750" aria-hidden="true">
          <motion.div
            className={`h-full rounded-[3px] ${plan.uses_index ? 'bg-signal' : 'bg-paper-faint'}`}
            initial={false}
            animate={{ width: `${Math.max(2, (plan.ms / peakMs) * 100)}%` }}
            transition={transition(reduce, 0.45)}
          />
        </div>
      </div>
    </div>
  );
}

function ExplainSection({
  explain,
  error,
  /** A 400 here means "no chunks yet", which is a state, not a failure. */
  notYet,
  onRetry,
}: {
  explain: InfraExplain | null;
  error: string | null;
  notYet: boolean;
  onRetry: () => void;
}) {
  return (
    <Panel
      title="is the index actually used?"
      aside={
        explain && (
          <span className="font-mono text-2xs tabular-nums text-paper-faint">
            {integer(explain.rows_in_table)} rows in chunks
          </span>
        )
      }
    >
      {error && notYet && (
        <p className="rounded-lg border border-dashed border-line-strong bg-ink-800 px-3.5 py-3 text-[13.5px] leading-relaxed text-paper-mute">
          {error} Index one and this page will price the two plans against each other.
        </p>
      )}

      {error && !notYet && (
        <div className="rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
          <p className="font-mono text-2xs uppercase tracking-micro text-alert">
            plan unavailable
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
          <button type="button" onClick={onRetry} className="btn mt-2.5">
            <RefreshCw size={11} />
            try again
          </button>
        </div>
      )}

      {!explain && !error && (
        <div className="space-y-3" aria-hidden="true">
          <div className="h-32 animate-breathe rounded-lg border border-line bg-ink-800" />
          <div className="h-16 animate-breathe rounded-lg border border-line bg-ink-800" />
        </div>
      )}

      {explain && (
        <div className="space-y-3.5">
          <p className="text-[13.5px] leading-[1.6] text-paper-mute">
            The real retrieval query, run twice through{' '}
            <span className="font-mono text-2xs text-paper-dim">EXPLAIN (ANALYZE, BUFFERS)</span> —
            once as the planner chooses, once with sequential scans switched off. Both run inside
            a transaction that is rolled back.
          </p>

          <pre className="scroll-quiet overflow-x-auto rounded border border-line bg-ink-900 px-2.5 py-2 font-mono text-2xs leading-relaxed text-paper-mute">
            {explain.query}
          </pre>

          <div className="grid gap-3 md:grid-cols-2">
            <PlanCard
              title="what the planner chose"
              subtitle="Left to its own devices, on the corpus as it stands now."
              plan={explain.chosen}
              peakMs={Math.max(explain.chosen.ms, explain.forced_index.ms, 0.001)}
            />
            <PlanCard
              title="forced onto the index"
              subtitle="Same query with enable_seqscan off, so the index has to be walked."
              plan={explain.forced_index}
              peakMs={Math.max(explain.chosen.ms, explain.forced_index.ms, 0.001)}
            />
          </div>

          {/* Verbatim, both of them. The server owns this text so it can never
              disagree with the timings printed directly above it. */}
          <div className="rounded-lg border-l-2 border-signal/60 bg-signal/[0.05] px-3.5 py-3">
            <p className="eyebrow text-signal">the server’s reading</p>
            <p className="mt-1.5 text-[14px] leading-[1.65] text-paper-dim">{explain.verdict}</p>
            <p className="mt-2 text-[13px] leading-[1.6] text-paper-mute">{explain.note}</p>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ── The view ───────────────────────────────────────────────────────────── */

function Skeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="h-52 animate-breathe rounded-xl border border-line bg-ink-850" />
      <div className="h-24 animate-breathe rounded-xl border border-line bg-ink-850" />
      <div className="h-24 animate-breathe rounded-xl border border-line bg-ink-850" />
      <div className="h-40 animate-breathe rounded-xl border border-line bg-ink-850" />
    </div>
  );
}

export default function InfraView() {
  const reduce = useReducedMotion() ?? false;
  const [overview, setOverview] = useState<InfraOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [explain, setExplain] = useState<InfraExplain | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explainStatus, setExplainStatus] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [explainAttempt, setExplainAttempt] = useState(0);
  const [openTable, setOpenTable] = useState<string | null>(null);
  const [vectorId, setVectorId] = useState<number | null>(null);
  const [finding, setFinding] = useState(false);
  const inFlight = useRef(false);

  // The overview carries no chunk ids, so "look inside one" borrows the row
  // browser's first page to find one. If that fails, fall back to opening the
  // chunks table — the long way round to the same place.
  const openOneVector = useCallback(async () => {
    setFinding(true);
    try {
      const first = await getInfraTable('chunks', 1, 0);
      const id = first.rows[0]?.['id'];
      if (typeof id === 'number') setVectorId(id);
      else setOpenTable('chunks');
    } catch {
      setOpenTable('chunks');
    } finally {
      setFinding(false);
    }
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    // A slow database shouldn't stack a request every six seconds.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await getInfra(signal);
      setOverview(next);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(
        err instanceof ApiError
          ? err.message
          : 'The inspector could not reach the database.',
      );
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, attempt]);

  // The plan is a real EXPLAIN ANALYZE against the live table — worth running
  // once when the page opens, not every six seconds.
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setExplainError(null);
    setExplainStatus(0);

    getInfraExplain(controller.signal)
      .then((next) => {
        if (live) setExplain(next);
      })
      .catch((err: unknown) => {
        if (!live || (err instanceof DOMException && err.name === 'AbortError')) return;
        setExplainError(err instanceof ApiError ? err.message : 'Could not run the query plan.');
        setExplainStatus(err instanceof ApiError ? err.status : 0);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [explainAttempt]);

  const stale = error !== null && overview !== null;

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[74rem] min-w-0 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <p className="eyebrow">the database</p>
            <h1 className="mt-2 max-w-[38rem] text-[1.75rem] font-semibold leading-[1.14] tracking-[-0.022em] text-paper sm:text-[2.05rem]">
              Everything this demo knows, exactly as Postgres is holding it
            </h1>
            <p className="mt-3 max-w-[42rem] text-[14.5px] leading-[1.65] text-paper-dim">
              Six tables, one vector index and three caches — read straight out of the catalog.
              Nothing on this page can change anything: there is no endpoint here that takes SQL.
            </p>
          </div>

          <p className="flex items-center gap-2 font-mono text-2xs uppercase tracking-micro text-paper-mute">
            <span
              className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-alert' : 'bg-cache'} ${
                stale || reduce ? '' : 'animate-breathe'
              }`}
              aria-hidden="true"
            />
            {stale ? 'stale' : `live · ${POLL_MS / 1000}s`}
          </p>
        </header>

        {overview && <ServerStrip o={overview} />}

        {error && (
          <div className="mt-5 rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
            <p className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-micro text-alert">
              <Database size={11} />
              {stale ? 'the inspector stopped updating' : 'the inspector could not reach the database'}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-paper-mute">
              Everything on this page is read live from Postgres, so there is nothing cached to
              show you in the meantime.
            </p>
            <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
              <RefreshCw size={11} />
              try again
            </button>
          </div>
        )}

        <div className="mt-6">
          {!overview && !error && <Skeleton />}

          {overview && (
            <motion.div
              variants={stagger(reduce, 0.05)}
              initial="hidden"
              animate="show"
              className="space-y-5"
            >
              <motion.div variants={rise(reduce)}>
                <VectorsSection
                  v={overview.vectors}
                  onOpenOne={() => void openOneVector()}
                  finding={finding}
                />
              </motion.div>

              <motion.section variants={rise(reduce)} aria-label="Tables">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="eyebrow text-paper-dim">
                    the {overview.tables.length} tables · open one to read its rows
                  </p>
                  <p className="font-mono text-2xs tabular-nums text-paper-faint">
                    {integer(overview.tables.reduce((n, t) => n + t.rows, 0))} rows in total
                  </p>
                </div>
                <ul className="mt-2.5 space-y-2">
                  {overview.tables.map((t) => (
                    <TableCard
                      key={t.name}
                      t={t}
                      open={openTable === t.name}
                      onToggle={() => setOpenTable((cur) => (cur === t.name ? null : t.name))}
                      onOpenVector={setVectorId}
                    />
                  ))}
                </ul>
              </motion.section>

              <motion.div variants={rise(reduce)}>
                <CachesSection o={overview} />
              </motion.div>

              <motion.div variants={rise(reduce)}>
                <ExplainSection
                  explain={explain}
                  error={explainError}
                  notYet={explainStatus === 400}
                  onRetry={() => setExplainAttempt((a) => a + 1)}
                />
              </motion.div>

              <motion.p
                variants={rise(reduce)}
                className="pb-2 font-mono text-2xs leading-relaxed text-paper-faint"
              >
                Sizes come from pg_total_relation_size and pg_indexes_size — measured, never
                estimated. Table access is limited to a fixed whitelist and every query on this
                page is a read.
              </motion.p>
            </motion.div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {vectorId !== null && (
          <InfraVectorDrawer
            chunkId={vectorId}
            onOpen={setVectorId}
            onClose={() => setVectorId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
