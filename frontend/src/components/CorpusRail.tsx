import { AnimatePresence } from 'framer-motion';
import { Plus, RefreshCw } from 'lucide-react';
import type { DocumentMeta, Stats } from '../types';
import DocumentRow from './DocumentRow';

export default function CorpusRail({
  documents,
  loading,
  error,
  selectedIds,
  activeDocumentId,
  stats,
  onAdd,
  onToggle,
  onSelectAll,
  onOpenDocument,
  onDelete,
  onRetry,
}: {
  documents: DocumentMeta[];
  loading: boolean;
  error: string | null;
  selectedIds: Set<number>;
  activeDocumentId: number | null;
  /**
   * The server's own count of the corpus. It used to be printed a second time
   * in the sidebar's foot; it is stated once, here, where the documents are.
   * Null before the first poll lands, and the list's own totals stand in.
   */
  stats?: Stats | null;
  /** Opens the upload dialog. Ingestion no longer starts from the rail. */
  onAdd: () => void;
  onToggle: (id: number) => void;
  onSelectAll: (all: boolean) => void;
  onOpenDocument: (id: number) => void;
  onDelete: (id: number) => void;
  onRetry: () => void;
}) {
  const ready = documents.filter((d) => d.status === 'ready');
  const allSelected = ready.length > 0 && ready.every((d) => selectedIds.has(d.id));
  const totalChunks = ready.reduce((sum, d) => sum + d.n_chunks, 0);

  const nDocs = stats?.documents ?? documents.length;
  const nChunks = stats?.chunks ?? totalChunks;

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-5">
      <div className="flex items-baseline justify-between gap-2 px-4 pb-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.08em] text-paper-faint">Corpus</h2>
        {/* The size of the corpus, spelled out rather than abbreviated to
            "6 · 48 chunks" — it is the only place this is said now, so it
            can afford the two words. */}
        <span className="text-[11.5px] text-paper-faint">
          <span className="font-mono tabular-nums">{nDocs}</span> document{nDocs === 1 ? '' : 's'} ·{' '}
          <span className="font-mono tabular-nums">{nChunks}</span> chunk{nChunks === 1 ? '' : 's'}
        </span>
      </div>

      <div className="px-3 pb-1">
        <button
          type="button"
          onClick={onAdd}
          title="Analyse a file or a link and see what indexing it costs, before anything is spent"
          className="flex w-full items-center gap-2 rounded-xl border border-line bg-ink-850 px-3 py-2
                     text-[13px] font-medium text-paper-dim
                     transition-[background-color,border-color,color] duration-150
                     hover:border-signal/45 hover:bg-ink-800 hover:text-paper"
        >
          <Plus size={14} className="shrink-0 text-signal" />
          Add document
        </button>
      </div>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {documents.length > 0 && (
          <div className="mb-2 mt-4 flex items-center justify-between gap-2">
            <span className="text-[12px] text-paper-faint">
              In scope <span className="font-mono tabular-nums">{selectedIds.size}/{ready.length}</span>
            </span>
            <button
              type="button"
              onClick={() => onSelectAll(!allSelected)}
              disabled={ready.length === 0}
              className="rounded-md px-1.5 py-0.5 text-[12px] text-paper-mute
                         transition-colors duration-150 hover:bg-ink-800 hover:text-signal disabled:opacity-40"
            >
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-alert/35 bg-alert/[0.06] px-3 py-2.5">
            <p className="text-[12.5px] font-medium text-alert">The corpus didn't load</p>
            <p className="mt-1 text-[12px] leading-relaxed text-paper-dim">{error}</p>
            <button type="button" onClick={onRetry} className="btn mt-2">
              <RefreshCw size={12} />
              Try again
            </button>
          </div>
        )}

        {/* The placeholder has to be the shape of the thing arriving, and the
            thing arriving is now a 32px line, not a 52px card. */}
        {loading && documents.length === 0 && !error && (
          <ul className="mt-4 space-y-1" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-8 animate-breathe rounded-lg bg-ink-800" />
            ))}
          </ul>
        )}

        {!loading && !error && documents.length === 0 && (
          <p className="mt-5 px-1 text-[13px] leading-relaxed text-paper-mute">
            No documents yet. Whatever you add here becomes the only thing the model is
            allowed to answer from. Drop a file anywhere on this window, or add a link, to start.
          </p>
        )}

        {/* A hairline between rows rather than a gap between cards: at this
            density the eye needs a rule to run along, and a rule costs one
            pixel where a card cost a border on all four sides. */}
        <ul className="mt-1 divide-y divide-line/50">
          <AnimatePresence initial={false}>
            {documents.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                selected={selectedIds.has(doc.id)}
                active={activeDocumentId === doc.id}
                onToggle={onToggle}
                onOpen={onOpenDocument}
                onDelete={onDelete}
              />
            ))}
          </AnimatePresence>
        </ul>
      </div>

      {/* The rail's standing claim, at the foot of the panel where the list runs
          out. It used to spend two sentences explaining a checkbox — the second
          one ("untick a document and it leaves the search") only restated the
          first, and `In scope n/m` above the list already counts it. One clause
          is enough to state the rule; the tick boxes demonstrate it. */}
      {ready.length > 0 && (
        <p className="shrink-0 border-t border-line-soft px-4 pb-3 pt-2.5 text-[11.5px] leading-none text-paper-faint">
          Only ticked documents are searched.
        </p>
      )}
    </div>
  );
}
