import { motion, useReducedMotion } from 'framer-motion';
import { formatPct } from '../lib/format';

/**
 * Similarity as an arc, so five citations can be compared at a glance
 * without reading five numbers. The number is still there for anyone
 * who wants it.
 */
export default function SimilarityRing({
  value,
  size = 22,
  showLabel = true,
}: {
  value: number;
  size?: number;
  showLabel?: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <span className="inline-flex items-center gap-1.5" title={`Cosine similarity ${clamped.toFixed(4)}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-ink-700"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          className="text-signal"
          initial={{ strokeDashoffset: reduce ? circumference * (1 - clamped) : circumference }}
          animate={{ strokeDashoffset: circumference * (1 - clamped) }}
          transition={reduce ? { duration: 0.001 } : { duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      {showLabel && (
        <span className="font-mono text-2xs tabular-nums text-paper-dim">{formatPct(clamped)}</span>
      )}
    </span>
  );
}
