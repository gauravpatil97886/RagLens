import { Database, PanelLeft } from 'lucide-react';
import type { Health, Stats, View } from '../types';
import NavTabs from './NavTabs';
import StatsStrip from './StatsStrip';

function HealthDot({ health, unreachable }: { health: Health | null; unreachable: boolean }) {
  const state = unreachable || !health ? 'down' : health.db && health.gemini ? 'up' : 'degraded';

  const copy =
    state === 'down'
      ? 'Backend unreachable on port 8000'
      : state === 'degraded'
        ? `Partly available — database ${health?.db ? 'up' : 'down'}, model ${health?.gemini ? 'up' : 'down'}`
        : 'Backend healthy';

  const tone =
    state === 'down' ? 'bg-alert' : state === 'degraded' ? 'bg-signal' : 'bg-cache';

  return (
    <span className="flex items-center gap-1.5" title={copy}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      <span className="sr-only">{copy}</span>
    </span>
  );
}

export default function Header({
  stats,
  health,
  unreachable,
  view,
  onChangeView,
  onOpenCache,
  onToggleRail,
}: {
  stats: Stats | null;
  health: Health | null;
  unreachable: boolean;
  view: View;
  onChangeView: (next: View) => void;
  onOpenCache: () => void;
  onToggleRail: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-ink-850 px-3 sm:px-4">
      {view === 'ask' && (
        <button
          type="button"
          onClick={onToggleRail}
          className="rounded p-1.5 text-paper-mute transition-colors hover:text-paper lg:hidden"
          aria-label="Show the corpus panel"
        >
          <PanelLeft size={16} />
        </button>
      )}

      {/* The mark is the latency rail in miniature: retrieval, then cache. */}
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex shrink-0 items-center gap-[3px]" aria-hidden="true">
          <span className="h-1.5 w-4 rounded-full bg-signal" />
          <span className="h-1.5 w-2.5 rounded-full bg-cache" />
        </span>
        <h1 className="hidden truncate font-mono text-2xs uppercase tracking-micro text-paper md:block">
          retrieval, visible
        </h1>
      </div>

      <HealthDot health={health} unreachable={unreachable} />

      <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
      <NavTabs view={view} onChange={onChangeView} />

      <div className="ml-auto flex items-center gap-3">
        <StatsStrip stats={stats} />
        <button type="button" onClick={onOpenCache} className="btn">
          <Database size={11} />
          cache
          {stats && stats.cache_entries > 0 && (
            <span className="tabular-nums text-cache">{stats.cache_entries}</span>
          )}
        </button>
      </div>
    </header>
  );
}
