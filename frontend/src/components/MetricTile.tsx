import { useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useCountUp } from '../lib/useCountUp';
import { Figure } from './figures';

/**
 * One measured fact. Mono, tabular, count-up on change, and a plain-language
 * line under it saying what it counts — a number nobody can interpret is not
 * worth the pixels.
 *
 * `strip` is the same fact one level quieter: no card of its own, because it
 * sits in a hairline-divided row underneath the page's hero number and must not
 * compete with it.
 */
export default function MetricTile({
  label,
  value,
  digits = 0,
  suffix = '',
  tone = 'default',
  note,
  estimated = false,
  why,
  footer,
  variant = 'card',
}: {
  label: string;
  value: number;
  digits?: number;
  suffix?: string;
  tone?: 'default' | 'cache' | 'alert' | 'signal' | 'quiet';
  note: string;
  estimated?: boolean;
  why?: string;
  footer?: ReactNode;
  variant?: 'card' | 'strip';
}) {
  const reduce = useReducedMotion() ?? false;
  const shown = useCountUp(value, 550, reduce);

  const ink =
    tone === 'cache'
      ? 'text-cache'
      : tone === 'alert'
        ? 'text-alert'
        : tone === 'signal'
          ? 'text-signal'
          : tone === 'quiet'
            ? 'text-paper-dim'
            : 'text-paper';

  const strip = variant === 'strip';

  return (
    <div
      className={
        strip
          ? 'bg-ink-850 px-4 py-3.5 transition-colors duration-200 hover:bg-ink-800'
          : 'rounded-xl border border-line bg-ink-850 px-3.5 py-3 shadow-inset'
      }
    >
      <p className="eyebrow">{label}</p>
      <p className={`mt-1.5 font-mono leading-none ${strip ? 'text-[1.5rem]' : 'text-[1.65rem]'} ${ink}`}>
        <Figure
          value={`${shown.toLocaleString('en-US', {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          })}${suffix}`}
          estimated={estimated}
          why={why}
        />
      </p>
      <p className="mt-2 text-[12.5px] leading-snug text-paper-mute">{note}</p>
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}
