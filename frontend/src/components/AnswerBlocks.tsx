import { useMemo, type ReactNode } from 'react';
import { Sigma, Workflow } from 'lucide-react';
import CopyButton from './CopyButton';

/**
 * The three things an answer can contain that are not prose: a formula, a
 * diagram, and code. Each gets a frame that says which it is, and each can be
 * lifted out of the page in one click.
 *
 * They share a chassis — same rule, same label position, same copy affordance —
 * so a reader learns the pattern once. What differs is only the thing that is
 * actually different: how the content is set.
 */

/** Flatten whatever react-markdown handed us back into the original text. */
export function toText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (typeof node === 'object' && 'props' in (node as never)) {
    return toText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

/* ─── Is this fence a diagram? ───────────────────────────────────────────────
 *
 * A model asked to "draw" something in markdown reaches for box-drawing
 * characters or an ASCII sketch. Both arrive as an ordinary fence, so the fence
 * has to be read rather than trusted: either it declares itself, or it looks
 * like a picture — box-drawing glyphs, or arrows and connectors across several
 * lines. Prose and real code both fail that test.
 */

const DIAGRAM_LANGS = new Set(['diagram', 'mermaid', 'ascii', 'flow', 'graph', 'tree', 'figure']);
const BOX_GLYPH = /[─│┌┐└┘├┤┬┴┼━┃┏┓┗┛╭╮╰╯═║╔╗╚╝▲▼◄►]/;
const CONNECTOR = /(^|\s)([|+\\/]|-{2,}|={2,}|-->|->|<-|=>)(\s|$)/;

export function isDiagram(lang: string | null, body: string): boolean {
  if (lang && DIAGRAM_LANGS.has(lang)) return true;
  const lines = body.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  if (BOX_GLYPH.test(body)) return true;
  // No language tag, and most lines are made of connectors rather than words.
  if (lang) return false;
  const drawn = lines.filter((l) => CONNECTOR.test(l)).length;
  return drawn >= 2 && drawn / lines.length >= 0.5;
}

/* ─── The frames ─────────────────────────────────────────────────────────── */

function BlockFrame({
  kind,
  label,
  Icon,
  text,
  copyLabel,
  children,
}: {
  kind: 'formula' | 'diagram' | 'code';
  label: string;
  Icon: typeof Sigma | null;
  text: string;
  copyLabel: string;
  children: ReactNode;
}) {
  // The formula is the one that earns the accent — it is the answer's claim in
  // its most compressed form. The other two stay in the neutral chrome.
  const accented = kind === 'formula';

  return (
    <figure
      className={[
        'group relative my-3.5 overflow-hidden rounded-lg border',
        accented ? 'border-signal/30 bg-signal/[0.05]' : 'border-line bg-ink-850',
      ].join(' ')}
    >
      <figcaption
        className={[
          'flex items-center gap-1.5 border-b px-3 py-1.5 font-mono text-2xs uppercase tracking-micro',
          accented ? 'border-signal/20 text-signal' : 'border-line-soft text-paper-mute',
        ].join(' ')}
      >
        {Icon && <Icon size={11} strokeWidth={2} />}
        {label}
        <span className="ml-auto">
          <CopyButton text={text} label={copyLabel} ghost />
        </span>
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * A formula. Set larger than the prose around it and centred, because it is a
 * statement to be checked rather than a line to be read at speed.
 */
export function FormulaBlock({ text }: { text: string }) {
  return (
    <BlockFrame kind="formula" label="formula" Icon={Sigma} text={text} copyLabel="copy formula">
      <div className="scroll-quiet overflow-x-auto px-4 py-3.5">
        <p className="whitespace-pre text-center font-mono text-[14px] leading-relaxed text-paper tabular-nums">
          {text}
        </p>
      </div>
    </BlockFrame>
  );
}

/**
 * A diagram. Left-aligned and never wrapped — an ASCII drawing is only a
 * drawing while its columns hold, so it scrolls inside its own frame instead.
 */
export function DiagramBlock({ text }: { text: string }) {
  return (
    <BlockFrame kind="diagram" label="diagram" Icon={Workflow} text={text} copyLabel="copy diagram">
      <div className="scroll-quiet overflow-x-auto px-4 py-3.5">
        <pre className="w-fit min-w-full whitespace-pre font-mono text-[12.5px] leading-[1.45] text-paper-dim">
          {text}
        </pre>
      </div>
    </BlockFrame>
  );
}

/** Ordinary code. The frame is the same; only the label and the setting differ. */
export function CodeBlock({ text, lang }: { text: string; lang: string | null }) {
  return (
    <BlockFrame kind="code" label={lang || 'code'} Icon={null} text={text} copyLabel="copy code">
      <div className="scroll-quiet overflow-x-auto px-3 py-2.5">
        <pre className="font-mono text-[12.5px] leading-relaxed text-paper-dim">{text}</pre>
      </div>
    </BlockFrame>
  );
}

/* ─── Terms ──────────────────────────────────────────────────────────────── */

/**
 * The key terms an answer introduced, collected under it.
 *
 * Source is the answer's own emphasis: what the model bolded is what the model
 * thought mattered. Numbers and dates are dropped — a term is a thing you could
 * look up, and "₹40,000" is not. Each is copyable, because the usual next move
 * is to paste it into the next question.
 */
const NOT_A_TERM = /^[\d\s₹$€%.,:;()/+-]*$/;

export function collectTerms(markdown: string): string[] {
  const found = new Map<string, string>();
  for (const m of markdown.matchAll(/\*\*([^*\n]{2,48})\*\*/g)) {
    const raw = m[1].trim().replace(/[.,;:]+$/, '');
    if (!raw || NOT_A_TERM.test(raw)) continue;
    if (raw.split(/\s+/).length > 5) continue; // a bolded sentence is emphasis, not a term
    const key = raw.toLowerCase();
    if (!found.has(key)) found.set(key, raw);
  }
  return [...found.values()].slice(0, 8);
}

export function TermStrip({ terms, onAsk }: { terms: string[]; onAsk?: (term: string) => void }) {
  const sorted = useMemo(() => [...terms].sort((a, b) => a.localeCompare(b)), [terms]);
  if (!sorted.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-[11.5px] text-paper-faint">Follow up on</span>
      {sorted.map((term) => (
        <span
          key={term}
          className="group inline-flex items-stretch overflow-hidden rounded-full border border-line
                     bg-ink-850 text-[12px] text-paper-dim"
        >
          {onAsk ? (
            <button
              type="button"
              onClick={() => onAsk(term)}
              title={`Ask what "${term}" means here`}
              className="px-2.5 py-1 transition-colors duration-150 hover:bg-signal/10 hover:text-signal"
            >
              {term}
            </button>
          ) : (
            <span className="px-2.5 py-1">{term}</span>
          )}
        </span>
      ))}
    </div>
  );
}
