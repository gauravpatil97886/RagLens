import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, ExternalLink, Link2, Trash2, AlertTriangle } from 'lucide-react';
import type { DocumentMeta } from '../types';
import { formatBytes, truncateMiddle } from '../lib/format';
import { transition } from '../lib/motion';

const STATUS: Record<DocumentMeta['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'border-line-strong text-paper-mute' },
  processing: { label: 'Working', className: 'border-signal/45 text-signal animate-breathe' },
  ready: { label: 'Ready', className: 'border-line-strong text-paper-mute' },
  failed: { label: 'Failed', className: 'border-alert/50 text-alert' },
};

export default function DocumentRow({
  doc,
  selected,
  active,
  onToggle,
  onOpen,
  onDelete,
}: {
  doc: DocumentMeta;
  selected: boolean;
  active: boolean;
  onToggle: (id: number) => void;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [confirming, setConfirming] = useState(false);
  const status = STATUS[doc.status] ?? STATUS.pending;
  const selectable = doc.status === 'ready';

  /**
   * A page and a file are the same kind of thing to the retriever, so the row
   * is the same row — it only changes what it calls the document. A page's name
   * is its title, and the thing that tells you which page it is, is the site it
   * came from. The bytes stay on the file, where they mean something.
   */
  const isUrl = doc.source_type === 'url';
  const primary = isUrl ? (doc.title ?? doc.filename) : truncateMiddle(doc.filename, 26);
  const secondary = isUrl ? doc.site_name : formatBytes(doc.size_bytes);

  // A confirm that hangs around forever becomes a trap.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  return (
    <motion.li
      layout={!reduce}
      initial={{ opacity: 0, y: reduce ? 0 : -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={transition(reduce)}
      className={[
        'group overflow-hidden rounded-xl border transition-colors duration-150',
        active ? 'border-signal/50 bg-ink-800' : 'border-line bg-ink-850 hover:border-line-strong',
      ].join(' ')}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected && selectable}
          disabled={!selectable}
          onClick={() => onToggle(doc.id)}
          title={selectable ? 'Include this document when answering' : 'Only ready documents can be searched'}
          className={[
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-150',
            !selectable
              ? 'cursor-not-allowed border-line text-transparent'
              : selected
                ? 'border-signal bg-signal text-onaccent'
                : 'border-line-strong text-transparent hover:border-paper-mute',
          ].join(' ')}
        >
          <Check size={11} strokeWidth={3.5} />
        </button>

        <button
          type="button"
          onClick={() => onOpen(doc.id)}
          className="min-w-0 flex-1 text-left"
          title={`${primary} — open its chunks`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {isUrl && <Link2 size={11} className="shrink-0 text-signal" aria-label="From a link" />}
            <span className="min-w-0 flex-1 truncate text-[13px] text-paper">{primary}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-2xs tabular-nums text-paper-mute">
            {/* shrink-0 so the flex row wraps the chunk count onto a second
                line rather than eating into a hostname that is the whole point
                of the line. `max-w-full` still catches an absurd one. */}
            {secondary && <span className="max-w-full shrink-0 truncate">{secondary}</span>}
            {doc.status === 'ready' && (
              <>
                {secondary && <span className="text-paper-faint">·</span>}
                <span>{doc.n_chunks} chunks</span>
              </>
            )}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {isUrl && doc.source_url && (
            <a
              href={doc.source_url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${doc.source_url}`}
              aria-label={`Open the original page for ${primary} in a new tab`}
              className="rounded p-1 text-paper-faint opacity-0 transition-colors duration-150
                         hover:text-signal focus-visible:opacity-100 group-hover:opacity-100"
            >
              <ExternalLink size={12} />
            </a>
          )}

          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${status.className}`}
          >
            {status.label}
          </span>

          <button
            type="button"
            onClick={() => (confirming ? onDelete(doc.id) : setConfirming(true))}
            title={confirming ? 'Click again to delete' : `Delete ${primary}`}
            className={[
              'rounded p-1 transition-colors duration-150',
              confirming
                ? 'text-alert'
                : 'text-paper-faint opacity-0 hover:text-alert focus-visible:opacity-100 group-hover:opacity-100',
            ].join(' ')}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {confirming && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={transition(reduce, 0.15)}
          className="border-t border-alert/25 bg-alert/[0.06] px-2.5 py-1.5 font-mono text-2xs text-alert"
        >
          delete this document and its chunks? click the bin again
        </motion.p>
      )}

      {doc.status === 'failed' && doc.error && (
        <div className="flex items-start gap-1.5 border-t border-alert/25 bg-alert/[0.05] px-2.5 py-1.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0 text-alert" />
          <p className="text-2xs leading-relaxed text-paper-dim">{doc.error}</p>
        </div>
      )}
    </motion.li>
  );
}
