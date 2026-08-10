import { useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useCountUp } from '../lib/useCountUp';
import { Figure } from './figures';

/**
 * One measured fact. Mono, tabular, count-up on change, and a plain-language
 * line under it saying what it counts — a number nobody can interpret is not
 * worth the pixels.
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

  return (
    <div className="rounded-xl border border-line bg-ink-850 px-3.5 py-3 shadow-inset">
      <p className="eyebrow">{label}</p>
      <p className={`mt-1.5 font-mono text-[1.65rem] leading-none ${ink}`}>
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
