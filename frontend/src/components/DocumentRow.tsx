import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, ExternalLink, Link2, Trash2, AlertTriangle } from 'lucide-react';
import type { DocumentMeta } from '../types';
import { formatBytes } from '../lib/format';
import { transition } from '../lib/motion';

const STATUS: Record<DocumentMeta['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'border-line-strong text-paper-mute' },
  processing: { label: 'Working', className: 'border-signal/45 text-signal animate-breathe' },
  // Kept in the map because other code reads it, but never rendered — see below.
  ready: { label: 'Ready', className: 'border-line-strong text-paper-mute' },
  failed: { label: 'Failed', className: 'border-alert/50 text-alert' },
};

/**
 * One document, one line.
 *
 * This used to be a bordered, filled card about a hundred pixels tall: a title,
 * a second line for the site or the byte size, a chunk count and a `Ready` pill.
 * Six of those filled the rail edge to edge and the corpus read as a wall of
 * boxes — every document the same weight, none of them scannable. So the card
 * is gone. The resting row has no border and no fill; it is the checkbox, the
 * name, and the chunk count, and the list separates its rows with a hairline.
 * Everything else has moved to hover, to the tooltip, or away.
 *
 * The rejected alternative was keeping the card and shrinking its padding. That
 * only makes six small boxes: the border is the thing that fragments the list,
 * not the height.
 */
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
   * is its title; a file's is its filename.
   *
   * Nothing is cut in JS. A character-count truncation and the CSS `truncate`
   * both fire on a long name and you get two ellipses in a row —
   * `How Instacart Built a Mod.….` — which reads as a rendering fault rather
   * than a shortened name. CSS alone knows the actual width, so it is the only
   * one that trims; the full name is in the tooltip either way.
   */
  const isUrl = doc.source_type === 'url';
  const full = isUrl ? (doc.title ?? doc.filename) : doc.filename;
  const primary = full;

  /**
   * The site name and the byte size were their own line under the title, and
   * that line was most of the row's height while being truncated to
   * `martinfowler.c…` — unreadable and unscannable at once. They are not lost:
   * they ride in the tooltip with the full name, and the link glyph still tells
   * a page apart from a file at a glance, which is the job that line was
   * actually doing.
   */
  const secondary = isUrl ? doc.site_name : formatBytes(doc.size_bytes);
  const tip = [full, secondary].filter(Boolean).join(' · ');

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
      exit={{ opacity: 0, height: 0 }}
      transition={transition(reduce)}
      className={[
        'group overflow-hidden rounded-lg transition-colors duration-150',
        // Only the *open* document is filled. Ticked is the common case — six of
        // six, normally — so filling on `selected` would rebuild the wall the
        // card was; the checkbox already carries that state.
        active ? 'bg-ink-800' : 'hover:bg-ink-800/60',
      ].join(' ')}
    >
      <div className="flex h-8 items-center gap-2 px-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected && selectable}
          disabled={!selectable}
          onClick={() => onToggle(doc.id)}
          title={selectable ? 'Include this document when answering' : 'Only ready documents can be searched'}
          className={[
            'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-150',
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
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={`${tip} — open its chunks`}
        >
          {isUrl && <Link2 size={11} className="shrink-0 text-signal" aria-label="From a link" />}
          <span className="min-w-0 flex-1 truncate text-[13px] text-paper">{primary}</span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {/* A badge on every row is not a badge. `Ready` was on all six of
              them, so it said nothing; the states worth interrupting for —
              pending, working, failed — keep their pill exactly as it was. */}
          {doc.status !== 'ready' && (
            <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${status.className}`}>
              {status.label}
            </span>
          )}

          {doc.status === 'ready' && (
            <span
              className="font-mono text-[11.5px] tabular-nums text-paper-faint"
              title={`${doc.n_chunks} chunks`}
            >
              {doc.n_chunks}
              <span className="sr-only"> chunks</span>
            </span>
          )}

          {/* Hover- and focus-only, and faded rather than unmounted: `hidden`
              would take them out of the tab order, and holding their space
              stops the chunk count jumping sideways as the pointer arrives. */}
          {isUrl && doc.source_url && (
            <a
              href={doc.source_url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${doc.source_url}`}
              aria-label={`Open the original page for ${full} in a new tab`}
              className="rounded p-0.5 text-paper-faint opacity-0 transition-[color,opacity] duration-150
                         hover:text-signal focus-visible:opacity-100 group-focus-within:opacity-100
                         group-hover:opacity-100"
            >
              <ExternalLink size={12} />
            </a>
          )}

          <button
            type="button"
            onClick={() => (confirming ? onDelete(doc.id) : setConfirming(true))}
            title={confirming ? 'Click again to delete' : `Delete ${full}`}
            aria-label={confirming ? `Confirm deleting ${full}` : `Delete ${full}`}
            className={[
              'rounded p-0.5 transition-[color,opacity] duration-150',
              confirming
                ? 'text-alert'
                : `text-paper-faint opacity-0 hover:text-alert focus-visible:opacity-100
                   group-focus-within:opacity-100 group-hover:opacity-100`,
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
          className="border-t border-alert/25 bg-alert/[0.06] px-2 py-1.5 font-mono text-2xs text-alert"
        >
          delete this document and its chunks? click the bin again
        </motion.p>
      )}

      {doc.status === 'failed' && doc.error && (
        <div className="flex items-start gap-1.5 border-t border-alert/25 bg-alert/[0.05] px-2 py-1.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0 text-alert" />
          <p className="text-2xs leading-relaxed text-paper-dim">{doc.error}</p>
        </div>
      )}
    </motion.li>
  );
}
