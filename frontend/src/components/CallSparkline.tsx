import { useState } from 'react';
import type { Timeseries } from '../types';
import { KIND_INK } from './figures';

/**
 * One minute per bar for the last hour, stacked: calls that were made sit on
 * the baseline in marigold, calls the cache prevented stack on top in mint.
 * The full column is therefore the work that was *asked for* — the same
 * comparison the headline makes, over time.
 *
 * Bars, not a line: these are discrete counts, and most minutes are zero. A
 * line would draw slopes through minutes where nothing happened.
 */

const STRIDE = 4;
const BAR = 3;
const H = 44;

function hhmm(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function CallSparkline({ series }: { series: Timeseries }) {
  const [hover, setHover] = useState<number | null>(null);

  const points = series.points;
  const peak = Math.max(1, ...points.map((p) => p.calls + p.saved));
  const width = Math.max(1, points.length) * STRIDE;

  const made = points.reduce((sum, p) => sum + p.calls, 0);
  const saved = points.reduce((sum, p) => sum + p.saved, 0);
  const active = hover !== null ? points[hover] : null;

  const y = (v: number) => H - (v / peak) * H;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-3.5">
          <span className="inline-flex items-center gap-1.5 font-mono text-2xs text-paper-mute">
            <span
              className="h-1.5 w-1.5 rounded-[1px]"
              style={{ backgroundColor: KIND_INK.generate }}
              aria-hidden="true"
            />
            made
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-2xs text-paper-mute">
            <span className="h-1.5 w-1.5 rounded-[1px] bg-cache" aria-hidden="true" />
            prevented
          </span>
        </div>

        <p className="font-mono text-2xs tabular-nums text-paper-dim">
          {active ? (
            <>
              <span className="text-paper">{hhmm(active.t)}</span> · {active.calls} made ·{' '}
              <span className={active.saved > 0 ? 'text-cache' : ''}>{active.saved} prevented</span>
              {active.tokens > 0 && <> · {active.tokens.toLocaleString('en-US')} tokens</>}
            </>
          ) : (
            <>
              last {series.minutes}m · {made} made · {saved} prevented
            </>
          )}
        </p>
      </div>

      <svg
        viewBox={`0 0 ${width} ${H + 1}`}
        preserveAspectRatio="none"
        className="mt-2 h-11 w-full"
        role="img"
        aria-label={`Per-minute API calls for the last ${series.minutes} minutes: ${made} calls made, ${saved} prevented by the cache. Peak ${peak} in one minute.`}
        onMouseLeave={() => setHover(null)}
      >
        {points.map((p, i) => {
          const x = i * STRIDE;
          const madeH = (p.calls / peak) * H;
          const savedH = (p.saved / peak) * H;
          // A 1px surface gap keeps the two stacked segments from reading as one bar.
          const gap = madeH > 0 && savedH > 0 ? 1 : 0;
          return (
            <g key={p.t}>
              {p.calls > 0 && (
                <rect x={x} y={H - madeH} width={BAR} height={madeH} fill={KIND_INK.generate} />
              )}
              {p.saved > 0 && (
                <rect
                  x={x}
                  y={y(p.calls + p.saved)}
                  width={BAR}
                  height={Math.max(0.5, savedH - gap)}
                  fill="#55D6A8"
                />
              )}
              {/* Full-height hit target — the bars themselves are far too small. */}
              <rect
                x={x - 0.5}
                y={0}
                width={STRIDE}
                height={H + 1}
                fill={hover === i ? 'rgba(231,238,236,0.07)' : 'transparent'}
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
        <rect x={0} y={H} width={width} height={1} fill="#1E3036" />
      </svg>

      {made === 0 && saved === 0 && (
        <p className="mt-1 font-mono text-2xs text-paper-faint">
          nothing in the last hour — the totals above are from earlier
        </p>
      )}
    </div>
  );
}
