import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';

export default function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  scopeLabel,
}: {
  onSend: (question: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  scopeLabel: string;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Grow with the question, up to a ceiling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [value]);

  const submit = () => {
    const question = value.trim();
    if (!question || busy || disabled) return;
    onSend(question);
    setValue('');
  };

  return (
    <div className="border-t border-line bg-ink-900/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="mx-auto max-w-[52rem]">
        <div className="rounded-xl border border-line bg-ink-850 focus-within:border-line-strong">
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
              disabled ? 'Add a document before asking a question' : 'Ask something about your documents'
            }
            aria-label="Your question"
            className="max-h-[168px] w-full resize-none bg-transparent px-3.5 py-3 text-[15px] leading-relaxed
                       text-paper placeholder:text-paper-faint focus:outline-none disabled:cursor-not-allowed"
          />

          <div className="flex items-center justify-between gap-3 border-t border-line-soft px-3 py-2">
            <span className="truncate font-mono text-2xs uppercase tracking-micro text-paper-mute">
              {scopeLabel}
            </span>

            {busy ? (
              <button type="button" onClick={onStop} className="btn btn-danger">
                <Square size={11} strokeWidth={2.5} />
                stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={disabled || value.trim().length === 0}
                className="btn btn-accent"
              >
                ask
                <ArrowUp size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        <p className="mt-1.5 text-center font-mono text-2xs text-paper-faint">
          enter to ask · shift + enter for a new line
        </p>
      </div>
    </div>
  );
}
