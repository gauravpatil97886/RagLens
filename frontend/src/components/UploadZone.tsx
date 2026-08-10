import { useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { transition } from '../lib/motion';
import { fileExtension, formatBytes } from '../lib/format';

const ACCEPTED = ['pdf', 'txt', 'md', 'docx'] as const;
const MAX_BYTES = 20 * 1024 * 1024;

/** Reject early and say why, rather than making the server do it slowly. */
export function screenFile(file: File): string | null {
  const ext = fileExtension(file.name);
  if (!ACCEPTED.includes(ext as (typeof ACCEPTED)[number])) {
    return `${file.name} is a .${ext || 'unknown'} file. Accepted types are PDF, TXT, MD, and DOCX.`;
  }
  if (file.size > MAX_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}. The limit is 20 MB.`;
  }
  if (file.size === 0) {
    return `${file.name} is empty.`;
  }
  return null;
}

export default function UploadZone({
  onFiles,
  busy,
}: {
  onFiles: (files: File[]) => void;
  busy: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child element; count them instead of toggling.
  const depth = useRef(0);

  const take = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  return (
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
        depth.current = 0;
        setOver(false);
        take(e.dataTransfer.files);
      }}
    >
      <motion.button
        type="button"
        onClick={() => inputRef.current?.click()}
        animate={{ scale: over && !reduce ? 1.015 : 1 }}
        transition={transition(reduce, 0.15)}
        className={[
          'group relative flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center',
          'transition-colors duration-150',
          over
            ? 'border-signal bg-signal/[0.07]'
            : 'border-line-strong bg-ink-850 hover:border-paper-faint hover:bg-ink-800',
        ].join(' ')}
      >
        <motion.span
          animate={{ y: over && !reduce ? -2 : 0 }}
          transition={transition(reduce, 0.15)}
          className={over ? 'text-signal' : 'text-paper-mute group-hover:text-paper-dim'}
        >
          <Upload size={17} strokeWidth={1.75} />
        </motion.span>

        <span className="font-mono text-2xs uppercase tracking-micro text-paper-dim">
          {over ? 'release to ingest' : busy ? 'add another' : 'drop a document'}
        </span>
        <span className="text-2xs text-paper-faint">or click to browse · pdf txt md docx · 20 MB</span>
      </motion.button>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.txt,.md,.docx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => {
          take(e.target.files);
          // Let the same file be re-picked after a delete.
          e.target.value = '';
        }}
      />
    </div>
  );
}
