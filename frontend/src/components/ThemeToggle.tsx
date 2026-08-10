import { Monitor, Moon, Sun } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import type { ThemeChoice } from '../lib/theme';

const OPTIONS: Array<{ value: ThemeChoice; Icon: typeof Sun; label: string }> = [
  { value: 'light', Icon: Sun, label: 'Light' },
  { value: 'system', Icon: Monitor, label: 'System' },
  { value: 'dark', Icon: Moon, label: 'Dark' },
];

/**
 * The theme control.
 *
 * A segmented three-state rather than a switch, because `system` is a real
 * choice and a two-state control has to hide it. The selected cell is a single
 * shared element that slides between positions, so the control reads as one
 * thing moving rather than three things blinking.
 */
export default function ThemeToggle({
  choice,
  onChoose,
}: {
  choice: ThemeChoice;
  onChoose: (next: ThemeChoice) => void;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-xl border border-line bg-ink-800/70 p-1"
    >
      {OPTIONS.map(({ value, Icon, label }) => {
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={value === 'system' ? 'Match the system setting' : label}
            onClick={() => onChoose(value)}
            className="relative flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 transition-colors duration-150"
          >
            {active && (
              <motion.span
                layoutId="theme-selected"
                transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 460, damping: 38 }}
                className="absolute inset-0 rounded-lg border border-line bg-ink-850 shadow-inset"
              />
            )}
            <Icon
              size={13}
              strokeWidth={2}
              className={[
                'relative transition-colors duration-150',
                active ? 'text-signal' : 'text-paper-faint',
              ].join(' ')}
            />
            <span
              className={[
                'relative text-[11.5px] transition-colors duration-150',
                active ? 'text-paper-dim' : 'text-paper-faint',
              ].join(' ')}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
