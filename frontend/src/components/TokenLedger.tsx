import { motion, useReducedMotion } from 'framer-motion';
import type { CacheMetrics, MetricsTotals } from '../types';
import { useCountUp } from '../lib/useCountUp';
import { transition } from '../lib/motion';
import { Figure, TOKEN_INK, integer } from './figures';

/**
 * Where the tokens went — and specifically, how many of them you never see.
 *
 * The model writes an answer of a couple of hundred tokens and thinks for
 * several thousand. Google bills those thought tokens at the output rate and
 * never shows you their text, so the ratio between them is the single most
 * useful thing on this screen. It gets the large type.
 *
 * Embedding responses carry no usage metadata, so those token counts are the
 * server's estimate. They are marked, never blended into a measured figure.
 */

const SEGMENTS = [
  { key: 'prompt', label: 'prompt', ink: TOKEN_INK.prompt, note: 'your question plus the retrieved chunks' },
  { key: 'thinking', label: 'thinking', ink: TOKEN_INK.thinking, note: 'reasoning you never see, billed as output' },
  { key: 'output', label: 'output', ink: TOKEN_INK.output, note: 'the answer itself' },
] as const;

export default function TokenLedger({
  totals,
  cache,
}: {
  totals: MetricsTotals;
  cache: CacheMetrics;
}) {
  const reduce = useReducedMotion() ?? false;

  const gen = totals.by_kind.generate.tokens;
  const genTotal = Math.max(1, gen.prompt + gen.thinking + gen.output);
  const ratio = gen.output > 0 ? gen.thinking / gen.output : 0;
  const shownRatio = useCountUp(ratio, 700, reduce);

  const embedTokens =
    totals.by_kind.embed_query.tokens.total + totals.by_kind.embed_document.tokens.total;

  const values = { prompt: gen.prompt, thinking: gen.thinking, output: gen.output };

  return (
    <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* ── The finding ── */}
      <div className="rounded-lg border border-signal/30 bg-signal/[0.06] px-3.5 py-3">
        <p className="eyebrow text-signal">the thinking tax</p>
        {gen.output > 0 ? (
          <>
            <p className="mt-2 font-mono text-[2.75rem] leading-none tabular-nums text-signal">
              {shownRatio.toFixed(1)}×
            </p>
            <p className="mt-2 text-[14px] leading-[1.55] text-paper-dim">
              For every token of answer you read, the model spent{' '}
              <span className="text-paper">{ratio.toFixed(1)}</span> thinking. You pay for both
              at the same rate.
            </p>
            <p className="mt-2 font-mono text-2xs tabular-nums text-paper-mute">
              {integer(gen.thinking)} thinking · {integer(gen.output)} output
            </p>
          </>
        ) : (
          <p className="mt-2 text-[13px] leading-relaxed text-paper-mute">
            No answer has been generated yet, so there is nothing to compare thinking against.
          </p>
        )}
      </div>

      {/* ── The split ── */}
      <div>
        <p className="eyebrow">generate tokens · measured from the response</p>

        <div
          className="mt-2.5 flex h-4 w-full gap-0.5"
          role="img"
          aria-label={`Generate tokens: ${gen.prompt} prompt, ${gen.thinking} thinking, ${gen.output} output.`}
        >
          {SEGMENTS.map((seg) => {
            const value = values[seg.key];
            if (value <= 0) return null;
            return (
              <motion.div
                key={seg.key}
                className="first:rounded-l-[4px] last:rounded-r-[4px]"
                style={{ backgroundColor: seg.ink }}
                initial={false}
                animate={{ width: `${(value / genTotal) * 100}%` }}
                transition={transition(reduce, 0.45)}
                title={`${seg.label} ${integer(value)}`}
              />
            );
          })}
          {gen.prompt + gen.thinking + gen.output === 0 && (
            <div className="w-full rounded-[4px] bg-ink-800" />
          )}
        </div>

        <ul className="mt-3 space-y-1.5">
          {SEGMENTS.map((seg) => (
            <li key={seg.key} className="flex items-baseline gap-2.5">
              <span
                className="translate-y-[-1px] inline-block h-1.5 w-1.5 shrink-0 rounded-[1px]"
                style={{ backgroundColor: seg.ink }}
                aria-hidden="true"
              />
              <span className="w-[4.5rem] shrink-0 font-mono text-2xs uppercase tracking-micro text-paper-dim">
                {seg.label}
              </span>
              <span className="w-[4.5rem] shrink-0 text-right font-mono text-[13px] tabular-nums text-paper">
                {integer(values[seg.key])}
              </span>
              <span className="min-w-0 text-[12.5px] leading-snug text-paper-mute">{seg.note}</span>
            </li>
          ))}
        </ul>

        <dl className="mt-4 grid gap-x-6 gap-y-2 border-t border-line-soft pt-3 font-mono text-2xs tabular-nums sm:grid-cols-2">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="uppercase tracking-micro text-paper-mute">embedding tokens</dt>
            <dd className="text-[13px] text-paper-dim">
              <Figure
                value={integer(embedTokens)}
                estimated
                why="Embedding responses carry no usage metadata, so the server estimates these from the text length."
              />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="uppercase tracking-micro text-paper-mute">all tokens</dt>
            <dd className="text-[13px] text-paper">
              {integer(totals.tokens.measured)} measured
              {totals.tokens.estimated > 0 && (
                <>
                  {' · '}
                  <span className="text-paper-dim">
                    <Figure
                      value={integer(totals.tokens.estimated)}
                      estimated
                      why="The estimated share of the token total — every one of these is an embedding call."
                    />
                  </span>
                </>
              )}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 sm:col-span-2">
            <dt className="uppercase tracking-micro text-paper-mute">prevented by the cache</dt>
            <dd className="text-[13px] text-cache">
              <Figure
                value={`${integer(cache.estimated_tokens_saved.total)} tokens`}
                estimated
                why={cache.estimated_tokens_saved.basis}
              />
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
