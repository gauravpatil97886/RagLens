import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';

export interface ComposerHandle {
  focus: () => void;
  /** Put a question in the box without sending it — used by the empty state. */
  fill: (text: string) => void;
}

/**
 * The composer.
 *
 * One elevated, rounded field that grows with the question and never moves
 * anything above it. The send key is the whole point of the control, so it is
 * the only filled thing on screen while there is something to send, and it
 * turns into stop the moment a stream opens — same position, same size, so the
 * pointer never has to go looking.
 */
const Composer = forwardRef<
  ComposerHandle,
  {
    onSend: (question: string) => void;
    onStop: () => void;
    busy: boolean;
    disabled: boolean;
    scopeLabel: string;
  }
>(function Composer({ onSend, onStop, busy, disabled, scopeLabel }, handle) {
  const reduce = useReducedMotion() ?? false;
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(handle, () => ({
    focus: () => ref.current?.focus(),
    fill: (text: string) => {
      setValue(text);
      const el = ref.current;
      if (!el) return;
      el.focus();
      // Caret to the end, so the reader can edit the suggestion rather than
      // being dropped at character zero of someone else's sentence.
      window.requestAnimationFrame(() => el.setSelectionRange(text.length, text.length));
    },
  }));

  // Grow with the question, up to a ceiling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [value]);

  const ready = value.trim().length > 0 && !disabled;

  const submit = () => {
    const question = value.trim();
    if (!question || busy || disabled) return;
    onSend(question);
    setValue('');
  };

  return (
    <div className="relative z-10 shrink-0 bg-ink-900 px-4 pb-4 pt-2 sm:px-6">
      {/* The conversation runs right up to the composer, so the line above it
          has to fade rather than end on a hard edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-full h-10 bg-gradient-to-t from-ink-900 to-transparent"
      />

      <div className="mx-auto w-full max-w-[47rem]">
        <div
          className="rounded-composer border border-line bg-ink-850 shadow-lift
                     transition-[border-color,box-shadow] duration-200
                     focus-within:border-signal/45"
        >
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              disabled ? 'Add a document before asking a question' : 'Ask about your documents…'
            }
            aria-label="Your question"
            className="scroll-quiet max-h-[192px] w-full resize-none bg-transparent px-5 pb-1 pt-4
                       text-[15px] leading-[1.6] text-paper placeholder:text-paper-faint
                       focus:outline-none disabled:cursor-not-allowed"
          />

          <div className="flex items-center justify-between gap-3 px-3 pb-2.5 pl-5">
            <span className="min-w-0 truncate text-[12px] text-paper-faint">{scopeLabel}</span>

            {busy ? (
              <motion.button
                type="button"
                onClick={onStop}
                initial={reduce ? false : { scale: 0.85 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 520, damping: 26 }}
                aria-label="Stop generating"
                title="Stop generating (Esc)"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line-strong
                           bg-ink-800 text-paper transition-colors duration-150
                           hover:border-alert/60 hover:bg-alert/10 hover:text-alert"
              >
                <Square size={12} strokeWidth={3} fill="currentColor" />
              </motion.button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!ready}
                aria-label="Send"
                title="Send (Enter)"
                className={[
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                  'transition-[background-color,color,transform] duration-150',
                  ready
                    ? 'bg-signal text-onaccent hover:brightness-110 active:scale-95'
                    : 'cursor-not-allowed bg-ink-800 text-paper-faint',
                ].join(' ')}
              >
                <ArrowUp size={16} strokeWidth={2.6} />
              </button>
            )}
          </div>
        </div>

        <p className="mt-2 text-center text-[11.5px] text-paper-faint">
          <kbd className="font-mono">Enter</kbd> to send ·{' '}
          <kbd className="font-mono">Shift</kbd>+<kbd className="font-mono">Enter</kbd> for a new line
        </p>
      </div>
    </div>
  );
});

export default Composer;
