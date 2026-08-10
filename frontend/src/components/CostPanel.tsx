import { ExternalLink } from 'lucide-react';
import type { CostMetrics } from '../types';
import { Figure, TOKEN_INK, inr, rate, usd } from './figures';

/**
 * The bill, and the honest asterisk on it.
 *
 * Real spend is zero — this runs on the free tier, and pretending otherwise
 * would be the most misleading thing on the page. So $0.00 is stated first, in
 * mint, and everything under it is explicitly a counterfactual: what the same
 * traffic would have cost at list price. The rates that produced those numbers
 * are printed underneath with their source and date, so nothing here has to be
 * taken on trust.
 */

const SLICES = [
  { key: 'generate_input', label: 'generate · prompt', ink: TOKEN_INK.prompt },
  { key: 'generate_thinking', label: 'generate · thinking', ink: TOKEN_INK.thinking },
  { key: 'generate_output', label: 'generate · output', ink: TOKEN_INK.output },
  { key: 'embed_input', label: 'embedding', ink: '#43575C' },
] as const;

const SAVED_WHY =
  'Estimated: it prices calls that never happened, using the mean token count of the calls that did.';

export default function CostPanel({ cost }: { cost: CostMetrics }) {
  const total = Math.max(
    1e-12,
    SLICES.reduce((sum, s) => sum + cost.breakdown[s.key].usd, 0),
  );

  return (
    <div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-cache/30 bg-cache/[0.06] px-3.5 py-3">
          <dt className="eyebrow text-cache">actually billed</dt>
          <dd className="mt-1.5">
            <span className="font-mono text-[1.65rem] leading-none tabular-nums text-cache">
              {usd(cost.actual_cost_usd)}
            </span>
            <p className="mt-2 text-[12.5px] leading-snug text-paper-mute">
              On the {cost.tier} tier there is no invoice — the ceiling here is a daily request
              quota, not money.
            </p>
          </dd>
        </div>

        <div className="rounded-lg border border-line bg-ink-800 px-3.5 py-3">
          <dt className="eyebrow">would have cost</dt>
          <dd className="mt-1.5">
            <span className="font-mono text-[1.65rem] leading-none tabular-nums text-paper">
              {usd(cost.would_have_cost.usd)}
            </span>
            <p className="mt-2 font-mono text-2xs tabular-nums text-paper-mute">
              {inr(cost.would_have_cost.inr)} at the list prices below
            </p>
          </dd>
        </div>

        <div className="rounded-lg border border-line bg-ink-800 px-3.5 py-3">
          <dt className="eyebrow">prevented by the cache</dt>
          <dd className="mt-1.5">
            <span className="font-mono text-[1.65rem] leading-none text-cache">
              <Figure
                value={usd(cost.saved_by_cache.usd)}
                estimated={cost.saved_by_cache.estimated}
                why={SAVED_WHY}
              />
            </span>
            <p className="mt-2 font-mono text-2xs tabular-nums text-paper-mute">
              <Figure
                value={inr(cost.saved_by_cache.inr)}
                estimated={cost.saved_by_cache.estimated}
                why={SAVED_WHY}
              />{' '}
              not spent
            </p>
          </dd>
        </div>
      </dl>

      {/* Where the counterfactual bill comes from. */}
      <div className="mt-4">
        <p className="eyebrow">what would have been charged</p>
        <div
          className="mt-2 flex h-3 w-full gap-0.5"
          role="img"
          aria-label={SLICES.map(
            (s) => `${s.label} ${usd(cost.breakdown[s.key].usd)}`,
          ).join(', ')}
        >
          {SLICES.map((slice) => {
            const value = cost.breakdown[slice.key].usd;
            if (value <= 0) return null;
            return (
              <div
                key={slice.key}
                className="first:rounded-l-[4px] last:rounded-r-[4px]"
                style={{ width: `${(value / total) * 100}%`, backgroundColor: slice.ink }}
                title={`${slice.label} ${usd(value)}`}
              />
            );
          })}
        </div>

        <ul className="mt-2.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {SLICES.map((slice) => (
            <li key={slice.key} className="flex items-baseline gap-2">
              <span
                className="translate-y-[-1px] inline-block h-1.5 w-1.5 shrink-0 rounded-[1px]"
                style={{ backgroundColor: slice.ink }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs uppercase tracking-micro text-paper-dim">
                {slice.label}
              </span>
              <span className="font-mono text-2xs tabular-nums text-paper">
                {usd(cost.breakdown[slice.key].usd)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-4 border-t border-line-soft pt-3 font-mono text-2xs leading-relaxed tabular-nums text-paper-mute">
        rates · {cost.rates.chat_model} in {rate(cost.rates.chat_input)} · out{' '}
        {rate(cost.rates.chat_output)} · {cost.rates.embed_model} {rate(cost.rates.embed_input)} ·{' '}
        <span className="text-paper-dim">{cost.rates.unit.toLowerCase()}</span> · thinking billed
        as {cost.rates.thinking_billed_as} · $1 = ₹{cost.rates.usd_inr} · as of{' '}
        {cost.rates.as_of} ·{' '}
        <a
          href={cost.rates.source}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal"
        >
          source
          <ExternalLink size={10} />
        </a>
      </p>
    </div>
  );
}
