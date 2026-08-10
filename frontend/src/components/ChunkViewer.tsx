import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { ApiError, getChunks } from '../api';
import type { Chunk, DocumentMeta } from '../types';
import { formatBytes } from '../lib/format';
import { rise, stagger } from '../lib/motion';
import InspectorPanel from './InspectorPanel';

/**
 * Chunking is where most RAG results are won or lost, and it's the step
 * nobody shows. This lists exactly what the splitter produced, in order,
 * with a length bar so uneven chunking is obvious at a glance.
 */
export default function ChunkViewer({ doc, onClose }: { doc: DocumentMeta; onClose: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    setChunks(null);
    setError(null);

    getChunks(doc.id, controller.signal)
      .then((res) => {
        if (live) setChunks(res.chunks);
      })
      .catch((err: unknown) => {
        if (!live || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the chunks for this document.');
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [doc.id, attempt]);

  const longest = chunks && chunks.length > 0 ? Math.max(...chunks.map((c) => c.n_chars)) : 1;
  const mean =
    chunks && chunks.length > 0
      ? Math.round(chunks.reduce((sum, c) => sum + c.n_chars, 0) / chunks.length)
      : 0;

  return (
    <InspectorPanel
      title={doc.filename}
      subtitle={
        <>
          {formatBytes(doc.size_bytes)} · {doc.n_chars.toLocaleString()} chars ·{' '}
          {chunks ? `${chunks.length} chunks · mean ${mean.toLocaleString()}` : `${doc.n_chunks} chunks`}
        </>
      }
      onClose={onClose}
    >
      {error && (
        <div className="m-4 rounded-lg border border-alert/40 bg-alert/[0.06] px-3 py-3">
          <p className="font-mono text-2xs uppercase tracking-micro text-alert">chunks unavailable</p>
          <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
          <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
            <RefreshCw size={11} />
            try again
          </button>
        </div>
      )}

      {!chunks && !error && (
        <ul className="space-y-2 p-4" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="h-24 animate-breathe rounded-lg border border-line bg-ink-800" />
          ))}
        </ul>
      )}

      {chunks && chunks.length === 0 && !error && (
        <p className="p-4 text-[13.5px] leading-relaxed text-paper-mute">
          This document produced no chunks. Its text layer is probably empty — a scanned PDF
          with no OCR does this.
        </p>
      )}

      {chunks && chunks.length > 0 && (
        <motion.ul variants={stagger(reduce, 0.02)} initial="hidden" animate="show" className="space-y-2 p-4">
          {chunks.map((chunk) => (
            <motion.li
              key={chunk.id}
              variants={rise(reduce, 5)}
              className="rounded-lg border border-line bg-ink-800"
            >
              <div className="flex items-center gap-3 border-b border-line-soft px-3 py-2">
                <span className="font-mono text-2xs tabular-nums text-signal">
                  {String(chunk.chunk_index).padStart(2, '0')}
                </span>
                <span
                  className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700"
                  title={`${chunk.n_chars} characters`}
                >
                  <span
                    className="block h-full rounded-full bg-signal/45"
                    style={{ width: `${Math.max(2, (chunk.n_chars / longest) * 100)}%` }}
                  />
                </span>
                <span className="font-mono text-2xs tabular-nums text-paper-mute">
                  {chunk.n_chars.toLocaleString()}
                </span>
              </div>
              <p className="whitespace-pre-wrap px-3 py-2.5 font-serif text-[13px] leading-relaxed text-paper-dim">
                {chunk.content}
              </p>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </InspectorPanel>
  );
}
