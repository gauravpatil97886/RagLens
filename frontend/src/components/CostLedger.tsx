import type { ReactNode } from 'react';

/**
 * The ledger.
 *
 * One rectangle that appears three times in the upload flow and says the same
 * thing in three tenses: what indexing *would* cost, what it *is* costing, and
 * what it *did* cost. Same frame, same figure row, same position in the dialog —
 * so committing to a run and watching it happen is one continuous reading rather
 * than three unrelated screens.
 *
 * Marigold while it is a quote or a run in progress. Mint when the embedding
 * cache means the answer is zero — that is the one number in this app worth
 * celebrating, and mint is the only colour allowed to celebrate it.
 */

export type LedgerTone = 'signal' | 'cache' | 'alert';

const FRAME: Record<LedgerTone, string> = {
  signal: 'border-signal/30 bg-signal/[0.055]',
  cache: 'border-cache/35 bg-cache/[0.06]',
  alert: 'border-alert/35 bg-alert/[0.06]',
};

const HEADING: Record<LedgerTone, string> = {
  signal: 'text-signal',
  cache: 'text-cache',
  alert: 'text-alert',
};

export function LedgerFrame({
  tone,
  eyebrow,
  headline,
  children,
  footer,
}: {
  tone: LedgerTone;
  /** The tense. "What indexing this would cost" / "…is costing" / "…cost". */
  eyebrow: string;
  /** The one sentence the reader is here for. */
  headline: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className={`rounded-2xl border px-4 py-3.5 ${FRAME[tone]}`}>
      <p className="eyebrow">{eyebrow}</p>

      <p className={`mt-2 text-[15px] font-medium leading-snug ${HEADING[tone]}`}>{headline}</p>

      {children}

      {footer && (
        <div className={`mt-3 border-t pt-2.5 ${tone === 'cache' ? 'border-cache/20' : 'border-signal/20'}`}>
          {footer}
        </div>
      )}
    </section>
  );
}

/**
 * One measurement. The numeral is mono and tabular so a row of them lines up
 * and so a figure that changes live doesn't shuffle the ones beside it.
 */
export function Figure({
  value,
  label,
  tone = 'paper',
  title,
}: {
  value: string;
  label: string;
  tone?: 'paper' | 'signal' | 'cache' | 'mute';
  /** The honest footnote — where the number came from, or why it is estimated. */
  title?: string;
}) {
  const colour =
    tone === 'signal'
      ? 'text-signal'
      : tone === 'cache'
        ? 'text-cache'
        : tone === 'mute'
          ? 'text-paper-mute'
          : 'text-paper';

  return (
    <div className="min-w-0" title={title}>
      <div className={`truncate font-mono text-[1.35rem] leading-none tabular-nums ${colour}`}>
        {value}
      </div>
      <div className="mt-1.5 truncate text-[12px] leading-tight text-paper-mute">{label}</div>
    </div>
  );
}

/** The row the figures sit in. Three or four across, never wrapping awkwardly. */
export function FigureRow({ children }: { children: ReactNode }) {
  return <div className="mt-3.5 grid grid-cols-3 gap-x-4 gap-y-3">{children}</div>;
}
