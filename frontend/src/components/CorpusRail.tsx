import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { RefreshCw, X } from 'lucide-react';
import type { DocumentMeta, UploadTask } from '../types';
import { transition } from '../lib/motion';
import DocumentRow from './DocumentRow';
import IngestCard from './IngestCard';
import UploadZone from './UploadZone';

export default function CorpusRail({
  documents,
  loading,
  error,
  uploads,
  selectedIds,
  activeDocumentId,
  onFiles,
  onDismissUpload,
  onToggle,
  onSelectAll,
  onOpenDocument,
  onDelete,
  onRetry,
  onClose,
}: {
  documents: DocumentMeta[];
  loading: boolean;
  error: string | null;
  uploads: UploadTask[];
  selectedIds: Set<number>;
  activeDocumentId: number | null;
  onFiles: (files: File[]) => void;
  onDismissUpload: (id: string) => void;
  onToggle: (id: number) => void;
  onSelectAll: (all: boolean) => void;
  onOpenDocument: (id: number) => void;
  onDelete: (id: number) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const ready = documents.filter((d) => d.status === 'ready');
  const allSelected = ready.length > 0 && ready.every((d) => selectedIds.has(d.id));
  const totalChunks = ready.reduce((sum, d) => sum + d.n_chunks, 0);

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-line bg-ink-850">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="eyebrow text-paper-dim">corpus</h2>
          <span className="font-mono text-2xs tabular-nums text-paper-faint">
            {documents.length} · {totalChunks} chunks
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-paper-mute hover:text-paper lg:hidden"
          aria-label="Close the corpus panel"
        >
          <X size={15} />
        </button>
      </header>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <UploadZone onFiles={onFiles} busy={uploads.length > 0} />

        <AnimatePresence initial={false}>
          {uploads.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition(reduce, 0.15)}
            >
              <ul className="mt-3 space-y-2">
                <AnimatePresence initial={false}>
                  {uploads.map((task) => (
                    <IngestCard key={task.id} task={task} onDismiss={onDismissUpload} />
                  ))}
                </AnimatePresence>
              </ul>
            </motion.div>
          )}
        </AnimatePresence>

        {documents.length > 0 && (
          <div className="mb-2 mt-5 flex items-center justify-between gap-2">
            <span className="eyebrow">
              scope · {selectedIds.size}/{ready.length}
            </span>
            <button
              type="button"
              onClick={() => onSelectAll(!allSelected)}
              disabled={ready.length === 0}
              className="font-mono text-2xs uppercase tracking-micro text-paper-mute
                         transition-colors hover:text-signal disabled:opacity-40"
            >
              {allSelected ? 'none' : 'all'}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-alert/40 bg-alert/[0.06] px-3 py-2.5">
            <p className="font-mono text-2xs uppercase tracking-micro text-alert">corpus unavailable</p>
            <p className="mt-1 text-2xs leading-relaxed text-paper-dim">{error}</p>
            <button type="button" onClick={onRetry} className="btn mt-2">
              <RefreshCw size={11} />
              try again
            </button>
          </div>
        )}

        {loading && documents.length === 0 && !error && (
          <ul className="mt-4 space-y-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-[52px] animate-breathe rounded-lg border border-line bg-ink-800" />
            ))}
          </ul>
        )}

        {!loading && !error && documents.length === 0 && uploads.length === 0 && (
          <p className="mt-5 px-1 text-[13px] leading-relaxed text-paper-mute">
            No documents yet. Whatever you add here becomes the only thing the model is
            allowed to answer from.
          </p>
        )}

        <ul className="mt-2 space-y-2">
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
    </div>
  );
}
