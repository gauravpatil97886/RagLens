import { motion, useReducedMotion } from 'framer-motion';
import type { View } from '../types';

/**
 * Three screens, one rule each: ask a question, watch what it cost, learn how
 * it worked. The active tab is marked by a marigold hairline rather than a
 * filled pill — the chrome stays quiet so the instruments below can be loud.
 */

const TABS: { id: View; label: string; hint: string }[] = [
  { id: 'ask', label: 'ask', hint: 'Ask a question against your documents' },
  { id: 'signals', label: 'signals', hint: 'API calls, tokens, latency and cost' },
  { id: 'pipeline', label: 'pipeline', hint: 'How ingest and query actually work' },
];

export default function NavTabs({
  view,
  onChange,
}: {
  view: View;
  onChange: (next: View) => void;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <nav className="flex items-stretch self-stretch" aria-label="Views">
      {TABS.map((tab) => {
        const active = tab.id === view;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            aria-current={active ? 'page' : undefined}
            title={tab.hint}
            className={[
              'relative px-2.5 font-mono text-2xs uppercase tracking-micro transition-colors sm:px-3',
              active ? 'text-paper' : 'text-paper-mute hover:text-paper-dim',
            ].join(' ')}
          >
            {tab.label}
            {active && (
              <motion.span
                layoutId="nav-underline"
                className="absolute inset-x-2 -bottom-px h-px bg-signal sm:inset-x-2.5"
                transition={reduce ? { duration: 0.001 } : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
