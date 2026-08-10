import { useEffect, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { transition } from '../lib/motion';

/**
 * The slide-over used for both chunk inspection and the cache. It overlays
 * rather than adding a third column, so the chat never gets squeezed on a
 * laptop screen.
 */
export default function InspectorPanel({
  title,
  subtitle,
  onClose,
  children,
  toolbar,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  toolbar?: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={transition(reduce, 0.18)}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-scrim/65 backdrop-blur-[2px]"
        aria-hidden="true"
      />

      <motion.aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ x: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }}
        transition={reduce ? { duration: 0.001 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[30rem] flex-col border-l border-line bg-ink-850 shadow-panel"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] text-paper">{title}</h2>
            {subtitle && (
              <div className="mt-0.5 font-mono text-2xs tabular-nums text-paper-mute">{subtitle}</div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {toolbar}
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-paper-mute transition-colors hover:text-paper"
              aria-label="Close panel"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">{children}</div>
      </motion.aside>
    </>
  );
}
