import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  ApiError,
  deleteDocument,
  getHealth,
  getStats,
  listDocuments,
  streamChat,
  streamUpload,
} from './api';
import type {
  AssistantTurn,
  ChunkTile,
  DocumentMeta,
  Health,
  IngestEvent,
  Stats,
  StreamEvent,
  Turn,
  UploadTask,
} from './types';
import CacheDrawer from './components/CacheDrawer';
import ChatPanel from './components/ChatPanel';
import ChunkViewer from './components/ChunkViewer';
import CorpusRail from './components/CorpusRail';
import Header from './components/Header';
import Toasts, { type Toast } from './components/Toasts';
import { screenFile } from './components/UploadZone';

type Inspector = { kind: 'chunks'; documentId: number } | { kind: 'cache' } | null;

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

const POLL_MS = 6000;

export default function App() {
  /* ── Corpus ───────────────────────────────────────────────────────────── */
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const knownReady = useRef<Set<number>>(new Set());

  /* ── Conversation ─────────────────────────────────────────────────────── */
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /* ── Chrome ───────────────────────────────────────────────────────────── */
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [inspector, setInspector] = useState<Inspector>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((message: string, tone: Toast['tone'] = 'error') => {
    const toast: Toast = { id: uid('toast'), message, tone };
    setToasts((prev) => [...prev.slice(-2), toast]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== toast.id));
    }, 7000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /* ── Loading ──────────────────────────────────────────────────────────── */

  const refreshDocuments = useCallback(async () => {
    try {
      const res = await listDocuments();
      setDocuments(res.documents);
      setDocsError(null);
    } catch (err) {
      setDocsError(err instanceof ApiError ? err.message : 'Could not load the document list.');
    } finally {
      setDocsLoading(false);
    }
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const [nextStats, nextHealth] = await Promise.all([getStats(), getHealth()]);
      setStats(nextStats);
      setHealth(nextHealth);
      setUnreachable(false);
    } catch (err) {
      // A dead backend shouldn't spam toasts every poll — the header dot says it.
      if (err instanceof ApiError && err.status === 0) setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    void refreshDocuments();
    void refreshStats();
  }, [refreshDocuments, refreshStats]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshStats(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshStats]);

  // A document left mid-flight (a dropped ingest stream) shouldn't stay stale.
  useEffect(() => {
    const settling = documents.some((d) => d.status === 'pending' || d.status === 'processing');
    if (!settling) return;
    const timer = window.setInterval(() => void refreshDocuments(), 2500);
    return () => window.clearInterval(timer);
  }, [documents, refreshDocuments]);

  /* ── Scope selection ──────────────────────────────────────────────────── */
  // New (and newly ready) documents join the scope; anything the reader
  // explicitly unticked stays unticked.
  useEffect(() => {
    const readyIds = documents.filter((d) => d.status === 'ready').map((d) => d.id);
    setSelected((prev) => {
      const next = new Set<number>();
      for (const id of readyIds) {
        if (!knownReady.current.has(id) || prev.has(id)) next.add(id);
      }
      return next;
    });
    knownReady.current = new Set(readyIds);
  }, [documents]);

  const readyDocs = documents.filter((d) => d.status === 'ready');
  const allSelected = readyDocs.length > 0 && selected.size === readyDocs.length;

  const scopeLabel =
    readyDocs.length === 0
      ? 'no documents ingested'
      : selected.size === 0
        ? 'select a document to search'
        : allSelected
          ? `searching all ${readyDocs.length} document${readyDocs.length === 1 ? '' : 's'}`
          : `searching ${selected.size} of ${readyDocs.length} documents`;

  const toggleDocument = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(
    (all: boolean) => {
      setSelected(all ? new Set(readyDocs.map((d) => d.id)) : new Set());
    },
    [readyDocs],
  );

  /* ── Upload ───────────────────────────────────────────────────────────── */

  const patchUpload = useCallback((id: string, fn: (task: UploadTask) => UploadTask) => {
    setUploads((prev) => prev.map((task) => (task.id === id ? fn(task) : task)));
  }, []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      // Ingestion is CPU-bound on the server. One at a time.
      for (const file of files) {
        const rejection = screenFile(file);
        if (rejection) {
          pushToast(rejection);
          continue;
        }

        const task: UploadTask = {
          id: uid('upload'),
          filename: file.name,
          size: file.size,
          startedAt: Date.now(),
          stage: 'queued',
          label: 'uploading',
          nChars: null,
          chunks: [],
          nChunksSeen: 0,
          nChunks: null,
          embed: null,
          error: null,
        };
        setUploads((prev) => [...prev, task]);

        // Chunk frames arrive in a burst — the splitter is fast. Coalesce them onto
        // animation frames so React commits once per frame, not once per chunk.
        let pendingChunks: ChunkTile[] = [];
        let frame: number | null = null;

        const flushChunks = () => {
          frame = null;
          if (pendingChunks.length === 0) return;
          const batch = pendingChunks;
          pendingChunks = [];
          patchUpload(task.id, (t) => ({
            ...t,
            // Only the newest few are rendered; keeping a few spare makes the
            // exit animation look right without holding a whole document in state.
            chunks: [...t.chunks, ...batch].slice(-8),
            nChunksSeen: t.nChunksSeen + batch.length,
          }));
        };

        const flushNow = () => {
          if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
          }
          flushChunks();
        };

        // A box, not a bare `let`: the assignment happens inside a callback, and TS
        // won't see it otherwise.
        const settled: { doc: DocumentMeta | null } = { doc: null };

        const onEvent = (event: IngestEvent) => {
          switch (event.type) {
            case 'stage':
              flushNow();
              patchUpload(task.id, (t) => ({
                ...t,
                stage: event.stage,
                label: event.label,
                nChars: event.n_chars ?? t.nChars,
              }));
              break;
            case 'chunk':
              pendingChunks.push({
                index: event.index,
                nChars: event.n_chars,
                preview: event.preview,
              });
              if (frame === null) frame = requestAnimationFrame(flushChunks);
              break;
            case 'chunked':
              flushNow();
              patchUpload(task.id, (t) => ({
                ...t,
                stage: 'chunked',
                label: event.label,
                nChunks: event.n_chunks,
                nChunksSeen: event.n_chunks,
              }));
              break;
            case 'embedding':
              patchUpload(task.id, (t) => ({
                ...t,
                embed: {
                  done: event.done,
                  total: event.total,
                  cached: event.cached,
                  apiCalls: event.api_calls,
                },
              }));
              break;
            case 'done':
              flushNow();
              settled.doc = event.document;
              break;
            case 'error':
              flushNow();
              patchUpload(task.id, (t) => ({ ...t, error: event.detail }));
              break;
          }
        };

        try {
          await streamUpload(file, onEvent);
          const doc = settled.doc;
          if (doc) {
            setUploads((prev) => prev.filter((t) => t.id !== task.id));
            setDocuments((prev) => [doc, ...prev.filter((d) => d.id !== doc.id)]);
            if (doc.status === 'failed') {
              pushToast(doc.error ?? `${doc.filename} could not be ingested.`);
            }
          } else {
            // Stream closed without a verdict. Say so rather than pretending.
            patchUpload(task.id, (t) =>
              t.error
                ? t
                : { ...t, error: `Ingestion of ${file.name} ended before it finished.` },
            );
            void refreshDocuments();
          }
        } catch (err) {
          flushNow();
          const message =
            err instanceof ApiError ? err.message : `${file.name} could not be uploaded.`;
          patchUpload(task.id, (t) => ({ ...t, error: message }));
        } finally {
          void refreshStats();
        }
      }
    },
    [patchUpload, pushToast, refreshDocuments, refreshStats],
  );

  const dismissUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleDelete = useCallback(
    async (id: number) => {
      const previous = documents;
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      setInspector((cur) => (cur?.kind === 'chunks' && cur.documentId === id ? null : cur));
      try {
        await deleteDocument(id);
        void refreshStats();
      } catch (err) {
        setDocuments(previous);
        pushToast(err instanceof ApiError ? err.message : 'Could not delete that document.');
      }
    },
    [documents, pushToast, refreshStats],
  );

  /* ── Ask ──────────────────────────────────────────────────────────────── */

  const patchAssistant = useCallback((id: string, fn: (turn: AssistantTurn) => AssistantTurn) => {
    setTurns((prev) =>
      prev.map((turn) => (turn.id === id && turn.role === 'assistant' ? fn(turn) : turn)),
    );
  }, []);

  const ask = useCallback(
    (question: string) => {
      if (busy) return;
      if (readyDocs.length === 0 || selected.size === 0) return;

      const scopeIds = allSelected ? null : Array.from(selected);
      const assistantId = uid('a');

      setTurns((prev) => [
        ...prev,
        { id: uid('u'), role: 'user', text: question, scopedTo: scopeIds },
        {
          id: assistantId,
          role: 'assistant',
          question,
          phase: 'embedding',
          text: '',
          citations: null,
          cache: null,
          timings: null,
          error: null,
          startedAt: Date.now(),
        },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);

      // Tokens land every few milliseconds. Coalesce them onto animation
      // frames so React commits ~60 times a second instead of ~160.
      let pending = '';
      let frame: number | null = null;

      const flush = () => {
        frame = null;
        if (!pending) return;
        const chunk = pending;
        pending = '';
        patchAssistant(assistantId, (turn) => ({
          ...turn,
          text: turn.text + chunk,
          phase: turn.phase === 'done' || turn.phase === 'error' ? turn.phase : 'generating',
        }));
      };

      const flushNow = () => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        flush();
      };

      let sawDone = false;

      const onEvent = (event: StreamEvent) => {
        switch (event.type) {
          case 'cache':
            patchAssistant(assistantId, (turn) => ({ ...turn, cache: event.cache, phase: 'retrieving' }));
            break;
          case 'retrieval':
            patchAssistant(assistantId, (turn) => ({
              ...turn,
              citations: event.citations,
              phase: turn.phase === 'generating' ? turn.phase : 'retrieving',
            }));
            break;
          case 'token':
            pending += event.text;
            if (frame === null) frame = requestAnimationFrame(flush);
            break;
          case 'done':
            sawDone = true;
            flushNow();
            patchAssistant(assistantId, (turn) => ({
              ...turn,
              phase: 'done',
              cache: event.cache ?? turn.cache,
              timings: event.timings_ms,
            }));
            break;
          case 'error':
            sawDone = true;
            flushNow();
            patchAssistant(assistantId, (turn) => ({
              ...turn,
              phase: 'error',
              error: event.detail,
            }));
            break;
        }
      };

      streamChat({ question, document_ids: scopeIds }, onEvent, controller.signal)
        .then(() => {
          flushNow();
          if (!sawDone) {
            // Stream closed early. Keep whatever text arrived rather than
            // throwing it away, but don't claim a timing we never got.
            patchAssistant(assistantId, (turn) =>
              turn.phase === 'error' ? turn : { ...turn, phase: 'done' },
            );
          }
        })
        .catch((err: unknown) => {
          flushNow();
          if (err instanceof DOMException && err.name === 'AbortError') {
            patchAssistant(assistantId, (turn) => ({ ...turn, phase: 'done' }));
            return;
          }
          const message =
            err instanceof ApiError ? err.message : 'The answer stream failed unexpectedly.';
          patchAssistant(assistantId, (turn) => ({ ...turn, phase: 'error', error: message }));
          pushToast(message);
        })
        .finally(() => {
          if (abortRef.current === controller) abortRef.current = null;
          setBusy(false);
          void refreshStats();
        });
    },
    [busy, readyDocs.length, selected, allSelected, patchAssistant, pushToast, refreshStats],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Don't leave a stream running if the tab unmounts mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  /* ── Inspector ────────────────────────────────────────────────────────── */

  const openDocument = useCallback((documentId: number) => {
    setInspector({ kind: 'chunks', documentId });
    setRailOpen(false);
  }, []);

  const closeInspector = useCallback(() => setInspector(null), []);

  const inspectedDoc =
    inspector?.kind === 'chunks' ? (documents.find((d) => d.id === inspector.documentId) ?? null) : null;

  /* ── Render ───────────────────────────────────────────────────────────── */

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <Header
        stats={stats}
        health={health}
        unreachable={unreachable}
        onOpenCache={() => setInspector({ kind: 'cache' })}
        onToggleRail={() => setRailOpen((v) => !v)}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* Backdrop for the rail, below the lg breakpoint only. */}
        {railOpen && (
          <button
            type="button"
            aria-label="Close the corpus panel"
            onClick={() => setRailOpen(false)}
            className="fixed inset-0 z-30 bg-ink-950/60 lg:hidden"
          />
        )}

        <aside
          className={[
            'fixed inset-y-0 left-0 z-40 w-[19rem] transition-transform duration-200 ease-out',
            'lg:static lg:z-auto lg:w-[19rem] lg:shrink-0 lg:translate-x-0',
            railOpen ? 'translate-x-0' : '-translate-x-full',
          ].join(' ')}
        >
          <CorpusRail
            documents={documents}
            loading={docsLoading}
            error={docsError}
            uploads={uploads}
            selectedIds={selected}
            activeDocumentId={inspector?.kind === 'chunks' ? inspector.documentId : null}
            onFiles={(files) => void handleFiles(files)}
            onDismissUpload={dismissUpload}
            onToggle={toggleDocument}
            onSelectAll={selectAll}
            onOpenDocument={openDocument}
            onDelete={(id) => void handleDelete(id)}
            onRetry={() => {
              setDocsLoading(true);
              void refreshDocuments();
            }}
            onClose={() => setRailOpen(false)}
          />
        </aside>

        <ChatPanel
          turns={turns}
          documents={documents}
          busy={busy}
          canAsk={readyDocs.length > 0 && selected.size > 0}
          scopeLabel={scopeLabel}
          onSend={ask}
          onStop={stop}
          onOpenDocument={openDocument}
        />
      </div>

      <AnimatePresence>
        {inspector?.kind === 'cache' && (
          <CacheDrawer key="cache" onClose={closeInspector} onChanged={() => void refreshStats()} />
        )}
        {inspector?.kind === 'chunks' && inspectedDoc && (
          <ChunkViewer key={`chunks-${inspectedDoc.id}`} doc={inspectedDoc} onClose={closeInspector} />
        )}
      </AnimatePresence>

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
