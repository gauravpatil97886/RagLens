import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Activity, Database, Keyboard, MessageSquarePlus, Route, Sparkles, X } from 'lucide-react';
import type { Health, Stats, View } from '../types';
import type { ThemeChoice } from '../lib/theme';
import { formatPct } from '../lib/format';
import { Mark } from './Mark';
import ThemeToggle from './ThemeToggle';

// Ask is the product; the other three are the lens you look at it through — which is
// what the app is named after. The divider after Ask says that, so a rail that grew from
// three items to four still reads as two ideas rather than a list of four.
const NAV: { id: View; label: string; hint: string; Icon: typeof Sparkles; lead?: boolean }[] = [
  { id: 'ask', label: 'Ask', hint: 'Ask a question against your documents', Icon: Sparkles, lead: true },
  { id: 'pipeline', label: 'Pipeline', hint: 'How ingest and query actually work', Icon: Route },
  { id: 'signals', label: 'Signals', hint: 'How it is doing right now', Icon: Activity },
  { id: 'infra', label: 'Infra', hint: 'The database, the vectors and what each chat cost', Icon: Database },
];

function HealthDot({ health, unreachable }: { health: Health | null; unreachable: boolean }) {
  const state = unreachable || !health ? 'down' : health.db && health.gemini ? 'up' : 'degraded';

  const copy =
    state === 'down'
      ? 'Backend unreachable on port 8000'
      : state === 'degraded'
        ? `Partly available — database ${health?.db ? 'up' : 'down'}, model ${health?.gemini ? 'up' : 'down'}`
        : 'Backend healthy';

  const tone = state === 'down' ? 'bg-alert' : state === 'degraded' ? 'bg-signal' : 'bg-cache';

  return (
    <span className="flex items-center gap-1.5" title={copy}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      <span className="sr-only">{copy}</span>
    </span>
  );
}

/**
 * The whole of the app's chrome, in one column beside the work.
 *
 * Navigation used to be three words under a moving underline in a top bar, with
 * the corpus in a second rail beside it — two strips of chrome for one app. It
 * is one strip now: where you are, what you can ask about, and what the run has
 * cost, in that order, with the conversation left alone.
 */
export default function Sidebar({
  view,
  onChangeView,
  stats,
  health,
  unreachable,
  onOpenCache,
  onNewChat,
  canNewChat,
  onOpenShortcuts,
  theme,
  onChooseTheme,
  onClose,
  children,
}: {
  view: View;
  onChangeView: (next: View) => void;
  stats: Stats | null;
  health: Health | null;
  unreachable: boolean;
  onOpenCache: () => void;
  onNewChat: () => void;
  canNewChat: boolean;
  onOpenShortcuts: () => void;
  theme: ThemeChoice;
  onChooseTheme: (next: ThemeChoice) => void;
  onClose: () => void;
  /** The corpus section. Rendered only on the ask view. */
  children?: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-line bg-rail">
      <div className="flex items-center gap-2.5 px-4 pb-1 pt-4">
        <Mark />
        <h1 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-paper">
          Retrieval, visible
        </h1>
        <HealthDot health={health} unreachable={unreachable} />
        <button
          type="button"
          onClick={onClose}
          className="btn-ghost -mr-1 px-1.5 lg:hidden"
          aria-label="Close the menu"
        >
          <X size={15} />
        </button>
      </div>

      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={onNewChat}
          disabled={!canNewChat}
          title="Clear the thread and start over"
          className="flex w-full items-center gap-2 rounded-xl border border-line bg-ink-850 px-3 py-2.5
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
      </div>

      <nav className="px-3 pt-3" aria-label="Views">
        <ul className="space-y-0.5">
          {NAV.map(({ id, label, hint, Icon, lead }, i) => {
            const active = id === view;
            // A hairline after Ask, not before every group: one divider is a grouping,
            // two would be a menu.
            const divide = lead && i < NAV.length - 1;
            return (
              <li key={id} className={divide ? 'mb-2 border-b border-line/60 pb-2' : undefined}>
                <button
                  type="button"
                  onClick={() => onChangeView(id)}
                  aria-current={active ? 'page' : undefined}
                  title={hint}
                  className={[
                    'group relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13.5px]',
                    'transition-colors duration-150',
                    active ? 'text-paper' : 'text-paper-mute hover:bg-ink-800/60 hover:text-paper-dim',
                  ].join(' ')}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      aria-hidden="true"
                      className="absolute inset-0 rounded-xl border border-line bg-ink-850 shadow-inset"
                      transition={
                        reduce ? { duration: 0.001 } : { type: 'spring', stiffness: 480, damping: 40 }
                      }
                    />
                  )}
                  <Icon
                    size={15}
                    strokeWidth={2}
                    className={`relative shrink-0 transition-colors ${active ? 'text-signal' : ''}`}
                  />
                  <span className={`relative ${active ? 'font-medium' : ''}`}>{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {children}

      <div className="mt-auto space-y-2.5 border-t border-line px-3 py-3">
        {stats && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-1">
            <div className="flex items-baseline justify-between gap-2" title="Documents ingested">
              <dt className="text-[11.5px] text-paper-faint">docs</dt>
              <dd className="font-mono text-[12px] tabular-nums text-paper-dim">{stats.documents}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2" title="Chunks indexed across all documents">
              <dt className="text-[11.5px] text-paper-faint">chunks</dt>
              <dd className="font-mono text-[12px] tabular-nums text-paper-dim">{stats.chunks}</dd>
            </div>
            <div
              className="flex items-baseline justify-between gap-2"
              title={`${stats.cache_hits} hits (${stats.exact_hits} exact, ${stats.semantic_hits} semantic) of ${
                stats.cache_hits + stats.cache_misses
              } questions`}
            >
              <dt className="text-[11.5px] text-paper-faint">hit rate</dt>
              <dd className="font-mono text-[12px] tabular-nums text-cache">
                {formatPct(stats.hit_rate, 0)}
              </dd>
            </div>
            <div
              className="flex items-baseline justify-between gap-2"
              title={`${stats.saved_api_calls} answers came back from the query cache — one generate call saved each.`}
            >
              <dt className="text-[11.5px] text-paper-faint">reused</dt>
              <dd className="font-mono text-[12px] tabular-nums text-cache">{stats.saved_api_calls}</dd>
            </div>
          </dl>
        )}

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenCache}
            className="btn-ghost flex-1 justify-start"
            title="Inspect and clear the stored answers"
          >
            <Database size={14} className="shrink-0" />
            Cache
            {stats && stats.cache_entries > 0 && (
              <span className="ml-auto font-mono text-[12px] tabular-nums text-cache">
                {stats.cache_entries}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={onOpenShortcuts}
            className="btn-ghost px-2"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={14} />
          </button>
        </div>

        <ThemeToggle choice={theme} onChoose={onChooseTheme} />

        {/* The colophon. A build has an author, and the foot of the rail is
            where a printed instrument would put one — below the controls, out
            of the reading path, and there on every screen. The house mark
            signs it so it reads as a byline rather than a stray string. */}
        <p className="flex items-center gap-2 px-1 pt-0.5 text-[11px] leading-none text-paper-faint">
          <Mark className="scale-[0.78] opacity-80" />
          <span>
            Built by <span className="font-medium text-paper-mute">Gaurav</span>
          </span>
        </p>
      </div>
    </div>
  );
}
