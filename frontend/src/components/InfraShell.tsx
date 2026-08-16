import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Coins, HardDrive } from 'lucide-react';
import CostingView from './CostingView';
import InfraView from './InfraView';

/**
 * Infra is one destination with two sections.
 *
 * The rail holds destinations; sections live in the page. Four rail items stayed
 * readable, but "Vectors / Tables / Caches / Query plan / Costing" as five more would
 * have turned the rail into a menu. The four database sections also belong together —
 * they are one scrolling argument about how Postgres is holding the data — so they stay
 * a single page and only Costing, which answers a genuinely different question, gets its
 * own section.
 */
export type InfraSection = 'database' | 'costing';

const SECTIONS: { id: InfraSection; label: string; hint: string; Icon: typeof Coins }[] = [
  { id: 'database', label: 'Database', hint: 'Tables, vectors, indexes and caches', Icon: HardDrive },
  { id: 'costing', label: 'Costing', hint: 'Every model call, and what each chat cost', Icon: Coins },
];

/** The section is in the hash, so back/forward moves between them and a link is shareable. */
export function sectionFromHash(): InfraSection {
  return window.location.hash.replace(/^#\/?/, '').split('/')[1] === 'costing'
    ? 'costing'
    : 'database';
}

export default function InfraShell() {
  const reduce = useReducedMotion() ?? false;
  const [section, setSection] = useState<InfraSection>(sectionFromHash);

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const choose = useCallback((next: InfraSection) => {
    window.location.hash = next === 'database' ? '/infra' : `/infra/${next}`;
    setSection(next);
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line px-4 pt-3 sm:px-6">
        <div className="mx-auto w-full max-w-[74rem]">
          <div
            role="tablist"
            aria-label="Infra sections"
            className="inline-flex gap-1 rounded-xl border border-line bg-ink-850 p-1"
          >
            {SECTIONS.map(({ id, label, hint, Icon }) => {
              const active = id === section;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={hint}
                  onClick={() => choose(id)}
                  className={[
                    'relative flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px]',
                    'transition-colors duration-150',
                    active ? 'text-paper' : 'text-paper-mute hover:text-paper-dim',
                  ].join(' ')}
                >
                  {active && (
                    <motion.span
                      layoutId="infra-section-active"
                      aria-hidden="true"
                      className="absolute inset-0 rounded-lg border border-line bg-ink-800 shadow-inset"
                      transition={
                        reduce ? { duration: 0.001 } : { type: 'spring', stiffness: 480, damping: 40 }
                      }
                    />
                  )}
                  <Icon
                    size={14}
                    strokeWidth={2}
                    className={`relative shrink-0 ${active ? 'text-signal' : ''}`}
                  />
                  <span className={`relative ${active ? 'font-medium' : ''}`}>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Unmounted rather than hidden, for the same reason App swaps views: a
          display:none scroll container forgets where it was. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={section}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          initial={{ opacity: 0, y: reduce ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: reduce ? { duration: 0.001 } : { duration: 0.1 } }}
          transition={reduce ? { duration: 0.001 } : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          {section === 'database' ? <InfraView /> : <CostingView />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
