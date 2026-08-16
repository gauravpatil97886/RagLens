import { motion, useReducedMotion } from 'framer-motion';
import type { CostingWaterfallEntry } from '../lib/costing';
import { formatMs } from '../lib/format';
import { transition } from '../lib/motion';

/**
 * One user action, laid out on its own clock.
 *
 * The server sends `start_ms` and `duration_ms` per step, so this does no
 * arithmetic beyond turning them into percentages of the longest step's end.
 * Three states, and they are told apart by fill rather than by colour alone:
 * a filled marigold bar spent money, a muted bar took time but cost nothing
 * (a cache lookup, a vector search), and a dashed outline is a step that never
 * ran — with the server's reason printed beside it.
 *
 * A skipped step usually has zero duration, which would be an invisible bar,
 * so outlines get a floor width. That floor is cosmetic and never applied to a
 * real, filled measurement.
 */

const MIN_BAR_PX = 3;
const MIN_OUTLINE_PX = 26;

export default function CostingWaterfall({ entries }: { entries: CostingWaterfallEntry[] }) {
  const reduce = useReducedMotion() ?? false;

  if (entries.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-paper-mute">
        No timing breakdown was recorded for this action.
      </p>
    );
  }

  const span = Math.max(1, ...entries.map((e) => e.start_ms + Math.max(0, e.duration_ms)));

  return (
    <div>
      <ol className="space-y-1.5">
        {entries.map((entry, i) => {
          const duration = Math.max(0, entry.duration_ms);
          const left = Math.min(100, (entry.start_ms / span) * 100);
          const width = Math.min(100 - left, (duration / span) * 100);
          const skipped = entry.skipped === true;

          return (
            <li
              key={`${entry.label}-${i}`}
              className="grid grid-cols-[7rem_minmax(0,1fr)_4rem] items-center gap-x-3"
            >
              <span
                className={`truncate font-mono text-2xs uppercase tracking-micro ${
                  skipped ? 'text-paper-faint' : 'text-paper-dim'
                }`}
                title={entry.label}
              >
                {entry.label}
              </span>

              <span className="relative block h-3.5 w-full rounded-[3px] bg-ink-800">
                <motion.span
                  className={`absolute inset-y-0 rounded-[3px] ${
                    skipped
                      ? 'border border-dashed border-line-strong'
                      : entry.billable
                        ? 'bg-signal'
                        : 'bg-paper-faint/70'
                  }`}
                  style={{
                    left: `${left}%`,
                    minWidth: skipped ? MIN_OUTLINE_PX : MIN_BAR_PX,
                  }}
                  initial={false}
                  animate={{ width: `${width}%` }}
                  transition={transition(reduce, 0.4)}
                  title={`${entry.label} · starts at ${formatMs(entry.start_ms)} · ${formatMs(
                    duration,
                  )}${skipped ? ' · did not run' : ''}`}
                />
              </span>

              <span
                className={`text-right font-mono text-2xs tabular-nums ${
                  skipped ? 'text-paper-faint' : 'text-paper-dim'
                }`}
              >
                {skipped && duration === 0 ? '—' : formatMs(duration)}
              </span>

              {skipped && entry.skipped_reason && (
                <span className="col-start-2 -mt-0.5 col-span-2 font-mono text-2xs leading-snug text-cache">
                  {entry.skipped_reason}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)_4rem] gap-x-3 border-t border-line-soft pt-1.5">
        <span className="font-mono text-2xs tabular-nums text-paper-faint">0ms</span>
        <span className="text-right font-mono text-2xs tabular-nums text-paper-faint">
          {formatMs(span)}
        </span>
        <span />
      </div>

      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-2xs text-paper-mute">
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-[2px] bg-signal" aria-hidden="true" />
          billable
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-4 rounded-[2px] bg-paper-faint/70"
            aria-hidden="true"
          />
          no model call
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-4 rounded-[2px] border border-dashed border-line-strong"
            aria-hidden="true"
          />
          skipped
        </li>
      </ul>
    </div>
  );
}
