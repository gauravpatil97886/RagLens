import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, FileUp, Loader2, X } from 'lucide-react';
import { ApiError, deleteDocument, getPipeline, preflightDocument, streamUpload } from '../api';
import type { ChunkTile, DocumentMeta, IngestRunState, Preflight } from '../types';
import { formatBytes } from '../lib/format';
import { transition } from '../lib/motion';
import { ACCEPT_ATTR, firstFile, screenFile } from '../lib/upload';
import IngestRun from './IngestRun';
import PreflightReport from './PreflightReport';

/**
 * Adding a document, as a decision rather than a side effect.
 *
 * Dropping a file used to start spending immediately: the rail uploaded it, the
 * server embedded it, and the first the reader heard about the cost was after it
 * had been paid. This dialog puts a quote in between. Preflight extracts and
 * chunks the file in memory, checks every chunk against the embedding cache, and
 * reports what indexing *would* cost — without one model call and without one
 * row written. Only "Index it" spends anything.
 *
 * Three states, one frame:
 *   choose    → pick a file (screened here before a byte leaves the browser)
 *   quote     → what it would cost, and what chunking did to the document
 *   run       → what it is actually costing, frame by frame, cancellable
 *
 * Cancelling is real. The stream's first frame carries the row id, so aborting
 * the fetch is followed by DELETE /api/documents/{id}; cancel before that frame
 * lands and the server's own disconnect cleanup is what removes the row.
 */

type Phase = 'choose' | 'analysing' | 'quote' | 'rejected' | 'running';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function UploadDialog({
  initialFile,
  onClose,
  onIndexed,
  onDirty,
}: {
  /** A file dropped on the window, already in hand when the dialog opens. */
  initialFile: File | null;
  onClose: () => void;
  /** A document finished indexing — hand it straight to the corpus list. */
  onIndexed: (doc: DocumentMeta) => void;
  /** The server may have changed underneath us. Re-read the list and the stats. */
  onDirty: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const titleId = useId();

  // A file dropped on the window arrives here unexamined, so it is screened on
  // the way in exactly as a browsed one is — extension and size, before a byte
  // leaves the browser.
  const [file, setFile] = useState<File | null>(initialFile);
  const [rejection, setRejection] = useState<string | null>(() =>
    initialFile ? screenFile(initialFile) : null,
  );
  const [phase, setPhase] = useState<Phase>(() => {
    if (!initialFile) return 'choose';
    return screenFile(initialFile) ? 'rejected' : 'analysing';
  });
  const [report, setReport] = useState<Preflight | null>(null);
  const [run, setRun] = useState<IngestRunState | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** `chunking.chunk_size`. Null until /api/pipeline answers — never guessed. */
  const [ceiling, setCeiling] = useState<number | null>(null);
  const [over, setOver] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const preflightAbort = useRef<AbortController | null>(null);
  /** The row id from the `started` frame — the only handle cancel has. */
  const documentId = useRef<number | null>(null);
  const cancelled = useRef(false);
  /** dragenter/dragleave fire per child; count them rather than toggling. */
  const depth = useRef(0);

  const running = phase === 'running' && run !== null && run.document === null && run.error === null;
  const finished = run !== null && (run.document !== null || run.error !== null);

  /* ── The configured chunk ceiling ──────────────────────────────────────── */
  // Read once, so the size band and the histogram are drawn against the real
  // setting. If this call fails the bars are simply scaled to the data instead;
  // an invented ceiling would make an honest chart lie.
  useEffect(() => {
    const controller = new AbortController();
    getPipeline(controller.signal)
      .then((p) => setCeiling(p.chunking.chunk_size))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  /* ── Preflight ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'analysing' || !file) return;
    const controller = new AbortController();
    preflightAbort.current = controller;

    preflightDocument(file, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setReport(res);
        setPhase('quote');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setRejection(
          err instanceof ApiError ? err.message : 'That file could not be read.',
        );
        setPhase('rejected');
      });

    return () => controller.abort();
  }, [phase, file]);

  /* ── Choosing ──────────────────────────────────────────────────────────── */

  const take = useCallback((candidate: File | null) => {
    if (!candidate) return;
    const problem = screenFile(candidate);
    if (problem) {
      setFile(candidate);
      setRejection(problem);
      setPhase('rejected');
      return;
    }
    setRejection(null);
    setReport(null);
    setFile(candidate);
    setPhase('analysing');
  }, []);

  const startOver = useCallback(() => {
    preflightAbort.current?.abort();
    setFile(null);
    setReport(null);
    setRejection(null);
    setRun(null);
    setPhase('choose');
  }, []);

  /* ── The run ───────────────────────────────────────────────────────────── */

  const patchRun = useCallback((fn: (state: IngestRunState) => IngestRunState) => {
    setRun((prev) => (prev ? fn(prev) : prev));
  }, []);

  const commit = useCallback(() => {
    if (!file) return;

    const controller = new AbortController();
    streamAbort.current = controller;
    cancelled.current = false;
    documentId.current = null;

    setRun({
      startedAt: Date.now(),
      documentId: null,
      stage: 'queued',
      label: 'Uploading',
      nChars: null,
      chunks: [],
      chunkChars: [],
      nChunksSeen: 0,
      nChunks: null,
      embed: null,
      splitFrom: null,
      splitTo: null,
      embedFrom: null,
      embedTo: null,
      document: null,
      error: null,
    });
    setPhase('running');

    // Chunk frames arrive in a burst — the splitter is fast. Coalesce them onto
    // animation frames so React commits once per frame rather than once per
    // chunk, and carry the real frame timestamps through the buffer so the
    // measured rate is unaffected by the batching.
    let pendingTiles: ChunkTile[] = [];
    let pendingChars: number[] = [];
    let lastChunkAt: number | null = null;
    let frame: number | null = null;

    const flushChunks = () => {
      frame = null;
      if (pendingTiles.length === 0) return;
      const tiles = pendingTiles;
      const chars = pendingChars;
      const at = lastChunkAt;
      pendingTiles = [];
      pendingChars = [];
      patchRun((state) => ({
        ...state,
        // Only the newest few previews are rendered; the histogram keeps every
        // length, which is cheap, and the count is the honest total.
        chunks: [...state.chunks, ...tiles].slice(-6),
        chunkChars: [...state.chunkChars, ...chars],
        nChunksSeen: state.nChunksSeen + tiles.length,
        splitFrom: state.splitFrom ?? at,
        splitTo: at ?? state.splitTo,
      }));
    };

    const flushNow = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      flushChunks();
    };

    const settled: { doc: DocumentMeta | null } = { doc: null };

    streamUpload(
      file,
      (event) => {
        const at = Date.now();
        switch (event.type) {
          case 'started':
            documentId.current = event.document_id;
            // A cancel can beat this frame by a hair. If it did, the row exists
            // and nobody is going to finish it — remove it now.
            if (cancelled.current) {
              void deleteDocument(event.document_id).catch(() => undefined);
              return;
            }
            patchRun((state) => ({ ...state, documentId: event.document_id }));
            break;
          case 'stage':
            flushNow();
            patchRun((state) => ({
              ...state,
              stage: event.stage,
              label: event.label,
              nChars: event.n_chars ?? state.nChars,
              splitFrom: event.stage === 'chunking' ? at : state.splitFrom,
              embedFrom: event.stage === 'embedding' ? at : state.embedFrom,
            }));
            break;
          case 'chunk':
            pendingTiles.push({ index: event.index, nChars: event.n_chars, preview: event.preview });
            pendingChars.push(event.n_chars);
            lastChunkAt = at;
            if (frame === null) frame = requestAnimationFrame(flushChunks);
            break;
          case 'chunked':
            flushNow();
            patchRun((state) => ({
              ...state,
              stage: 'chunked',
              label: event.label,
              nChunks: event.n_chunks,
              nChunksSeen: event.n_chunks,
              splitTo: state.splitTo ?? at,
            }));
            break;
          case 'embedding':
            patchRun((state) => ({
              ...state,
              embed: {
                done: event.done,
                total: event.total,
                cached: event.cached,
                apiCalls: event.api_calls,
              },
              embedFrom: state.embedFrom ?? at,
              embedTo: at,
            }));
            break;
          case 'done':
            flushNow();
            settled.doc = event.document;
            patchRun((state) => ({
              ...state,
              stage: 'done',
              label: 'Indexed',
              document: event.document,
            }));
            break;
          case 'error':
            flushNow();
            patchRun((state) => ({ ...state, error: event.detail }));
            break;
        }
      },
      controller.signal,
    )
      .then(() => {
        flushNow();
        if (cancelled.current) return;
        const doc = settled.doc;
        if (doc) {
          if (doc.status === 'failed') {
            patchRun((state) => ({
              ...state,
              document: null,
              error: doc.error ?? `${doc.filename} could not be ingested.`,
            }));
          } else {
            onIndexed(doc);
          }
          return;
        }
        // The stream closed without a verdict. Say so rather than pretending.
        patchRun((state) =>
          state.error
            ? state
            : { ...state, error: 'The ingest stream ended before it reported a result.' },
        );
        onDirty();
      })
      .catch((err: unknown) => {
        flushNow();
        if (cancelled.current) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        patchRun((state) => ({
          ...state,
          error: err instanceof ApiError ? err.message : 'The ingest stream failed unexpectedly.',
        }));
      })
      .finally(() => {
        if (streamAbort.current === controller) streamAbort.current = null;
        if (!cancelled.current) onDirty();
      });
  }, [file, onDirty, onIndexed, patchRun]);

  /**
   * Stop a run and leave nothing behind.
   *
   * Abort first so the server sees the disconnect, then delete the row the
   * `started` frame named. Safe at any moment: before that frame arrives there
   * is no id to delete and the server's own disconnect cleanup handles it, which
   * is why the document list is re-read either way.
   */
  const cancelRun = useCallback(() => {
    cancelled.current = true;
    streamAbort.current?.abort();
    streamAbort.current = null;

    const id = documentId.current;
    documentId.current = null;

    const cleanup = id === null ? Promise.resolve() : deleteDocument(id).catch(() => undefined);
    // Either way, re-read the corpus — the server removes an abandoned row on
    // disconnect too, and the list must not keep showing one that is gone.
    void cleanup.finally(() => onDirty());
  }, [onDirty]);

  /* ── Closing ───────────────────────────────────────────────────────────── */

  const close = useCallback(() => {
    preflightAbort.current?.abort();
    if (running) cancelRun();
    onClose();
  }, [cancelRun, onClose, running]);

  /** Esc, the backdrop and the X all come through here. A live run asks first. */
  const requestClose = useCallback(() => {
    if (running) {
      setConfirming(true);
      return;
    }
    close();
  }, [close, running]);

  /* ── Modal mechanics ───────────────────────────────────────────────────── */

  // Focus in on open, focus back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = panelRef.current;
    window.requestAnimationFrame(() => {
      const target = el?.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? el)?.focus();
    });
    return () => {
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  // Committing a run unmounts the button that was focused, which drops focus
  // onto the body — outside the dialog, where Esc and Tab no longer mean what
  // they should. Catch it on every phase change and put focus back.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const active = document.activeElement;
    if (active && el.contains(active) && active !== document.body) return;
    el.focus({ preventScroll: true });
  }, [phase]);

  // The page behind a modal must not scroll.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape and the focus trap. Capture phase, so Escape closes this dialog
  // instead of reaching the app's global stop-the-answer shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (confirming) setConfirming(false);
        else requestClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const el = panelRef.current;
      if (!el) return;
      const list = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (list.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }

      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!active || !el.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [confirming, requestClose]);

  // Never leave a stream open behind a closed dialog.
  useEffect(
    () => () => {
      preflightAbort.current?.abort();
      streamAbort.current?.abort();
    },
    [],
  );

  /* ── Copy ──────────────────────────────────────────────────────────────── */

  const title =
    phase === 'choose'
      ? 'Add a document'
      : phase === 'rejected'
        ? 'That file can’t be indexed'
        : phase === 'running'
          ? run?.document
            ? `${run.document.filename} is indexed`
            : run?.error
              ? `${file?.name ?? 'This document'} was not indexed`
              : `Indexing ${file?.name ?? 'document'}`
          : (file?.name ?? 'Add a document');

  const subtitle =
    phase === 'choose'
      ? 'You will see what indexing costs before anything is sent to a model.'
      : phase === 'analysing'
        ? 'Reading and chunking the file. No API calls are being made.'
        : phase === 'quote' && file
          ? `${formatBytes(file.size)} · analysed without a single API call`
          : phase === 'running' && run?.document
            ? 'It is in the corpus and in scope for your next question.'
            : // The server's own words for what it is doing right now.
              running && run?.label
              ? run.label
              : null;

  /** Read out to a screen reader as the server's frames arrive. */
  const announcement =
    phase === 'analysing'
      ? 'Analysing the file. No API calls.'
      : phase === 'quote' && report
        ? `Ready to index. ${report.embedding.api_calls_needed} API calls needed.`
        : phase === 'running'
          ? (run?.error ?? run?.label ?? '')
          : phase === 'rejected'
            ? (rejection ?? '')
            : '';

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <motion.button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        onClick={requestClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={transition(reduce, 0.15)}
        className="fixed inset-0 bg-scrim/65 backdrop-blur-[3px]"
      />

      <motion.div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, y: reduce ? 0 : 14, scale: reduce ? 1 : 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: reduce ? 0 : 8, scale: reduce ? 1 : 0.985 }}
        transition={transition(reduce, 0.22)}
        className="relative my-auto flex max-h-[min(88vh,52rem)] w-full max-w-[41rem] flex-col
                   overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-panel focus:outline-none"
      >
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="flex shrink-0 items-start gap-3 border-b border-line-soft px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="truncate text-[15px] font-semibold tracking-[-0.01em] text-paper"
              title={title}
            >
              {title}
            </h2>
            {subtitle && (
              <p className="mt-1 text-[12.5px] leading-relaxed text-paper-mute">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="btn-ghost -mr-2 -mt-1 shrink-0 px-2"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </header>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={phase}
              initial={{ opacity: 0, y: reduce ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: transition(reduce, 0.09) }}
              transition={transition(reduce, 0.2)}
            >
              {phase === 'choose' && (
                <div
                  onDragEnter={(e) => {
                    e.preventDefault();
                    depth.current += 1;
                    setOver(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    depth.current -= 1;
                    if (depth.current <= 0) {
                      depth.current = 0;
                      setOver(false);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    depth.current = 0;
                    setOver(false);
                    take(firstFile(e.dataTransfer.files));
                  }}
                >
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className={[
                      'flex w-full flex-col items-center gap-2.5 rounded-2xl border border-dashed px-6 py-12 text-center',
                      'transition-colors duration-150',
                      over
                        ? 'border-signal bg-signal/[0.07]'
                        : 'border-line-strong bg-ink-800 hover:border-paper-faint hover:bg-ink-700',
                    ].join(' ')}
                  >
                    <FileUp
                      size={22}
                      strokeWidth={1.6}
                      className={over ? 'text-signal' : 'text-paper-mute'}
                    />
                    <span className="text-[14.5px] font-medium text-paper">
                      {over ? 'Release to analyse it' : 'Drop a file here'}
                    </span>
                    <span className="text-[12.5px] text-paper-mute">
                      or click to browse · PDF, TXT, MD, DOCX · up to 20 MB
                    </span>
                  </button>

                  <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPT_ATTR}
                    className="hidden"
                    onChange={(e) => {
                      take(firstFile(e.target.files));
                      // Let the same file be re-picked after a cancel.
                      e.target.value = '';
                    }}
                  />

                  <p className="mt-4 text-[13px] leading-relaxed text-paper-mute">
                    The next screen reads the file, splits it the way the retriever will, and counts
                    how many chunks are already embedded. That reading costs nothing — no model is
                    called until you approve it.
                  </p>
                </div>
              )}

              {phase === 'analysing' && (
                <div className="flex flex-col items-center gap-3 py-14 text-center">
                  <Loader2 size={20} className="animate-spin text-signal" />
                  <p className="text-[14px] font-medium text-paper">Reading {file?.name}</p>
                  <p className="max-w-[26rem] text-[12.5px] leading-relaxed text-paper-mute">
                    Extracting the text, splitting it into chunks, and checking each one against the
                    embedding cache. Nothing is being written and nothing is being spent.
                  </p>
                </div>
              )}

              {phase === 'quote' && report && <PreflightReport report={report} ceiling={ceiling} />}

              {phase === 'rejected' && (
                <div className="flex items-start gap-3 rounded-xl border border-alert/35 bg-alert/[0.06] px-4 py-3.5">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-alert" />
                  <div className="min-w-0">
                    {/* The reason below already names the file, so the heading
                        does not say it a second time. */}
                    <p className="truncate text-[13.5px] font-medium text-alert" title={file?.name}>
                      {file ? file.name : 'Nothing was read'}
                    </p>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-paper-dim">{rejection}</p>
                    <p className="mt-2 text-[12.5px] leading-relaxed text-paper-mute">
                      Nothing was uploaded and nothing was spent.
                    </p>
                  </div>
                </div>
              )}

              {phase === 'running' && run && (
                <IngestRun run={run} report={report} ceiling={ceiling} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <footer className="flex shrink-0 items-center gap-3 border-t border-line-soft bg-ink-850 px-5 py-3.5">
          {confirming ? (
            <>
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-paper-dim">
                Stop indexing? The partial document is removed, so the corpus is left as it was.
              </p>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="btn shrink-0 px-3.5 py-2 text-[13px]"
              >
                Keep going
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  close();
                }}
                className="btn btn-danger shrink-0 px-3.5 py-2 text-[13px]"
              >
                Stop and remove
              </button>
            </>
          ) : (
            <>
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-paper-mute">
                {phase === 'quote'
                  ? 'Nothing has been spent yet.'
                  : phase === 'analysing'
                    ? 'Reading locally. No API calls.'
                    : running
                      ? 'Cancelling removes the partial document.'
                      : ''}
              </p>

              {phase === 'quote' && (
                <>
                  <button
                    type="button"
                    onClick={close}
                    className="btn shrink-0 px-3.5 py-2 text-[13px]"
                  >
                    Cancel
                  </button>
                  <button type="button" onClick={commit} className="btn-solid shrink-0">
                    Index it
                  </button>
                </>
              )}

              {phase === 'rejected' && (
                <>
                  <button
                    type="button"
                    onClick={close}
                    className="btn shrink-0 px-3.5 py-2 text-[13px]"
                  >
                    Close
                  </button>
                  <button type="button" onClick={startOver} className="btn-solid shrink-0">
                    Choose another file
                  </button>
                </>
              )}

              {(phase === 'choose' || phase === 'analysing') && (
                <button
                  type="button"
                  onClick={close}
                  className="btn shrink-0 px-3.5 py-2 text-[13px]"
                >
                  Cancel
                </button>
              )}

              {phase === 'running' && running && (
                <button
                  type="button"
                  onClick={close}
                  className="btn btn-danger shrink-0 px-3.5 py-2 text-[13px]"
                >
                  Cancel
                </button>
              )}

              {phase === 'running' && finished && (
                <button type="button" onClick={close} className="btn-solid shrink-0">
                  {run?.error ? 'Close' : 'Done'}
                </button>
              )}
            </>
          )}
        </footer>
      </motion.div>
    </div>
  );
}
