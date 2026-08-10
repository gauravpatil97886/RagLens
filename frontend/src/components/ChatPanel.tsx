import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { DocumentMeta, Turn } from '../types';
import { transition } from '../lib/motion';
import AssistantMessage from './AssistantMessage';
import Composer from './Composer';
import EmptyState from './EmptyState';
import UserBubble from './UserBubble';

export default function ChatPanel({
  turns,
  documents,
  busy,
  canAsk,
  scopeLabel,
  onSend,
  onStop,
  onOpenDocument,
}: {
  turns: Turn[];
  documents: DocumentMeta[];
  busy: boolean;
  canAsk: boolean;
  scopeLabel: string;
  onSend: (question: string) => void;
  onStop: () => void;
  onOpenDocument: (documentId: number) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 96px of slack: a reader nudging the wheel shouldn't detach the view.
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 96);
  }, []);

  // Tokens arrive many times a second; follow along unless the reader scrolled away.
  useLayoutEffect(() => {
    if (!stuck) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, stuck]);

  useEffect(() => {
    onScroll();
  }, [onScroll]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    setStuck(true);
  };

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-ink-900">
      <div ref={scrollRef} onScroll={onScroll} className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        {turns.length === 0 ? (
          <EmptyState documents={documents} onPick={onSend} />
        ) : (
          <div className="mx-auto flex max-w-[52rem] flex-col gap-8 px-4 py-8 sm:px-6">
            {turns.map((turn) =>
              turn.role === 'user' ? (
                <UserBubble key={turn.id} turn={turn} />
              ) : (
                <AssistantMessage key={turn.id} turn={turn} onOpenDocument={onOpenDocument} />
              ),
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {!stuck && turns.length > 0 && (
          <motion.button
            type="button"
            onClick={jumpToLatest}
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : 6 }}
            transition={transition(reduce, 0.15)}
            className="absolute bottom-[8.5rem] left-1/2 z-10 -translate-x-1/2 rounded-full border border-line-strong
                       bg-ink-800 px-3 py-1.5 font-mono text-2xs uppercase tracking-micro text-paper-dim
                       shadow-panel transition-colors hover:text-paper"
          >
            <span className="inline-flex items-center gap-1.5">
              <ArrowDown size={11} strokeWidth={2.5} />
              latest
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      <Composer
        onSend={onSend}
        onStop={onStop}
        busy={busy}
        disabled={!canAsk}
        scopeLabel={scopeLabel}
      />
    </section>
  );
}
