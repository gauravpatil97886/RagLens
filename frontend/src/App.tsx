import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ApiError,
  deleteDocument,
  getHealth,
  getMetrics,
  getStats,
  listDocuments,
  streamChat,
} from './api';
import type {
  AssistantTurn,
  DocumentMeta,
  Health,
  Stats,
  StreamEvent,
  Turn,
  View,
} from './types';
import CacheDrawer from './components/CacheDrawer';
import ChatPanel from './components/ChatPanel';
import type { ComposerHandle } from './components/Composer';
import ChunkViewer from './components/ChunkViewer';
import CorpusRail from './components/CorpusRail';
import CostingView from './components/CostingView';
import Dashboard from './components/Dashboard';
import InfraView from './components/InfraView';
import PipelineView from './components/PipelineView';
import ShortcutsDialog from './components/ShortcutsDialog';
import Sidebar from './components/Sidebar';
import Toasts, { type Toast } from './components/Toasts';
import TopBar from './components/TopBar';
import UploadDialog from './components/UploadDialog';
import { useTheme } from './lib/theme';
import { firstFile } from './lib/upload';

type Inspector = { kind: 'chunks'; documentId: number } | { kind: 'cache' } | null;

const VIEWS: View[] = ['ask', 'pipeline', 'signals', 'database', 'costing'];

/**
 * The two paths Infra used to own, and where each of them goes now.
 *
 * A literal lookup rather than an object keyed by the hash: the hash is whatever
 * the address bar happens to contain, and `#/constructor` against a plain object
 * finds a match that was never put there.
 */
function legacyView(path: string): View | null {
  if (path === 'infra') return 'database';
  if (path === 'infra/costing') return 'costing';
  return null;
}

/**
 * The view lives in the URL hash so a reload — and a shared link — lands back here.
 * Only the first segment names the view; there are no sections below one any more.
 *
 * An old `#/infra` link still has to land somewhere sensible, so it is translated
 * *and* the hash is rewritten in place, rather than leaving the address bar showing
 * a path the app no longer has. `history.replaceState` and not `location.hash = …`:
 * assigning pushes a history entry, and Back would then walk you back into the dead
 * path and straight forward again. Rewriting here rather than in an effect means the
 * one function covers both the first read and every hashchange after it.
 */
function viewFromHash(): View {
  const path = window.location.hash.replace(/^#\/?/, '').replace(/\/$/, '');
  const legacy = legacyView(path);
  if (legacy) {
    window.history.replaceState(null, '', `#/${legacy}`);
    return legacy;
  }
  const candidate = path.split('/')[0] as View;
  return VIEWS.includes(candidate) ? candidate : 'ask';
}

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

const POLL_MS = 6000;

export default function App() {
  const reduce = useReducedMotion() ?? false;

  /* ── Corpus ───────────────────────────────────────────────────────────── */
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** The upload dialog. `file` is a document dropped on the window, if any. */
  const [upload, setUpload] = useState<{ file: File | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const composerRef = useRef<ComposerHandle | null>(null);
  /** Ledger rows already attributed to a turn, so two turns never claim one call. */
  const claimedCalls = useRef<Set<number>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const theme = useTheme();
  const [view, setView] = useState<View>(viewFromHash);

  // Back/forward should move between views, so the hash is the source of truth
  // and setView only writes to it.
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const changeView = useCallback((next: View) => {
    window.location.hash = next === 'ask' ? '' : `/${next}`;
    setView(next);
    setRailOpen(false);
  }, []);

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
    // Snapshot the ref *before* the updater closes over it. React invokes state
    // updaters twice under StrictMode, and an updater that read `knownReady.current`
    // directly would see the new value on its second run and drop every selection —
    // which left the composer permanently disabled on first load.
    const previouslyKnown = knownReady.current;
    knownReady.current = new Set(readyIds);
    setSelected((prev) => {
      const next = new Set<number>();
      for (const id of readyIds) {
        if (!previouslyKnown.has(id) || prev.has(id)) next.add(id);
      }
      return next;
    });
  }, [documents]);

  const readyDocs = documents.filter((d) => d.status === 'ready');
  const allSelected = readyDocs.length > 0 && selected.size === readyDocs.length;

  const scopeLabel =
    readyDocs.length === 0
      ? 'No documents ingested yet'
      : selected.size === 0
        ? 'Tick a document to search it'
        : allSelected
          ? `Searching all ${readyDocs.length} document${readyDocs.length === 1 ? '' : 's'}`
          : `Searching ${selected.size} of ${readyDocs.length} documents`;

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
  // Ingestion happens in the dialog, which quotes the cost before spending it.
  // App's job is only to open it, take the finished document, and keep the
  // corpus list honest when a run is abandoned.

  const openUpload = useCallback((file: File | null = null) => {
    setUpload({ file });
    setRailOpen(false);
  }, []);

  const closeUpload = useCallback(() => setUpload(null), []);

  const onIndexed = useCallback(
    (doc: DocumentMeta) => {
      setDocuments((prev) => [doc, ...prev.filter((d) => d.id !== doc.id)]);
      void refreshStats();
    },
    [refreshStats],
  );

  const onUploadDirty = useCallback(() => {
    void refreshDocuments();
    void refreshStats();
  }, [refreshDocuments, refreshStats]);

  /**
   * The reader was told this page is already in the corpus and chose not to
   * make a second copy. Put the one that exists in scope and open it, so
   * declining to spend still ends somewhere useful.
   */
  const useExistingDocument = useCallback((documentId: number) => {
    setSelected((prev) => new Set(prev).add(documentId));
    setInspector({ kind: 'chunks', documentId });
    setRailOpen(false);
  }, []);

  /**
   * Dropping a file anywhere on the window opens the dialog with it already in
   * hand — the shortest path there is from "I have a PDF" to "here is what it
   * will cost". The dialog handles its own drops, so this stands down while it
   * is open.
   */
  useEffect(() => {
    const carriesFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      // Without this the browser navigates away to the dropped file.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (!upload) setDragging(true);
    };

    const onDragLeave = (e: DragEvent) => {
      // relatedTarget is null only when the pointer has left the window itself.
      if (e.relatedTarget === null) setDragging(false);
    };

    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      if (upload) return; // the dialog is open and handles its own drop target
      const file = firstFile(e.dataTransfer?.files ?? null);
      if (!file) return;
      // The dialog screens it and, if it is the wrong sort of file, says so in
      // place — rather than a toast fired at something the reader just did.
      openUpload(file);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [openUpload, upload]);

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

  /**
   * Name the model that actually wrote an answer.
   *
   * The chat stream doesn't carry a model name, and the configured default is
   * not a safe substitute — there is a fallback chain, so the preferred model
   * is often not the one that answered. What *is* authoritative is the
   * api_calls ledger the backend writes on every request, so this reads the
   * newest successful generate row back out of /api/metrics and attributes it
   * to the turn that just finished. Only one chat can be in flight at a time,
   * and a row is claimed once, so the match is exact rather than a guess. If
   * anything about that is uncertain the model line is simply left off.
   */
  const resolveModel = useCallback(async (assistantId: string) => {
    try {
      const metrics = await getMetrics();
      const row = metrics.recent.find(
        (r) => r.kind === 'generate' && !r.saved && r.ok && !claimedCalls.current.has(r.id),
      );
      if (!row) return;
      claimedCalls.current.add(row.id);
      patchAssistant(assistantId, (turn) => ({ ...turn, model: row.model }));
    } catch {
      // The footer drops the model line rather than inventing one.
    }
  }, [patchAssistant]);

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
          model: null,
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
      // Whether this run reached a model at all. A cache hit never does, and a
      // failure has no answer to attribute — either way, no model line.
      let reachedModel = false;
      let failed = false;

      const onEvent = (event: StreamEvent) => {
        switch (event.type) {
          case 'cache':
            reachedModel = !event.cache.hit;
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
            if (event.cache) reachedModel = !event.cache.hit;
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
            failed = true;
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
          failed = true;
          patchAssistant(assistantId, (turn) => ({ ...turn, phase: 'error', error: message }));
          pushToast(message);
        })
        .finally(() => {
          if (abortRef.current === controller) abortRef.current = null;
          setBusy(false);
          void refreshStats();
          if (reachedModel && !failed) void resolveModel(assistantId);
        });
    },
    [busy, readyDocs.length, selected, allSelected, patchAssistant, pushToast, refreshStats, resolveModel],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** Clear the thread. The stream is aborted first — a new chat means new. */
  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
    changeView('ask');
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [changeView]);

  // Don't leave a stream running if the tab unmounts mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  /* ── Keyboard ─────────────────────────────────────────────────────────── */
  // Only shortcuts that are actually wired live here, and none of them fire
  // while you are mid-sentence in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The upload dialog is modal: while it is open it owns the keyboard, and
      // ⌘K must not clear the thread out from behind it.
      if (upload) return;

      // Both the event target and the focused element are checked: a key
      // pressed inside the composer must never be read as a bare shortcut,
      // and `?` typed into a question is a question mark, not a command.
      const isField = (el: Element | null) =>
        !!el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          (el as HTMLElement).isContentEditable);
      const typing = isField(e.target as Element | null) || isField(document.activeElement);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newChat();
        return;
      }

      if (e.key === 'Escape' && busy) {
        e.preventDefault();
        stop();
        return;
      }

      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '/') {
        e.preventDefault();
        changeView('ask');
        composerRef.current?.focus();
      } else if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, changeView, newChat, stop, upload]);

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
      <TopBar
        view={view}
        onChangeView={changeView}
        stats={stats}
        health={health}
        unreachable={unreachable}
        onOpenCache={() => setInspector({ kind: 'cache' })}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenRail={() => setRailOpen(true)}
        theme={theme.choice}
        onChooseTheme={theme.choose}
      />

      {/* The work, below the bar. `min-h-0` here is what lets every scroll
          container further down actually scroll instead of growing the page. */}
      <div className="flex min-h-0 flex-1">
        {/* Backdrop for the sidebar, below the lg breakpoint only. */}
        {railOpen && view === 'ask' && (
          <button
            type="button"
            aria-label="Close the corpus"
            onClick={() => setRailOpen(false)}
            className="fixed inset-0 z-30 bg-scrim/60 lg:hidden"
          />
        )}

        {/* The rail is the Ask workspace, so it exists on Ask and nowhere else —
            Database and Costing are wide tables and were being squeezed by 17rem
            of chrome that told them nothing. It mounts and unmounts plainly rather
            than joining the crossfade below: a sidebar that fades in beside a
            fading page reads as two things happening, and the drawer transform it
            already owns would fight the opacity. */}
        {view === 'ask' && (
          <aside
            className={[
              'fixed inset-y-0 left-0 z-40 w-[17rem] transition-transform duration-200 ease-out',
              'lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 xl:w-[17.5rem]',
              railOpen ? 'translate-x-0' : '-translate-x-full',
            ].join(' ')}
          >
            <Sidebar
              onNewChat={newChat}
              canNewChat={turns.length > 0}
              onClose={() => setRailOpen(false)}
            >
              <CorpusRail
                documents={documents}
                loading={docsLoading}
                error={docsError}
                selectedIds={selected}
                activeDocumentId={inspector?.kind === 'chunks' ? inspector.documentId : null}
                stats={stats}
                onAdd={() => openUpload()}
                onToggle={toggleDocument}
                onSelectAll={selectAll}
                onOpenDocument={openDocument}
                onDelete={(id) => void handleDelete(id)}
                onRetry={() => {
                  setDocsLoading(true);
                  void refreshDocuments();
                }}
              />
            </Sidebar>
          </aside>
        )}

        {/* One view at a time, and the swap is a short crossfade rather than a cut:
            the top bar stays put while the thing under it is exchanged. Views are
            unmounted rather than hidden — a display:none scroll container loses its
            position, and coming back to the chat should land on the latest answer.
            Every piece of chat state — turns, uploads, the in-flight stream — lives
            up here in App, so nothing is lost. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            initial={{ opacity: 0, y: reduce ? 0 : 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{
              opacity: 0,
              y: reduce ? 0 : -3,
              transition: reduce ? { duration: 0.001 } : { duration: 0.11, ease: 'easeIn' },
            }}
            transition={reduce ? { duration: 0.001 } : { duration: 0.19, ease: [0.16, 1, 0.3, 1] }}
          >
            {view === 'signals' && <Dashboard />}

            {view === 'database' && <InfraView />}

            {view === 'costing' && <CostingView />}

            {view === 'pipeline' && (
              <PipelineView documents={documents} onOpenDocument={openDocument} />
            )}

            {view === 'ask' && (
              <ChatPanel
                turns={turns}
                documents={documents}
                stats={stats}
                busy={busy}
                canAsk={readyDocs.length > 0 && selected.size > 0}
                scopeLabel={scopeLabel}
                onSend={ask}
                onStop={stop}
                onOpenDocument={openDocument}
                onAddDocument={() => openUpload()}
                composerRef={composerRef}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {inspector?.kind === 'cache' && (
          <CacheDrawer key="cache" onClose={closeInspector} onChanged={() => void refreshStats()} />
        )}
        {inspector?.kind === 'chunks' && inspectedDoc && (
          <ChunkViewer key={`chunks-${inspectedDoc.id}`} doc={inspectedDoc} onClose={closeInspector} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {upload && (
          <UploadDialog
            key="upload"
            initialFile={upload.file}
            onClose={closeUpload}
            onIndexed={onIndexed}
            onDirty={onUploadDirty}
            onUseExisting={useExistingDocument}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {shortcutsOpen && <ShortcutsDialog key="shortcuts" onClose={() => setShortcutsOpen(false)} />}
      </AnimatePresence>

      {/* Dragging a file over the window. A ring rather than a full-screen
          takeover: the app stays readable, and the only thing that changes is
          that the window is now obviously a target. */}
      <AnimatePresence>
        {dragging && !upload && (
          <motion.div
            key="dropzone"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.001 : 0.12 }}
            className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center
                       border-[3px] border-signal/70 bg-signal/[0.05] pb-40"
          >
            <span
              className="rounded-full border border-signal/40 bg-ink-850 px-4 py-2 text-[13px]
                         font-medium text-paper shadow-panel"
            >
              Drop to see what indexing it costs
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
