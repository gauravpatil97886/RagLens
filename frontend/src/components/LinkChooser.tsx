import { useEffect, useId, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Globe, Link2, X } from 'lucide-react';
import { cleanPastedLink, parseLink } from '../lib/url';
import { transition } from '../lib/motion';

/**
 * Pasting a link.
 *
 * The link half of the dropzone, and it tries to be as forgiving as dropping a
 * file is. You do not type `https://`, so it is implied. You paste out of a
 * terminal or an email and the newlines and angle brackets come with it, so
 * they are stripped. You press Enter because the field is the only thing on the
 * screen, so Enter submits.
 *
 * Validation is deliberately quiet: the domain chip appears the moment the
 * string parses, which is the encouraging half, and the complaint is held back
 * until you have actually tried to submit. Nothing here duplicates the server's
 * judgement — it only catches the things that are wrong before a request is
 * worth making.
 */
export default function LinkChooser({
  value,
  onChange,
  onSubmit,
  /** Set once the reader has tried to submit something the browser can see is wrong. */
  problem,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  problem: string | null;
}) {
  const reduce = useReducedMotion() ?? false;
  const fieldId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The field is the only thing to do on this screen, so it takes the caret.
  // requestAnimationFrame because the dialog's own focus pass runs on mount too
  // and would otherwise put focus on the segmented switch behind us.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const link = parseLink(value);

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor={fieldId} className="eyebrow">
          the link
        </label>

        <div
          className={[
            'mt-2 flex items-center gap-2 rounded-xl border bg-ink-800 px-3',
            'transition-colors duration-150',
            problem ? 'border-alert/45' : 'border-line-strong focus-within:border-signal/60',
          ].join(' ')}
        >
          <Link2 size={15} className={`shrink-0 ${problem ? 'text-alert' : 'text-paper-mute'}`} />

          <input
            id={fieldId}
            ref={inputRef}
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="martinfowler.com/articles/…"
            value={value}
            aria-invalid={problem !== null}
            aria-describedby={problem ? errorId : undefined}
            onChange={(e) => onChange(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text');
              if (!pasted) return;
              const cleaned = cleanPastedLink(pasted);
              // Only take over when cleaning actually changed something or the
              // field is empty; otherwise let the browser paste normally so
              // editing part-way through a URL still behaves.
              if (cleaned === pasted && value !== '') return;
              e.preventDefault();
              onChange(cleaned);
            }}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-[14px] text-paper
                       placeholder:text-paper-faint focus:outline-none"
          />

          {value !== '' && (
            <button
              type="button"
              onClick={() => {
                onChange('');
                inputRef.current?.focus();
              }}
              aria-label="Clear the link"
              className="btn-ghost -mr-1.5 shrink-0 px-1.5 py-1"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </form>

      {/* ── The domain, the moment the string becomes a URL ───────────────── */}
      <div className="mt-2 flex min-h-[1.75rem] items-start gap-2">
        <AnimatePresence mode="wait" initial={false}>
          {problem ? (
            <motion.p
              key="problem"
              id={errorId}
              role="alert"
              initial={{ opacity: 0, y: reduce ? 0 : -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={transition(reduce, 0.15)}
              className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-alert"
            >
              <AlertTriangle size={13} className="mt-[3px] shrink-0" />
              {problem}
            </motion.p>
          ) : link ? (
            <motion.span
              key={link.domain}
              initial={{ opacity: 0, y: reduce ? 0 : -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={transition(reduce, 0.15)}
              className="inline-flex items-center gap-1.5 rounded-full border border-line
                         bg-ink-800 px-2.5 py-1 font-mono text-2xs text-paper-dim"
              title={link.href}
            >
              <Globe size={11} className="text-signal" />
              {link.domain}
            </motion.span>
          ) : (
            <motion.span
              key="hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition(reduce, 0.15)}
              className="text-[12.5px] leading-relaxed text-paper-faint"
            >
              https:// is assumed if you leave it out. Press Enter to check it.
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <p className="mt-4 text-[13px] leading-relaxed text-paper-mute">
        The next screen fetches the page once, pulls the article out of it, and shows you what it
        found before anything is indexed. That fetch costs one HTTP request and no model calls — and
        if a colleague has already indexed this link, it will say so, and say what re-indexing costs.
      </p>
    </div>
  );
}
