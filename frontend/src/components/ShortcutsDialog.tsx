import { useEffect } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { transition } from '../lib/motion';

/** Every row here is wired. Nothing is listed that the app doesn't actually do. */
const ROWS: { keys: string[]; what: string }[] = [
  { keys: ['Enter'], what: 'Send the question' },
  { keys: ['Shift', 'Enter'], what: 'New line inside the question' },
  { keys: ['Esc'], what: 'Stop the answer that is streaming' },
  { keys: ['⌘', 'K'], what: 'New chat — clears the thread' },
  { keys: ['/'], what: 'Jump to the composer' },
  { keys: ['?'], what: 'Open and close this list' },
];

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const reduce = useReducedMotion() ?? false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.button
        type="button"
        aria-label="Close keyboard shortcuts"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={transition(reduce, 0.15)}
        className="absolute inset-0 bg-scrim/60 backdrop-blur-[2px]"
      />

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        initial={{ opacity: 0, y: reduce ? 0 : 10, scale: reduce ? 1 : 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: reduce ? 0 : 6, scale: reduce ? 1 : 0.98 }}
        transition={transition(reduce, 0.2)}
        className="relative w-full max-w-[24rem] rounded-2xl border border-line bg-ink-850 p-5 shadow-panel"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-paper">Keyboard</h2>
          <button type="button" onClick={onClose} className="btn-ghost -mr-2 -mt-1 px-2" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <dl className="mt-4 space-y-2.5">
          {ROWS.map((row) => (
            <div key={row.what} className="flex items-center justify-between gap-4">
              <dt className="text-[13.5px] text-paper-dim">{row.what}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                {row.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded-md border border-line bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-paper-mute"
                  >
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-4 border-t border-line-soft pt-3 text-[12px] leading-relaxed text-paper-faint">
          ⌘ is Ctrl on Windows and Linux.
        </p>
      </motion.div>
    </div>
  );
}
