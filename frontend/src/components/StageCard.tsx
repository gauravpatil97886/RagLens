import type { ReactNode } from 'react';

/**
 * One step of a pipeline. The numbering is not decoration — these really are
 * ordered, and the order is the thing being taught, so the connector line is
 * drawn between the steps rather than implied by stacking.
 *
 * `tone: 'cache'` marks a step that can end the whole run early. Those are
 * mint, matching the cache language used everywhere else in the app.
 */

export interface StageParam {
  k: string;
  v: string;
  /** Longer explanation, on hover. */
  title?: string;
}

export default function StageCard({
  n,
  title,
  params = [],
  tone = 'default',
  last = false,
  children,
}: {
  n: number;
  title: string;
  params?: StageParam[];
  tone?: 'default' | 'cache';
  last?: boolean;
  children: ReactNode;
}) {
  const cache = tone === 'cache';

  return (
    <li className="relative min-w-0 pb-6 pl-11 last:pb-0">
      <span
        className={[
          'absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-md border font-mono text-2xs tabular-nums',
          cache
            ? 'border-dashed border-cache/50 bg-cache/[0.08] text-cache'
            : 'border-line-strong bg-ink-800 text-signal',
        ].join(' ')}
        aria-hidden="true"
      >
        {String(n).padStart(2, '0')}
      </span>

      {!last && (
        <span
          className={[
            'absolute bottom-0 left-[13.5px] top-8 w-px',
            cache ? 'bg-cache/25' : 'bg-line',
          ].join(' ')}
          aria-hidden="true"
        />
      )}

      <h3 className="pt-1 font-mono text-2xs uppercase tracking-micro text-paper">{title}</h3>

      {params.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {params.map((p) => (
            <li
              key={`${p.k}-${p.v}`}
              title={p.title}
              className={[
                'rounded border px-1.5 py-0.5 font-mono text-2xs tabular-nums',
                cache
                  ? 'border-cache/25 bg-cache/[0.06] text-paper-mute'
                  : 'border-line bg-ink-800 text-paper-mute',
              ].join(' ')}
            >
              {p.k}{' '}
              <span className={cache ? 'text-cache' : 'text-signal'}>{p.v}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5 min-w-0 space-y-2.5">{children}</div>
    </li>
  );
}

/** The explanatory voice: serif, because it is prose, not a measurement. */
export function Why({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-[46rem] font-serif text-[14px] leading-[1.65] text-paper-dim">{children}</p>
  );
}

/** Verbatim server prose — set apart so it reads as quoted, not paraphrased. */
export function Quoted({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-[46rem] border-l border-line-strong pl-3 font-serif text-[13.5px] leading-[1.7] text-paper-mute">
      {children}
    </p>
  );
}
