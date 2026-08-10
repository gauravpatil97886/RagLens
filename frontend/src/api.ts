import type {
  CacheClearResponse,
  CacheListResponse,
  ChatRequest,
  ChatResponse,
  ChunksResponse,
  DocumentListResponse,
  DocumentMeta,
  Health,
  IngestEvent,
  Stats,
  StreamEvent,
} from './types';

/** Every path is relative — Vite proxies /api to :8000. */
const API = '/api';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const OFFLINE = 'Can’t reach the API. Check that the backend is running on port 8000.';

/** Errors are `{ detail: "..." }` per the contract; fall back if the body isn't that. */
async function errorFrom(res: Response): Promise<ApiError> {
  let detail = res.statusText ? `${res.status} ${res.statusText}` : `Request failed (${res.status})`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string') {
      detail = (body as { detail: string }).detail;
    }
  } catch {
    // Body wasn't JSON. Keep the status-line fallback.
  }
  return new ApiError(detail, res.status);
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(OFFLINE, 0);
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  return (await res.json()) as T;
}

/* ── Endpoints ──────────────────────────────────────────────────────────── */

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return getJson<Health>('/health', { signal });
}

export function getStats(signal?: AbortSignal): Promise<Stats> {
  return getJson<Stats>('/stats', { signal });
}

export function listDocuments(signal?: AbortSignal): Promise<DocumentListResponse> {
  return getJson<DocumentListResponse>('/documents', { signal });
}

/** Blocking ingest — one response when it's finished. The fallback; see streamUpload. */
export function uploadDocument(file: File, signal?: AbortSignal): Promise<DocumentMeta> {
  const form = new FormData();
  form.append('file', file);
  // No Content-Type header — the browser must set the multipart boundary itself.
  return getJson<DocumentMeta>('/documents', { method: 'POST', body: form, signal });
}

export async function deleteDocument(id: number, signal?: AbortSignal): Promise<void> {
  await send(`/documents/${id}`, { method: 'DELETE', signal });
}

export function getChunks(documentId: number, signal?: AbortSignal): Promise<ChunksResponse> {
  return getJson<ChunksResponse>(`/chunks/${documentId}`, { signal });
}

export function listCache(signal?: AbortSignal): Promise<CacheListResponse> {
  return getJson<CacheListResponse>('/cache', { signal });
}

export function clearCache(signal?: AbortSignal): Promise<CacheClearResponse> {
  return getJson<CacheClearResponse>('/cache', { method: 'DELETE', signal });
}

/** Non-streaming ask. Kept as a fallback path for environments that buffer SSE. */
export function chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  return getJson<ChatResponse>('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
}

/* ── SSE ────────────────────────────────────────────────────────────────── */

/**
 * An SSE event ends at a blank line. Per spec that separator is any of
 * CRLF CRLF, LF LF, or CR CR. We search for the earliest one rather than
 * normalising newlines, because a network chunk can split a CRLF down the
 * middle — normalising a lone trailing CR would invent a boundary that
 * isn't there. Leaving the raw bytes alone means an incomplete "\r\n\r"
 * simply doesn't match, and we wait for the rest.
 */
const BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

/** Turn one raw event block into an event object, or null if it isn't one. */
function parseBlock<T extends { type: string }>(block: string): T | null {
  const dataLines: string[] = [];

  for (const line of block.split(/\r\n|\n|\r/)) {
    // ':' prefix is a comment / keep-alive heartbeat.
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    let value = line.slice(5);
    // A single optional space after the colon is part of the framing, not the data.
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }

  if (dataLines.length === 0) return null;

  // Multi-line data fields are joined with LF, per spec.
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return null;

  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as T;
    }
    return null;
  } catch {
    // A malformed frame shouldn't kill a stream that's otherwise fine.
    console.warn('[sse] discarded unparseable frame:', payload.slice(0, 200));
    return null;
  }
}

/**
 * POST somewhere and consume the event stream that comes back.
 *
 * EventSource can't POST, so this is hand-rolled: read the body as bytes,
 * decode with a streaming decoder (so multi-byte UTF-8 split across chunks
 * survives), and only emit once a full event block has arrived. One parser,
 * shared by every SSE endpoint — chat tokens and ingest progress alike.
 *
 * Resolves when the stream closes. Throws ApiError for transport/HTTP
 * failures; an in-band `{"type":"error"}` frame is delivered to onEvent
 * instead, because the stream ends normally after it.
 */
async function streamPost<T extends { type: string }>(
  path: string,
  init: RequestInit,
  onEvent: (event: T) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: 'POST',
      ...init,
      headers: { Accept: 'text/event-stream', ...init.headers },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(OFFLINE, 0);
  }

  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ApiError('The server returned a response with no stream to read.', res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const drain = (flush: boolean) => {
    for (;;) {
      const match = BOUNDARY.exec(buffer);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = parseBlock<T>(block);
      if (event) onEvent(event);
    }
    // Some servers close without a trailing blank line. Don't drop the last event.
    if (flush && buffer.trim()) {
      const event = parseBlock<T>(buffer);
      buffer = '';
      if (event) onEvent(event);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
    buffer += decoder.decode(); // flush any trailing multi-byte sequence
    drain(true);
  } finally {
    // Releases the connection if we bailed out early; a no-op once drained.
    void reader.cancel().catch(() => undefined);
  }
}

/** Ask a question and watch the answer arrive. */
export function streamChat(
  req: ChatRequest,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamPost<StreamEvent>(
    '/chat/stream',
    { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal },
    onEvent,
  );
}

/**
 * Upload a document and watch it being ingested — a frame per stage, per chunk,
 * and per completed embedding batch. `uploadDocument` remains the fallback for
 * environments that buffer SSE; it runs the same pipeline server-side.
 */
export function streamUpload(
  file: File,
  onEvent: (event: IngestEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  // No Content-Type header — the browser must set the multipart boundary itself.
  return streamPost<IngestEvent>('/documents/stream', { body: form, signal }, onEvent);
}
