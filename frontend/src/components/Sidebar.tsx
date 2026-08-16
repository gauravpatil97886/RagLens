import type { ReactNode } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import { Mark } from './Mark';

/**
 * The Ask workspace, and nothing else.
 *
 * This rail used to be the whole of the app's chrome: the brand, four destinations,
 * the corpus, a four-figure stat block, the cache, the shortcuts and the theme. That
 * was one column asked to answer five different questions, and it was the thing that
 * made the app feel busy. Destinations and utilities are in the top bar now, the hit
 * rate and the saved-call count are already stated on Signals and Costing so a third
 * copy here was only noise, and what is left is the two things you actually reach for
 * while asking: start a new thread, and choose what it may read.
 *
 * It renders only on Ask. The other four views get the full window width.
 */
export default function Sidebar({
  onNewChat,
  canNewChat,
  onClose,
  children,
}: {
  onNewChat: () => void;
  canNewChat: boolean;
  onClose: () => void;
  /** The corpus. */
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col border-r border-line bg-rail">
      {/* The drawer's own way out, sharing the row with New chat rather than
          taking a strip of its own — on a phone the rail has no header left to
          hang it from. */}
      <div className="flex items-center gap-1.5 px-3 pt-4">
        <button
          type="button"
          onClick={onNewChat}
          disabled={!canNewChat}
          title="Clear the thread and start over"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-ink-850 px-3 py-2.5
                     text-[13.5px] font-medium text-paper shadow-lift
                     transition-[background-color,border-color,opacity] duration-150
                     hover:border-line-strong hover:bg-ink-800
                     disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-line disabled:hover:bg-ink-850"
        >
          <MessageSquarePlus size={15} className="shrink-0 text-signal" />
          New chat
          <kbd className="ml-auto rounded-md border border-line bg-ink-800 px-1.5 py-0.5 font-mono text-[10.5px] text-paper-mute">
            ⌘K
          </kbd>
        </button>

        <button
          type="button"
          onClick={onClose}
          className="btn-ghost px-1.5 lg:hidden"
          title="Close the corpus"
          aria-label="Close the corpus"
        >
          <X size={15} />
        </button>
      </div>

      {children}

      {/* The colophon. A build has an author, and the foot of the rail is
          where a printed instrument would put one — below the work, out
          of the reading path. The house mark signs it so it reads as a
          byline rather than a stray string. `mt-auto` keeps it pinned even
          on the first frame, before the corpus has anything to fill with. */}
      <p className="mt-auto flex shrink-0 items-center gap-2 border-t border-line px-4 py-3 text-[11px] leading-none text-paper-faint">
        <Mark className="scale-[0.78] opacity-80" />
        <span>
          Built by <span className="font-medium text-paper-mute">Gaurav</span>
        </span>
      </p>
    </div>
  );
}
