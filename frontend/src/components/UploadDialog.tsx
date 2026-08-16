import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, FileUp, Link2, Loader2, X } from 'lucide-react';
import {
  ApiError,
  deleteDocument,
  getPipeline,
  preflightDocument,
  preflightUrl,
  streamUpload,
  streamUrlIngest,
} from '../api';
import type {
  ChunkTile,
  DocumentMeta,
  DocumentSource,
  IngestEvent,
  IngestRunState,
  Preflight,
  UrlPreflight,
} from '../types';
import { formatBytes } from '../lib/format';
import { transition } from '../lib/motion';
import { ACCEPT_ATTR, firstFile, screenFile } from '../lib/upload';
import { parseLink, screenLink } from '../lib/url';
import IngestRun from './IngestRun';
import LinkChooser from './LinkChooser';
import LinkFetching from './LinkFetching';
import PreflightReport from './PreflightReport';
import UrlPreflightReport from './UrlPreflightReport';

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
 *   choose    → pick a file, or paste a link (both screened before anything leaves)
 *   quote     → what it would cost, and what chunking did to the document
 *   run       → what it is actually costing, frame by frame, cancellable
 *
 * Two ways in, one shape. A pasted link is the same journey with one extra step
 * at the front: the page has to arrive before there is text to quote. Preflight
 * fetches it once — one HTTP request, still zero model calls — and the server
 * holds the body for a few minutes, so pressing Index does not make a stranger's
 * server serve the same page twice for one decision.
 *
 * Cancelling is real, and identical on both paths. The stream's first frame
 * carries the row id, so aborting the fetch is followed by
 * DELETE /api/documents/{id}; cancel before that frame lands and the server's
 * own disconnect cleanup is what removes the row.
 */

type Phase = 'choose' | 'analysing' | 'quote' | 'rejected' | 'running';

/** Which of the two ways in is on screen. Mirrors `DocumentSource` exactly. */
type Mode = DocumentSource;

/**
 * File / Link.
 *
 * Two ways to say the same thing — "here is a document" — so they are one
 * control rather than two screens. It only exists while there is a choice left
 * to make: once something has been analysed, switching would silently throw the
 * quote away, so the switch leaves and the footer's Cancel is the way back.
 */
function SourceSwitch({
  mode,
  onChange,
  reduce,
}: {
  mode: Mode;
  onChange: (next: Mode) => void;
  reduce: boolean;
}) {
  const options: { value: Mode; label: string; Glyph: typeof FileUp; hint: string }[] = [
    { value: 'file', label: 'File', Glyph: FileUp, hint: 'Upload a PDF, TXT, MD or DOCX' },
    { value: 'url', label: 'Link', Glyph: Link2, hint: 'Paste a link to a web page' },
  ];

  return (
    <div
      role="tablist"
      aria-label="Where the document comes from"
      className="mb-5 inline-flex rounded-xl border border-line bg-ink-800 p-1"
    >
      {options.map(({ value, label, Glyph, hint }) => {
        const on = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={on}
            title={hint}
            onClick={() => onChange(value)}
            className={[
              'relative inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium',
              'transition-colors duration-150',
              on ? 'text-paper' : 'text-paper-mute hover:text-paper-dim',
            ].join(' ')}
          >
            {on && (
              <motion.span
                layoutId="source-switch-thumb"
                transition={transition(reduce, 0.2)}
                className="absolute inset-0 rounded-lg border border-line-strong bg-ink-700"
              />
            )}
            <Glyph size={13} className={`relative shrink-0 ${on ? 'text-signal' : ''}`} />
            <span className="relative">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function UploadDialog({
  initialFile,
  onClose,
  onIndexed,
  onDirty,
  onUseExisting,
}: {
  /** A file dropped on the window, already in hand when the dialog opens. */
  initialFile: File | null;
  onClose: () => void;
  /** A document finished indexing — hand it straight to the corpus list. */
  onIndexed: (doc: DocumentMeta) => void;
  /** The server may have changed underneath us. Re-read the list and the stats. */
  onDirty: () => void;
  /**
   * The reader chose the copy that is already in the corpus rather than making
   * a second one. Put that document in scope and show it.
   */
  onUseExisting?: (documentId: number) => void;
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

  /* ── The link half ─────────────────────────────────────────────────────── */
  // A file already in hand means the reader dropped one; opening on the link
  // tab would throw it away.
  const [mode, setMode] = useState<Mode>('file');
  /** Exactly what is in the field, untouched. */
  const [url, setUrl] = useState('');
  /** The absolute URL that was actually sent — what the run and the retry use. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  /** The browser's own objection, held back until the reader tries to submit. */
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const [urlReport, setUrlReport] = useState<UrlPreflight | null>(null);

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
  // One effect, two sources. A 400 from either endpoint is the contract's own
  // plain-English refusal — a PDF behind a link, a page that is mostly
  // JavaScript, a private address — so it is shown verbatim rather than
  // paraphrased into something vaguer.
  useEffect(() => {
    if (phase !== 'analysing') return;
    const target = mode === 'url' ? submitted : file;
    if (!target) return;

    const controller = new AbortController();
    preflightAbort.current = controller;

    const fail = (err: unknown, fallback: string) => {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setRejection(err instanceof ApiError ? err.message : fallback);
      setPhase('rejected');
    };

    if (mode === 'url' && submitted) {
      preflightUrl(submitted, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          setUrlReport(res);
          setPhase('quote');
        })
        .catch((err: unknown) => fail(err, 'That page could not be read.'));
    } else if (file) {
      preflightDocument(file, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          setReport(res);
          setPhase('quote');
        })
        .catch((err: unknown) => fail(err, 'That file could not be read.'));
    }

    return () => controller.abort();
  }, [phase, file, mode, submitted]);

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

  /**
   * Send the pasted link off to be quoted.
   *
   * `screenLink` catches only what the browser can see is wrong — a missing
   * domain, a scheme that isn't http — and it says it in the server's own
   * words, so one problem reads as one sentence wherever it was caught. Every
   * other judgement is the server's.
   */
  const submitLink = useCallback(() => {
    const problem = screenLink(url);
    if (problem) {
      setLinkProblem(problem);
      return;
    }
    const link = parseLink(url);
    if (!link) {
      setLinkProblem('That doesn’t look like a web address.');
      return;
    }
    setLinkProblem(null);
    setRejection(null);
    setUrlReport(null);
    setRun(null);
    setSubmitted(link.href);
    setPhase('analysing');
  }, [url]);

  /**
   * A file dropped while the link side is showing.
   *
   * The window-level handler stands down whenever this dialog is open, so
   * without this a drop onto the link screen would be swallowed in silence.
   * The reader has said which of the two they meant more clearly than the
   * switch ever could, so the switch follows them.
   */
  const takeDropped = useCallback(
    (candidate: File | null) => {
      if (!candidate) return;
      setMode('file');
      setUrlReport(null);
      setSubmitted(null);
      setLinkProblem(null);
      take(candidate);
    },
    [take],
  );

  const startOver = useCallback(() => {
    preflightAbort.current?.abort();
    setFile(null);
    setReport(null);
    setUrlReport(null);
    setSubmitted(null);
    setRejection(null);
    setLinkProblem(null);
    setRun(null);
    setPhase('choose');
  }, []);

  /** The switch. Whatever the other side was holding is dropped, deliberately. */
  const switchMode = useCallback((next: Mode) => {
    preflightAbort.current?.abort();
    setMode(next);
    setFile(null);
    setReport(null);
    setUrlReport(null);
    setSubmitted(null);
    setRejection(null);
    setLinkProblem(null);
    setRun(null);
    setPhase('choose');
  }, []);

  /* ── The run ───────────────────────────────────────────────────────────── */

  const patchRun = useCallback((fn: (state: IngestRunState) => IngestRunState) => {
    setRun((prev) => (prev ? fn(prev) : prev));
  }, []);

  const commit = useCallback(() => {
    // Exactly one of these is set, and which one decides everything below.
    const link = mode === 'url' ? submitted : null;
    const blob = mode === 'url' ? null : file;
    if (link === null && blob === null) return;

    const controller = new AbortController();
    streamAbort.current = controller;
    cancelled.current = false;
    documentId.current = null;

    setRun({
      startedAt: Date.now(),
      source: mode,
      documentId: null,
      stage: 'queued',
      label: mode === 'url' ? 'Fetching the page' : 'Uploading',
      nChars: null,
      chunks: [],
      chunkChars: [],
      nChunksSeen: 0,
      nChunks: null,
      embed: null,
      fetched: null,
      article: null,
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

    const onEvent = (event: IngestEvent) => {
      {
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
              // `fetched` carries the only numbers the wire produced. They are
              // read off the frame rather than measured here: `from_cache` with
              // `fetch_ms: 0` is the server saying it reused the preflight's
              // copy, and a clock in the browser could not tell that apart from
              // a fast site.
              fetched:
                event.stage === 'fetched'
                  ? {
                      status: event.status ?? 0,
                      bytes: event.bytes ?? 0,
                      contentType: event.content_type ?? null,
                      finalUrl: event.final_url ?? null,
                      fromCache: event.from_cache ?? false,
                      fetchMs: event.fetch_ms ?? 0,
                    }
                  : state.fetched,
              splitFrom: event.stage === 'chunking' ? at : state.splitFrom,
              embedFrom: event.stage === 'embedding' ? at : state.embedFrom,
            }));
            break;
          case 'article':
            // Exactly once, before a single embedding is paid for.
            patchRun((state) => ({
              ...state,
              article: {
                title: event.title,
                siteName: event.site_name,
                author: event.author,
                published: event.published,
                nWords: event.n_words,
                readingMinutes: event.reading_minutes,
                excerpt: event.excerpt,
              },
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
      }
    };

    // Two endpoints, one reader. The URL stream is the file stream with three
    // frames in front of it and one `article` frame after extraction, so
    // nothing above needs to know which one it is watching.
    const stream =
      link !== null
        ? streamUrlIngest(link, onEvent, controller.signal)
        : streamUpload(blob as File, onEvent, controller.signal);

    stream
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
  }, [file, mode, submitted, onDirty, onIndexed, patchRun]);

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

  const link = mode === 'url' ? parseLink(submitted ?? url) : null;
  /** Whichever quote is on screen. Both endpoints answer with the same ledger. */
  const quote: Preflight | UrlPreflight | null = mode === 'url' ? urlReport : report;
  const existing = urlReport?.existing ?? null;
  /** What the run — or the quote — is about, in the reader's own words. */
  const subject =
    mode === 'url' ? (urlReport?.article.title ?? link?.domain ?? 'that page') : (file?.name ?? null);

  const title =
    phase === 'choose'
      ? 'Add a document'
      : phase === 'rejected'
        ? mode === 'url'
          ? 'That link can’t be indexed'
          : 'That file can’t be indexed'
        : phase === 'running'
          ? run?.document
            ? `${run.document.filename} is indexed`
            : run?.error
              ? `${subject ?? 'This document'} was not indexed`
              : `Indexing ${subject ?? 'document'}`
          : phase === 'analysing' && mode === 'url'
            ? `Reading ${link?.domain ?? 'the page'}`
            : (subject ?? 'Add a document');

  const subtitle =
    phase === 'choose'
      ? 'You will see what indexing costs before anything is sent to a model.'
      : phase === 'analysing'
        ? mode === 'url'
          ? 'Fetching the page and pulling the article out of it. No API calls are being made.'
          : 'Reading and chunking the file. No API calls are being made.'
        : phase === 'quote' && mode === 'url' && urlReport
          ? `${urlReport.site_name} · ${formatBytes(urlReport.size_bytes)} · analysed without a single API call`
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
      ? mode === 'url'
        ? 'Fetching the page. No API calls.'
        : 'Analysing the file. No API calls.'
      : phase === 'quote' && quote
        ? `${existing ? 'Already in the corpus. ' : 'Ready to index. '}${quote.embedding.api_calls_needed} API calls needed.`
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
          {/* Outside the crossfade below, so the thumb slides between the two
              instead of the whole control fading out and back in. */}
          {phase === 'choose' && (
            <SourceSwitch mode={mode} onChange={switchMode} reduce={reduce} />
          )}

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${mode}-${phase}`}
              initial={{ opacity: 0, y: reduce ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: transition(reduce, 0.09) }}
              transition={transition(reduce, 0.2)}
            >
              {phase === 'choose' && mode === 'url' && (
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
                    takeDropped(firstFile(e.dataTransfer.files));
                  }}
                  className={[
                    '-m-2 rounded-2xl border border-dashed p-2 transition-colors duration-150',
                    over ? 'border-signal bg-signal/[0.07]' : 'border-transparent',
                  ].join(' ')}
                >
                  <LinkChooser
                    value={url}
                    onChange={(next) => {
                      setUrl(next);
                      // The complaint belongs to the string that earned it.
                      setLinkProblem(null);
                    }}
                    onSubmit={submitLink}
                    problem={linkProblem}
                  />
                  {over && (
                    <p className="mt-2 text-[12.5px] leading-relaxed text-signal">
                      Release to analyse that file instead.
                    </p>
                  )}
                </div>
              )}

              {phase === 'choose' && mode === 'file' && (
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

              {/* A link's wait has a knowable sequence, so it gets the sequence
                  rather than a spinner. A file's does not. */}
              {phase === 'analysing' && mode === 'url' && (
                <LinkFetching domain={link?.domain ?? 'the page'} />
              )}

              {phase === 'analysing' && mode === 'file' && (
                <div className="flex flex-col items-center gap-3 py-14 text-center">
                  <Loader2 size={20} className="animate-spin text-signal" />
                  <p className="text-[14px] font-medium text-paper">Reading {file?.name}</p>
                  <p className="max-w-[26rem] text-[12.5px] leading-relaxed text-paper-mute">
                    Extracting the text, splitting it into chunks, and checking each one against the
                    embedding cache. Nothing is being written and nothing is being spent.
                  </p>
                </div>
              )}

              {phase === 'quote' && mode === 'url' && urlReport && (
                <UrlPreflightReport report={urlReport} ceiling={ceiling} />
              )}

              {phase === 'quote' && mode === 'file' && report && (
                <PreflightReport report={report} ceiling={ceiling} />
              )}

              {phase === 'rejected' && (
                <div className="flex items-start gap-3 rounded-xl border border-alert/35 bg-alert/[0.06] px-4 py-3.5">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-alert" />
                  <div className="min-w-0">
                    {/* The reason below already names the thing, so the heading
                        does not say it a second time. A refused link is shown in
                        full — which part of it is wrong is often the whole point. */}
                    <p
                      className="truncate text-[13.5px] font-medium text-alert"
                      title={mode === 'url' ? (submitted ?? url) : file?.name}
                    >
                      {mode === 'url'
                        ? (submitted ?? url ?? 'Nothing was read')
                        : file
                          ? file.name
                          : 'Nothing was read'}
                    </p>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-paper-dim">{rejection}</p>
                    <p className="mt-2 text-[12.5px] leading-relaxed text-paper-mute">
                      {mode === 'url'
                        ? 'Nothing was indexed and nothing was spent.'
                        : 'Nothing was uploaded and nothing was spent.'}
                    </p>
                  </div>
                </div>
              )}

              {phase === 'running' && run && (
                <IngestRun run={run} report={quote} ceiling={ceiling} />
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
                  ? existing
                    ? existing.changed
                      ? 'Re-indexing brings in the current version of the page.'
                      : `Indexing it again costs ${(quote?.embedding.api_calls_needed ?? 0).toLocaleString()} API calls — and leaves two copies behind.`
                    : 'Nothing has been spent yet.'
                  : phase === 'analysing'
                    ? mode === 'url'
                      ? 'Fetching the page. No API calls.'
                      : 'Reading locally. No API calls.'
                    : running
                      ? 'Cancelling removes the partial document.'
                      : ''}
              </p>

              {/* ── The quote ─────────────────────────────────────────────
                  When the page is already in the corpus, the safe action is
                  the loud one: indexing a second copy is free, and free is
                  exactly what makes it easy to do by accident. The one
                  exception is a page that has changed — then the new version
                  is the thing worth having, so Re-index takes the fill. */}
              {phase === 'quote' && existing && !existing.changed && (
                <>
                  <button
                    type="button"
                    onClick={commit}
                    className="btn shrink-0 px-3.5 py-2 text-[13px]"
                  >
                    Index it anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onUseExisting?.(existing.document_id);
                      close();
                    }}
                    className="btn-solid shrink-0"
                  >
                    Use the existing one
                  </button>
                </>
              )}

              {phase === 'quote' && existing && existing.changed && (
                <>
                  <button
                    type="button"
                    onClick={close}
                    className="btn shrink-0 px-3.5 py-2 text-[13px]"
                  >
                    Cancel
                  </button>
                  <button type="button" onClick={commit} className="btn-solid shrink-0">
                    Re-index
                  </button>
                </>
              )}

              {phase === 'quote' && !existing && (
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
                    {mode === 'url' ? 'Try another link' : 'Choose another file'}
                  </button>
                </>
              )}

              {phase === 'choose' && mode === 'url' && (
                <>
                  <button
                    type="button"
                    onClick={close}
                    className="btn shrink-0 px-3.5 py-2 text-[13px]"
                  >
                    Cancel
                  </button>
                  {/* Not a commit — it fetches the page and quotes it. The fill
                      is earned by being the only way forward on this screen. */}
                  <button type="button" onClick={submitLink} className="btn-solid shrink-0">
                    Check the link
                  </button>
                </>
              )}

              {((phase === 'choose' && mode === 'file') || phase === 'analysing') && (
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
