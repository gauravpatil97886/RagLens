import { useReducedMotion } from 'framer-motion';
import type { Stats } from '../types';
import { useCountUp } from '../lib/useCountUp';

function Stat({
  label,
  value,
  suffix = '',
  digits = 0,
  tone = 'default',
  title,
}: {
  label: string;
  value: number;
  suffix?: string;
  digits?: number;
  tone?: 'default' | 'cache';
  title: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const shown = useCountUp(value, 550, reduce);

  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <span
        className={`font-mono text-[13px] tabular-nums ${tone === 'cache' ? 'text-cache' : 'text-paper'}`}
      >
        {shown.toFixed(digits)}
        {suffix}
      </span>
      <span className="font-mono text-2xs uppercase tracking-micro text-paper-faint">{label}</span>
    </div>
  );
}

export default function StatsStrip({ stats }: { stats: Stats | null }) {
  if (!stats) {
    return (
      <div className="hidden items-center gap-4 md:flex" aria-hidden="true">
        <span className="h-3 w-16 animate-breathe rounded bg-ink-700" />
        <span className="h-3 w-16 animate-breathe rounded bg-ink-700" />
      </div>
    );
  }

  return (
    <div className="hidden items-center gap-x-4 md:flex" aria-label="Corpus and cache statistics">
      <Stat label="docs" value={stats.documents} title="Documents ingested" />
      <Stat label="chunks" value={stats.chunks} title="Chunks indexed across all documents" />
      <span className="h-3.5 w-px bg-line" aria-hidden="true" />
      <Stat
        label="hit rate"
        value={stats.hit_rate * 100}
        suffix="%"
        digits={0}
        tone="cache"
        title={`${stats.cache_hits} hits (${stats.exact_hits} exact, ${stats.semantic_hits} semantic) of ${
          stats.cache_hits + stats.cache_misses
        } questions`}
      />
      <Stat
        label="calls saved"
        value={stats.saved_api_calls}
        tone="cache"
        title="Model calls the cache made unnecessary"
      />
    </div>
  );
}
