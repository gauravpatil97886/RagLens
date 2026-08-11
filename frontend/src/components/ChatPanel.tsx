import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { DocumentMeta, Stats, Turn } from '../types';
import { transition } from '../lib/motion';
import AssistantMessage from './AssistantMessage';
import Composer, { type ComposerHandle } from './Composer';
import EmptyState from './EmptyState';
import UserBubble from './UserBubble';

/**
 * The conversation.
 *
 * One centred column, wide enough for a paragraph and no wider, on a calm
 * ground with the chrome pushed out to the sidebar. Everything that isn't the
 * conversation — the corpus, the counters, the navigation — lives somewhere
 * else, so this screen has exactly two things in it: what was said, and the box
 * you say the next thing in.
 */
export default function ChatPanel({
  turns,
  documents,
  stats,
  busy,
  canAsk,
  scopeLabel,
  onSend,
  onStop,
  onOpenDocument,
  onAddDocument,
  composerRef,
}: {
  turns: Turn[];
  documents: DocumentMeta[];
  stats: Stats | null;
  busy: boolean;
  canAsk: boolean;
  scopeLabel: string;
  onSend: (question: string) => void;
  onStop: () => void;
  onOpenDocument: (documentId: number) => void;
  /** Opens the upload dialog from the empty state. */
  onAddDocument: () => void;
  composerRef?: React.Ref<ComposerHandle>;
}) {
  const reduce = useReducedMotion() ?? false;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const localComposer = useRef<ComposerHandle | null>(null);
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
  }, [onScroll, turns.length]);

  /** A key term is a shortcut to the obvious follow-up, not a glossary popup. */
  const askTerm = useCallback(
    (term: string) => {
      if (!canAsk || busy) return;
      onSend(`What does "${term}" mean here?`);
    },
    [canAsk, busy, onSend],
  );

  const askAgain = useCallback(
    (question: string) => {
      if (!canAsk || busy) return;
      onSend(question);
    },
    [canAsk, busy, onSend],
  );

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    setStuck(true);
  };

  const lastAssistantId = [...turns].reverse().find((t) => t.role === 'assistant')?.id ?? null;

  const setComposer = (instance: ComposerHandle | null) => {
    localComposer.current = instance;
    if (typeof composerRef === 'function') composerRef(instance);
    else if (composerRef) (composerRef as React.MutableRefObject<ComposerHandle | null>).current = instance;
  };

  return (
    // `min-h-0` matters: without it this flex child sizes to its content, the
    // scroll container never scrolls, and a long thread pushes the composer off
    // the bottom of the window.
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-ink-900">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {turns.length === 0 ? (
          <EmptyState
            documents={documents}
            stats={stats}
            onPick={(q) => localComposer.current?.fill(q)}
            onAddDocument={onAddDocument}
          />
        ) : (
          <div className="mx-auto flex max-w-[47rem] flex-col gap-8 px-4 pb-6 pt-8 sm:px-6">
            {turns.map((turn) =>
              turn.role === 'user' ? (
                <UserBubble key={turn.id} turn={turn} />
              ) : (
                <AssistantMessage
                  key={turn.id}
                  turn={turn}
                  isLast={turn.id === lastAssistantId}
                  onOpenDocument={onOpenDocument}
                  onAskTerm={canAsk && !busy ? askTerm : undefined}
                  onAskAgain={canAsk && !busy ? askAgain : undefined}
                />
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
            initial={{ opacity: 0, y: reduce ? 0 : 8, scale: reduce ? 1 : 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: reduce ? 0 : 8, scale: reduce ? 1 : 0.9 }}
            transition={transition(reduce, 0.16)}
            aria-label="Jump to the newest message"
            title="Jump to the newest message"
            className="absolute bottom-[10.5rem] left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center
                       justify-center rounded-full border border-line bg-ink-850 text-paper-dim
                       shadow-lift transition-colors duration-150 hover:border-line-strong hover:text-paper"
          >
            <ArrowDown size={15} strokeWidth={2.4} />
          </motion.button>
        )}
      </AnimatePresence>

      <Composer
        ref={setComposer}
        onSend={onSend}
        onStop={onStop}
        busy={busy}
        disabled={!canAsk}
        scopeLabel={scopeLabel}
      />
    </section>
  );
}
