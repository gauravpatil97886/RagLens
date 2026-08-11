import { fileExtension, formatBytes } from './format';

/** Mirrors the contract's `limits` — the server enforces these too. */
export const ACCEPTED_EXTENSIONS = ['pdf', 'txt', 'md', 'docx'] as const;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** The `accept` attribute for a file input, extensions and MIME types both. */
export const ACCEPT_ATTR =
  '.pdf,.txt,.md,.docx,application/pdf,text/plain,text/markdown,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Reject a file the server would reject anyway, and say why.
 *
 * Runs before anything leaves the browser, so a 30 MB file never gets uploaded
 * just to be turned away. Returns null when the file is worth sending.
 */
export function screenFile(file: File): string | null {
  const ext = fileExtension(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(ext as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return `${file.name} is a .${ext || 'unknown'} file. Accepted types are PDF, TXT, MD, and DOCX.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}. The limit is 20 MB.`;
  }
  if (file.size === 0) {
    return `${file.name} is empty.`;
  }
  return null;
}

/** The first file from a drop or a picker that is worth looking at. */
export function firstFile(list: FileList | null): File | null {
  if (!list || list.length === 0) return null;
  return list.item(0);
}
