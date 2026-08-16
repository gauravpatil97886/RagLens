import { Fragment } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  Coins,
  Database,
  HardDrive,
  Keyboard,
  PanelLeft,
  Route,
  Sparkles,
} from 'lucide-react';
import type { Health, Stats, View } from '../types';
import type { ThemeChoice } from '../lib/theme';
import { Mark } from './Mark';
import ThemeToggle from './ThemeToggle';

// Ask is the product; the other four are lenses onto it. One hairline after Ask says
// that — a second divider *among* them would turn five destinations into a menu, and a
// heading over them would turn the bar into a second page of navigation. (The other
// rule in this bar is not one of these: it closes the destinations off from the tools.)
const NAV: { id: View; label: string; hint: string; Icon: typeof Sparkles; lead?: boolean }[] = [
  { id: 'ask', label: 'Ask', hint: 'Ask a question against your documents', Icon: Sparkles, lead: true },
  { id: 'pipeline', label: 'Pipeline', hint: 'How ingest and query actually work', Icon: Route },
  { id: 'signals', label: 'Signals', hint: 'How it is doing right now', Icon: Activity },
  { id: 'database', label: 'Database', hint: 'Tables, vectors, indexes and caches', Icon: HardDrive },
  { id: 'costing', label: 'Costing', hint: 'Every model call, and what each chat cost', Icon: Coins },
];

/**
 * The backend, in one dot beside the brand.
 *
 * It lives up here rather than in the sidebar's foot because it qualifies
 * everything on the screen, and the sidebar is now only on one of the five
 * screens — a health light you can navigate away from is worse than none.
 *
 * The dot carries a word wherever there is room for one. Unlabelled, a single
 * coloured circle at the edge of a bar reads as a rendering artifact rather
 * than a reading, and colour alone was the only thing distinguishing "fine"
 * from "not fine". Below lg the word goes and the dot stands alone, because
 * that is where the five destinations start needing the width.
 */
function HealthDot({ health, unreachable }: { health: Health | null; unreachable: boolean }) {
  const state = unreachable || !health ? 'down' : health.db && health.gemini ? 'up' : 'degraded';

  const copy =
    state === 'down'
      ? 'Backend unreachable on port 8000'
      : state === 'degraded'
        ? `Partly available — database ${health?.db ? 'up' : 'down'}, model ${health?.gemini ? 'up' : 'down'}`
        : 'Backend healthy';

  const word = state === 'down' ? 'Offline' : state === 'degraded' ? 'Degraded' : 'Live';
  const tone = state === 'down' ? 'bg-alert' : state === 'degraded' ? 'bg-signal' : 'bg-cache';

  return (
    <span className="flex shrink-0 items-center gap-1.5 px-1.5" title={copy}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
      <span aria-hidden="true" className="hidden text-[11.5px] text-paper-faint lg:inline">
        {word}
      </span>
      <span className="sr-only">{copy}</span>
    </span>
  );
}

/**
 * Where you are, across the whole window.
 *
 * Destinations used to be stacked in the sidebar, with Infra hiding two more behind a
 * segmented control inside the page — five places to go, reachable through two
 * different kinds of control. They are five flat siblings here instead, and the
 * sidebar is free to be nothing but the Ask workspace. Putting the bar above both
 * columns rather than above the conversation is what lets Database and Costing have
 * the full window width for their tables.
 */
export default function TopBar({
  view,
  onChangeView,
  stats,
  health,
  unreachable,
  onOpenCache,
  onOpenShortcuts,
  onOpenRail,
  theme,
  onChooseTheme,
}: {
  view: View;
  onChangeView: (next: View) => void;
  stats: Stats | null;
  health: Health | null;
  unreachable: boolean;
  onOpenCache: () => void;
  onOpenShortcuts: () => void;
  /** Opens the sidebar as a drawer. Below the lg breakpoint only. */
  onOpenRail: () => void;
  theme: ThemeChoice;
  onChooseTheme: (next: ThemeChoice) => void;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    // The bar is a plane the content scrolls beneath, so it is on the raised
    // surface with a lift under it — on `rail` it was within a hair of the
    // conversation ground behind it, and a hairline alone was carrying the whole
    // separation. Height is untouched: the bar read flat because it had no
    // contrast, not because it was thin.
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-2.5 shadow-lift sm:px-3">
      <button
        type="button"
        onClick={onOpenRail}
        title="Open the corpus"
        aria-label="Open the corpus"
        className="btn-ghost shrink-0 px-2 lg:hidden"
      >
        <PanelLeft size={16} />
      </button>

      <div className="flex shrink-0 items-center gap-2.5 pl-1 pr-2">
        <Mark />
        {/* The product's name, not its tagline. "Retrieval, visible" says what
            the thing is for, which is a line for a landing page; a wordmark has
            to be the one word you point at. It is the loudest text in the bar
            on purpose — full `paper` against the destinations' `paper-mute` —
            because a bar where everything is the same grey has no first thing
            to look at.

            It folds away on a phone so the five destinations get the width, and
            stays in the accessibility tree rather than being dropped, because
            the page still has to announce what it is. */}
        <h1 className="sr-only whitespace-nowrap text-[13.5px] font-semibold tracking-[-0.01em] text-paper sm:not-sr-only">
          RAGLens
        </h1>
      </div>

      {/* These are destinations with their own URLs, not tabs within a page, so
          they are links-in-spirit with aria-current — not a role="tablist". */}
      <nav aria-label="Views" className="min-w-0 flex-1">
        {/* Narrow windows scroll the strip rather than wrapping it: a nav that
            grows to two rows shoves the conversation down the screen. The
            scrollbar itself is hidden — it would sit on top of the tabs. */}
        <ul className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {NAV.map(({ id, label, hint, Icon, lead }, i) => {
            const active = id === view;
            return (
              <Fragment key={id}>
                <li className="shrink-0">
                  <button
                    type="button"
                    onClick={() => onChangeView(id)}
                    aria-current={active ? 'page' : undefined}
                    aria-label={label}
                    // The label is folded into the tooltip because below sm the tab
                    // is an icon and the hint alone never names the place.
                    title={`${label} — ${hint}`}
                    className={[
                      'relative flex items-center gap-2 whitespace-nowrap rounded-xl px-2.5 py-1.5 text-[13px]',
                      'transition-colors duration-150',
                      active ? 'text-paper' : 'text-paper-mute hover:bg-ink-800/60 hover:text-paper-dim',
                    ].join(' ')}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        aria-hidden="true"
                        // `ink-800`, not `ink-850`: the bar itself is on 850 now,
                        // and a pill the same colour as the plane it sits on is
                        // no pill at all.
                        className="absolute inset-0 rounded-xl border border-line bg-ink-800 shadow-inset"
                        transition={
                          reduce
                            ? { duration: 0.001 }
                            : { type: 'spring', stiffness: 480, damping: 40 }
                        }
                      />
                    )}
                    <Icon
                      size={15}
                      strokeWidth={2}
                      className={`relative shrink-0 transition-colors ${active ? 'text-signal' : ''}`}
                    />
                    <span className={`relative hidden sm:inline ${active ? 'font-medium' : ''}`}>
                      {label}
                    </span>
                  </button>
                </li>
                {lead && i < NAV.length - 1 && (
                  <li aria-hidden="true" className="mx-1.5 h-5 shrink-0 border-l border-line/60" />
                )}
              </Fragment>
            );
          })}
        </ul>
      </nav>

      {/* Places on the left of this rule, tools on the right. Without it the bar
          was one undifferentiated row of eight controls at one weight, and the
          eye had to read every label to find out which of them went somewhere. */}
      <div aria-hidden="true" className="ml-1 h-5 shrink-0 border-l border-line/60" />

      {/* The quiet tier. These are subordinate to the destinations and they are
          coloured to say so: `paper-faint` at rest against the destinations'
          `paper-mute`, lifting only to `paper-dim` under the pointer. The cache
          count keeps its mint, because a number that is about the cache is the
          one thing in this cluster worth interrupting for. */}
      <div className="flex shrink-0 items-center gap-0.5 pl-1.5">
        <HealthDot health={health} unreachable={unreachable} />

        <button
          type="button"
          onClick={onOpenCache}
          className="btn-ghost text-paper-faint hover:text-paper-dim"
          title="Inspect and clear the stored answers"
          aria-label="Cache"
        >
          <Database size={14} className="shrink-0" />
          <span className="hidden md:inline">Cache</span>
          {stats && stats.cache_entries > 0 && (
            <span className="font-mono text-[12px] tabular-nums text-cache">
              {stats.cache_entries}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onOpenShortcuts}
          className="btn-ghost px-2 text-paper-faint hover:text-paper-dim"
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={14} />
        </button>

        {/* One icon button now, so it no longer has to stand down on a phone —
            it costs exactly what the shortcuts button costs. */}
        <ThemeToggle choice={theme} onChoose={onChooseTheme} compact />
      </div>
    </header>
  );
}
