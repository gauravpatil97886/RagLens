import { Check, Copy, X } from 'lucide-react';
import { useCopy } from '../lib/useCopy';

/**
 * One copy control, used by every block that can be copied.
 *
 * It says what it will copy ("copy formula"), and after the click it says what
 * happened in the same words the action used ("copied"). Ghost blocks live
 * inside a `group`, so the button only materialises on hover — present when
 * wanted, invisible while reading.
 */
export default function CopyButton({
  text,
  label = 'copy',
  ghost = false,
  className = '',
}: {
  text: string;
  /** What is being copied — becomes the accessible name: "copy formula". */
  label?: string;
  /** Fade in on hover/focus of the surrounding `group` instead of sitting there. */
  ghost?: boolean;
  className?: string;
}) {
  const { copy, state } = useCopy();

  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy;
  const said = state === 'copied' ? 'Copied' : state === 'failed' ? 'Press ⌘C' : label;

  const tone =
    state === 'copied'
      ? 'text-cache'
      : state === 'failed'
        ? 'text-alert'
        : 'text-paper-mute hover:bg-ink-800 hover:text-paper';

  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      aria-label={state === 'copied' ? `${label}: copied` : label}
      className={[
        'inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px]',
        'transition-[color,background-color,opacity] duration-150',
        ghost ? 'bg-ink-850/80 opacity-0 backdrop-blur-[2px] focus-visible:opacity-100 group-hover:opacity-100' : '',
        tone,
        className,
      ].join(' ')}
    >
      <Icon size={13} strokeWidth={2.2} />
      <span className={ghost ? 'sr-only sm:not-sr-only' : ''}>{said}</span>
    </button>
  );
}
