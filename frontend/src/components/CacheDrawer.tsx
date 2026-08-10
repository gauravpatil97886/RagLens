import { useCallback, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, clearCache, listCache } from '../api';
import type { CacheEntry } from '../types';
import { formatSince } from '../lib/format';
import { rise, stagger } from '../lib/motion';
import InspectorPanel from './InspectorPanel';

export default function CacheDrawer({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [entries, setEntries] = useState<CacheEntry[] | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    setError(null);
    listCache(controller.signal)
      .then((res) => {
        if (!live) return;
        setEntries(res.entries);
        setThreshold(res.threshold);
      })
      .catch((err: unknown) => {
        if (!live || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the cache.');
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [attempt]);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const doClear = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      const res = await clearCache();
      setCleared(res.deleted);
      setEntries([]);
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clear the cache.');
    } finally {
      setClearing(false);
    }
  }, [onChanged]);

  return (
    <InspectorPanel
      title="Semantic cache"
      subtitle={
        threshold !== null ? (
          <>match threshold {threshold.toFixed(2)} cosine</>
        ) : (
          <>answers reused instead of regenerated</>
        )
      }
      onClose={onClose}
      toolbar={
        <button
          type="button"
          onClick={() => (confirming ? void doClear() : setConfirming(true))}
          disabled={clearing || (entries !== null && entries.length === 0)}
          className={`btn ${confirming ? 'border-alert/60 text-alert' : 'btn-danger'}`}
        >
          <Trash2 size={11} />
          {clearing ? 'clearing' : confirming ? 'confirm' : 'clear'}
        </button>
      }
    >
      {cleared !== null && (
        <motion.p
          initial={{ opacity: 0, y: reduce ? 0 : -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="border-b border-line bg-cache/[0.07] px-4 py-2.5 font-mono text-2xs text-cache"
        >
          cleared {cleared} {cleared === 1 ? 'entry' : 'entries'} · ask the same question again to
          watch it miss, then hit
        </motion.p>
      )}

      {error && (
        <div className="m-4 rounded-lg border border-alert/40 bg-alert/[0.06] px-3 py-3">
          <p className="font-mono text-2xs uppercase tracking-micro text-alert">cache unavailable</p>
          <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
          <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
            <RefreshCw size={11} />
            try again
          </button>
        </div>
      )}

      {!entries && !error && (
        <ul className="space-y-2 p-4" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-20 animate-breathe rounded-lg border border-line bg-ink-800" />
          ))}
        </ul>
      )}

      {entries && entries.length === 0 && !error && (
        <p className="p-4 text-[13.5px] leading-relaxed text-paper-mute">
          The cache is empty. Every question here is currently a fresh model call — ask one
          twice and the second answer will be served from this list.
        </p>
      )}

      {entries && entries.length > 0 && (
        <motion.ul variants={stagger(reduce, 0.03)} initial="hidden" animate="show" className="space-y-2 p-4">
          {entries.map((entry) => (
            <motion.li
              key={entry.id}
              variants={rise(reduce, 5)}
              className="rounded-lg border border-line bg-ink-800 px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="font-serif text-[14px] leading-snug text-paper">{entry.question}</p>
                <span
                  className={[
                    'shrink-0 rounded-full px-2 py-0.5 font-mono text-2xs tabular-nums',
                    entry.hits > 0 ? 'bg-cache/15 text-cache' : 'bg-ink-700 text-paper-mute',
                  ].join(' ')}
                  title={`${entry.hits} reuse${entry.hits === 1 ? '' : 's'}`}
                >
                  {entry.hits}×
                </span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-paper-mute">
                {entry.answer_preview}
              </p>
              <p className="mt-2 font-mono text-2xs tabular-nums text-paper-faint">
                stored {formatSince(entry.created_at)} · last hit {formatSince(entry.last_hit_at)}
              </p>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </InspectorPanel>
  );
}
