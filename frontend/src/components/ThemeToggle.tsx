import { Monitor, Moon, Sun } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import type { ThemeChoice } from '../lib/theme';

const OPTIONS: Array<{ value: ThemeChoice; Icon: typeof Sun; label: string }> = [
  { value: 'light', Icon: Sun, label: 'Light' },
  { value: 'system', Icon: Monitor, label: 'System' },
  { value: 'dark', Icon: Moon, label: 'Dark' },
];

/** What one click does, in compact mode. Three states, so it is a cycle. */
const NEXT: Record<ThemeChoice, ThemeChoice> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const ICON: Record<ThemeChoice, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

/**
 * The theme control.
 *
 * A segmented three-state rather than a switch, because `system` is a real
 * choice and a two-state control has to hide it. The selected cell is a single
 * shared element that slides between positions, so the control reads as one
 * thing moving rather than three things blinking.
 *
 * `compact` is for the top bar. Three labelled cells made the theme the widest
 * and loudest thing in a bar whose job is to say where you are, and at 1600px
 * the labels were colliding with their own icons against the window edge. In
 * compact mode it is one quiet icon button that cycles. The alternative — a
 * dropdown — is a click and a menu to change one setting, and it would still
 * need the same icon to say what the setting currently is.
 */
export default function ThemeToggle({
  choice,
  onChoose,
  compact = false,
}: {
  choice: ThemeChoice;
  onChoose: (next: ThemeChoice) => void;
  /** One cycling icon button instead of the segmented three. */
  compact?: boolean;
}) {
  const reduce = useReducedMotion() ?? false;

  if (compact) {
    const Icon = ICON[choice];
    // Both halves of the sentence, because an icon alone cannot say what
    // pressing it will do — and the state it shows is the one it is *in*.
    const label = `Theme: ${choice} — click for ${NEXT[choice]}`;
    return (
      <button
        type="button"
        onClick={() => onChoose(NEXT[choice])}
        title={label}
        aria-label={label}
        // The quiet tier of the top bar: a tool, not a destination.
        className="btn-ghost px-2 text-paper-faint hover:text-paper-dim"
      >
        <Icon size={14} strokeWidth={2} />
      </button>
    );
  }

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
