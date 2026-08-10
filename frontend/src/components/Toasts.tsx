import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { transition } from '../lib/motion';

export interface Toast {
  id: string;
  message: string;
  tone: 'error' | 'info';
}

export default function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout={!reduce}
            initial={{ opacity: 0, y: reduce ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : 6 }}
            transition={transition(reduce)}
            className={[
              'pointer-events-auto flex items-start gap-3 rounded-lg border px-3.5 py-2.5 shadow-panel backdrop-blur',
              toast.tone === 'error'
                ? 'border-alert/45 bg-alert-deep/95 text-paper'
                : 'border-line-strong bg-ink-800/95 text-paper-dim',
            ].join(' ')}
          >
            <p className="flex-1 text-[13px] leading-relaxed">{toast.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="shrink-0 rounded p-0.5 text-paper-mute transition-colors hover:text-paper"
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
