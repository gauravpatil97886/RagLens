import type { ApiCallKind, LatencyMetrics } from '../types';
import { formatMs } from '../lib/format';
import { KIND_INK, KIND_LABEL, KIND_ORDER } from './figures';

/**
 * Latency as a distribution, not an average.
 *
 * Each kind gets one track on a shared millisecond scale. The solid part runs
 * to the mean; the translucent tail runs on to p95, which is the slow call one
 * in twenty people actually get. The distance between the two marks is the
 * whole point of the panel, so it is drawn as distance.
 */

function Row({ kind, stat, scale }: { kind: ApiCallKind; stat: LatencyMetrics['overall']; scale: number }) {
  const ink = KIND_INK[kind];
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const empty = stat.n === 0;

  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <span className="inline-flex items-baseline gap-2 font-mono text-2xs uppercase tracking-micro text-paper-dim">
          <span
            className="translate-y-[-1px] inline-block h-1.5 w-1.5 rounded-[1px]"
            style={{ backgroundColor: ink }}
            aria-hidden="true"
          />
          {KIND_LABEL[kind]}
        </span>
        <span className="font-mono text-2xs tabular-nums text-paper-faint">
          n={stat.n}
        </span>
      </div>

      <div
        className="relative mt-2 h-2.5 w-full rounded-[3px] bg-ink-800"
        role="img"
        aria-label={
          empty
            ? `${KIND_LABEL[kind]}: no calls measured.`
            : `${KIND_LABEL[kind]}: average ${stat.avg} ms, median ${stat.p50} ms, p95 ${stat.p95} ms, slowest ${stat.max} ms.`
        }
      >
        {!empty && (
          <>
            {/* avg → p95: the tail. */}
            <div
              className="absolute inset-y-0 rounded-[3px] opacity-30"
              style={{ left: 0, width: pct(Math.max(stat.avg, stat.p95)), backgroundColor: ink }}
            />
            {/* 0 → avg: the typical call. */}
            <div
              className="absolute inset-y-0 left-0 rounded-[3px]"
              style={{ width: pct(stat.avg), backgroundColor: ink }}
            />
            {/* Median, marked inside the bar so it can be compared to the mean. */}
            <span
              className="absolute inset-y-[-2px] w-0.5 rounded-full bg-paper"
              style={{ left: `calc(${pct(stat.p50)} - 1px)` }}
              title={`p50 ${stat.p50} ms`}
            />
            {/* Slowest call seen — a hairline, because n=1 events shouldn't shout. */}
            <span
              className="absolute inset-y-[-3px] w-px bg-paper-faint"
              style={{ left: `calc(${pct(stat.max)} - 0.5px)` }}
              title={`slowest ${stat.max} ms`}
            />
          </>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-2xs tabular-nums text-paper-mute">
        {empty ? (
          <span className="text-paper-faint">no calls of this kind yet</span>
        ) : (
          <>
            <span>
              avg <span className="text-paper">{formatMs(stat.avg)}</span>
            </span>
            <span>
              p50 <span className="text-paper-dim">{formatMs(stat.p50)}</span>
            </span>
            <span>
              p95 <span className="text-paper-dim">{formatMs(stat.p95)}</span>
            </span>
            <span className="text-paper-faint">max {formatMs(stat.max)}</span>
          </>
        )}
      </div>
    </li>
  );
}

export default function LatencyPanel({ latency }: { latency: LatencyMetrics }) {
  const scale = Math.max(
    1,
    latency.overall.max,
    ...KIND_ORDER.map((k) => latency.by_kind[k].max),
  );

  const gen = latency.by_kind.generate;
  const spread = gen.n > 0 && gen.avg > 0 ? gen.p95 / gen.avg : 0;

  return (
    <div>
      <ul className="space-y-4">
        {KIND_ORDER.map((kind) => (
          <Row key={kind} kind={kind} stat={latency.by_kind[kind]} scale={scale} />
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft pt-3 font-mono text-2xs tabular-nums text-paper-mute">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-0.5 rounded-full bg-paper" aria-hidden="true" />
          median
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-px bg-paper-faint" aria-hidden="true" />
          slowest seen
        </span>
        <span className="ml-auto">
          all calls: avg <span className="text-paper">{formatMs(latency.overall.avg)}</span> · p95{' '}
          <span className="text-paper-dim">{formatMs(latency.overall.p95)}</span>
        </span>
      </div>

      {spread >= 1.2 && (
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-paper-mute">
          A generate call at p95 takes{' '}
          <span className="font-mono tabular-nums text-signal">{spread.toFixed(1)}×</span> the
          average. Averages hide that; the one-in-twenty slow answer is the one people
          remember.
        </p>
      )}
    </div>
  );
}
