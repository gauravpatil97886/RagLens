import { Fragment, type ReactNode } from 'react';

/**
 * Renders the answer with its [1] markers turned into controls.
 *
 * Deliberately not a markdown library: the model emits paragraphs, the odd
 * bullet list, and bold runs, and that is all we honour. Anything else
 * renders as the literal text the model produced, which is the honest
 * outcome for a tool about showing you what actually happened.
 */

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\d+\])/g;
const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^#{1,6}\s+/;

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1.05em] w-[0.5ch] translate-y-[0.15em] animate-caret bg-signal"
    />
  );
}

function inline(text: string, keyPrefix: string, onCite: (n: number) => void): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (!part) return null;

    const cite = /^\[(\d+)\]$/.exec(part);
    if (cite) {
      const n = Number(cite[1]);
      return (
        <button
          key={key}
          type="button"
          onClick={() => onCite(n)}
          title={`Jump to source ${n}`}
          className="mx-px inline-flex h-[1.15em] min-w-[1.35em] translate-y-[-0.08em] items-center justify-center rounded
                     border border-signal/35 bg-signal/10 px-1 align-middle font-mono text-[0.72em] tabular-nums
                     text-signal transition-colors duration-150 hover:border-signal hover:bg-signal hover:text-ink-950"
        >
          {n}
        </button>
      );
    }

    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={key} className="font-semibold text-paper">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={key} className="rounded bg-ink-750 px-1 py-0.5 font-mono text-[0.86em] text-paper-dim">
          {part.slice(1, -1)}
        </code>
      );
    }

    return <Fragment key={key}>{part}</Fragment>;
  });
}

export default function AnswerText({
  text,
  streaming,
  onCite,
}: {
  text: string;
  streaming: boolean;
  onCite: (n: number) => void;
}) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0);

  if (blocks.length === 0) {
    return (
      <p className="font-serif text-[15px] leading-[1.68] text-paper">
        {streaming ? <Caret /> : null}
      </p>
    );
  }

  return (
    <div className="space-y-3 font-serif text-[15px] leading-[1.68] text-paper">
      {blocks.map((block, bi) => {
        const isLast = bi === blocks.length - 1;
        const lines = block.split('\n').filter((l) => l.trim().length > 0);
        const listed = lines.length > 0 && lines.every((l) => BULLET.test(l) || NUMBERED.test(l));

        if (listed) {
          return (
            <ul key={bi} className="space-y-1.5 pl-1">
              {lines.map((line, li) => (
                <li key={li} className="flex gap-2.5">
                  <span aria-hidden="true" className="mt-[0.62em] h-1 w-1 shrink-0 rounded-full bg-signal/70" />
                  <span>
                    {inline(line.replace(BULLET, '').replace(NUMBERED, ''), `${bi}-${li}`, onCite)}
                    {streaming && isLast && li === lines.length - 1 && <Caret />}
                  </span>
                </li>
              ))}
            </ul>
          );
        }

        if (HEADING.test(block)) {
          return (
            <h3 key={bi} className="pt-1 font-mono text-2xs uppercase tracking-micro text-paper-mute">
              {block.replace(HEADING, '')}
              {streaming && isLast && <Caret />}
            </h3>
          );
        }

        return (
          <p key={bi}>
            {inline(block, String(bi), onCite)}
            {streaming && isLast && <Caret />}
          </p>
        );
      })}
    </div>
  );
}
