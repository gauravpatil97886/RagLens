import {
  Children,
  Component,
  Fragment,
  useMemo,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock, DiagramBlock, FormulaBlock, isDiagram, toText } from './AnswerBlocks';

/**
 * The generated answer.
 *
 * Three things happen here, in this order:
 *   1. `stabilize`  — makes half-arrived markdown safe to parse mid-stream.
 *   2. `sanitizeLatex` — a fallback that turns leftover LaTeX into readable text.
 *   3. react-markdown + remark-gfm — real markdown, styled to this instrument's
 *      own type system rather than the library's defaults.
 *
 * Citations are attached afterwards, by walking the *rendered* text nodes.
 * Never by regexing the markdown source: that would eat table pipes and the
 * insides of code spans.
 */

/* ─── Bug 3: the LaTeX fallback ──────────────────────────────────────────────
 *
 * The real fix lives in the backend system prompt, which no longer asks the
 * model for LaTeX. This exists for the two cases that prompt can't reach:
 * answers already sitting in the semantic cache, and the occasional relapse.
 * It is a reader, not an engine — it converts what a policy document actually
 * contains (fractions, ×, \text runs) and gives up gracefully on the rest.
 */

/** Superscript digits, so `x^2` reads as x² rather than x^2. */
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};

/** The operators a compensation document is actually likely to use. */
const SYMBOLS: Array<[RegExp, string]> = [
  [/\\times(?![a-zA-Z])/g, '×'],
  [/\\div(?![a-zA-Z])/g, '÷'],
  [/\\cdot(?![a-zA-Z])/g, '·'],
  [/\\pm(?![a-zA-Z])/g, '±'],
  [/\\leq(?![a-zA-Z])/g, '≤'],
  [/\\geq(?![a-zA-Z])/g, '≥'],
  [/\\le(?![a-zA-Z])/g, '≤'],
  [/\\ge(?![a-zA-Z])/g, '≥'],
  [/\\neq(?![a-zA-Z])/g, '≠'],
  [/\\approx(?![a-zA-Z])/g, '≈'],
  [/\\rightarrow(?![a-zA-Z])/g, '→'],
  [/\\to(?![a-zA-Z])/g, '→'],
  [/\\ldots(?![a-zA-Z])/g, '…'],
  [/\\dots(?![a-zA-Z])/g, '…'],
  [/\\infty(?![a-zA-Z])/g, '∞'],
  [/\\sum(?![a-zA-Z])/g, 'Σ'],
  [/\\%/g, '%'],
  [/\\\$/g, '$'],
  [/\\&/g, '&'],
  [/\\#/g, '#'],
  [/\\_/g, '_'],
];

/** Index of the `}` that closes the `{` at `open`, or -1 if it never arrives. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `\text{Salary}` → `Salary`. Repeats until the command is gone. */
function unwrapCommand(input: string, name: string): string {
  let s = input;
  const needle = `\\${name}{`;
  for (let guard = 0; guard < 40; guard += 1) {
    const at = s.indexOf(needle);
    if (at === -1) break;
    const close = matchBrace(s, at + needle.length - 1);
    if (close === -1) break; // unterminated (mid-stream) — leave it alone
    s = s.slice(0, at) + s.slice(at + needle.length, close) + s.slice(close + 1);
  }
  return s;
}

/** Parens only where they stop the fraction from becoming ambiguous. */
function bracket(part: string): string {
  const t = part.trim();
  return /[\s+\-×÷/·]/.test(t) ? `(${t})` : t;
}

/** `\frac{a}{b}` → `(a) / (b)`, innermost first so nesting survives. */
function expandFractions(input: string): string {
  let s = input;
  for (let guard = 0; guard < 20; guard += 1) {
    const at = s.lastIndexOf('\\frac{');
    if (at === -1) break;
    const openNum = at + '\\frac'.length;
    const closeNum = matchBrace(s, openNum);
    if (closeNum === -1 || s[closeNum + 1] !== '{') break;
    const closeDen = matchBrace(s, closeNum + 1);
    if (closeDen === -1) break;
    const num = s.slice(openNum + 1, closeNum);
    const den = s.slice(closeNum + 2, closeDen);
    s = `${s.slice(0, at)}${bracket(num)} / ${bracket(den)}${s.slice(closeDen + 1)}`;
  }
  return s;
}

function toSuperscript(run: string): string {
  const mapped = [...run].map((ch) => SUPERSCRIPT[ch]);
  return mapped.every(Boolean) ? mapped.join('') : `^${run}`;
}

/** The body of a formula, as plain readable text. */
function mathToText(source: string): string {
  let s = source;
  // Sizing hints carry no meaning once the layout is prose.
  s = s.replace(/\\(?:left|right|bigg?|Bigg?)\s*/g, '');
  for (const cmd of ['text', 'textrm', 'textbf', 'mathrm', 'mathbf', 'mathit', 'operatorname', 'mbox']) {
    s = unwrapCommand(s, cmd);
  }
  s = expandFractions(s);
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
  for (const [re, ch] of SYMBOLS) s = s.replace(re, ch);
  s = s.replace(/\^\{([^{}]*)\}|\^(\w)/g, (_m, braced, bare) => toSuperscript(braced ?? bare));
  s = s.replace(/_\{([^{}]*)\}|_(\w)/g, (_m, braced, bare) => `_${braced ?? bare}`);
  // Spacing macros and forced line breaks are all just whitespace to us.
  s = s.replace(/\\[,;:!>]/g, ' ').replace(/\\q?quad(?![a-zA-Z])/g, '  ').replace(/\\\\/g, ' ');
  // Anything still unrecognised: keep the word, drop the backslash.
  s = s.replace(/\\([a-zA-Z]+)/g, '$1');
  s = s.replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

const CITE = /\[\d{1,3}\]/g;

/**
 * Citations get trapped inside formulas (`\text{ [1][3][4]}`). Lift them out
 * so they survive as markers in the prose and stay clickable.
 */
function liftCitations(body: string): { text: string; marks: string } {
  const marks = body.match(CITE);
  if (!marks) return { text: body, marks: '' };
  return { text: body.replace(CITE, '').replace(/\s+/g, ' ').trim(), marks: marks.join('') };
}

/**
 * A display formula becomes its own fenced block, tagged `formula`, which the
 * component map below turns into a framed, copyable figure. An inline formula
 * becomes a mono code span — mono is this UI's voice for a machine-measured
 * fact, which is exactly what a formula is. Short scraps of inline math
 * (`$2\times$`) stay as prose, because `2×` in a chip reads worse than 2× in
 * the sentence.
 *
 * Citations are lifted out first and re-attached *after* the block, so a
 * reference never ends up inside a fence where it would stop being clickable.
 */
function formulaToMarkdown(inner: string, display: boolean): string {
  const { text, marks } = liftCitations(mathToText(inner));
  const clean = text.replace(/`/g, ''); // a stray backtick would break the span
  if (!clean) return marks;
  if (display) return `\n\n\`\`\`formula\n${clean}\n\`\`\`\n\n${marks}`;
  const asCode = clean.length > 12 || /[=/]/.test(clean);
  return (asCode ? `\`${clean}\`` : clean) + (marks ? ` ${marks}` : '');
}

/** Only treat `$…$` as math if it looks like math — otherwise $5,000 loses its $. */
function looksLikeMath(inner: string): boolean {
  return /[\\^_]/.test(inner);
}

const CODE_SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

export function sanitizeLatex(markdown: string): string {
  if (!markdown.includes('$') && !markdown.includes('\\')) return markdown;

  return markdown
    .split(CODE_SPAN)
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // odd slices are code — never touched
      let out = segment;
      out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner: string) => formulaToMarkdown(inner, true));
      out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => formulaToMarkdown(inner, true));
      out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => formulaToMarkdown(inner, false));
      out = out.replace(/\$([^$\n]+?)\$/g, (m, inner: string) =>
        looksLikeMath(inner) ? formulaToMarkdown(inner, false) : m,
      );
      // Naked commands, with no math delimiters around them at all. Targeted
      // repairs only — the whole-formula pass above is too destructive to run
      // over ordinary prose.
      if (/\\(?:text|mathrm|frac|times|cdot|div|leq|geq)\b/.test(out)) {
        for (const cmd of ['text', 'textrm', 'mathrm', 'mathbf', 'operatorname']) {
          out = unwrapCommand(out, cmd);
        }
        out = expandFractions(out);
        for (const [re, ch] of SYMBOLS) out = out.replace(re, ch);
      }
      return out;
    })
    .join('');
}

/* ─── Streaming: markdown that hasn't finished arriving ──────────────────── */

/**
 * Mid-stream the text is a truncated document, so the parser is regularly
 * handed an unclosed fence or half a formula. Close what we can and hide what
 * we can't; the next token usually repairs it anyway.
 */
function stabilize(markdown: string, streaming: boolean): string {
  if (!streaming) return markdown;
  let s = markdown;

  const fences = s.match(/^\s*```/gm);
  if (fences && fences.length % 2 === 1) s += '\n```';

  // An opened-but-unclosed formula: withhold it rather than show raw markup.
  const openMath = /\$\$?[^$]*$/.exec(s);
  if (openMath && openMath[0].includes('\\')) s = `${s.slice(0, openMath.index)}…`;

  return s;
}

/* ─── Bug 1: citation markers that can never be read as digits ───────────── */

/** A run of adjacent markers: `[1][3][4]`, or `[1] [3]`. */
const CITE_RUN = /(\[\d{1,3}\](?:[ \t]*\[\d{1,3}\])*)/g;
const CITE_RUN_ONLY = /^\[\d{1,3}\](?:[ \t]*\[\d{1,3}\])*$/;

/**
 * One raised chip per run, with hairline dividers between the numerals inside
 * it. `[1][3][4]` reads as three separated references and cannot collapse into
 * "134"; each numeral is its own button.
 */
function CiteGroup({ nums, onCite }: { nums: number[]; onCite: (n: number) => void }) {
  return (
    <span
      className="mx-[0.2em] inline-flex translate-y-[-0.28em] select-none items-stretch divide-x
                 divide-signal/30 overflow-hidden rounded-[3px] border border-signal/35
                 bg-signal/[0.09] align-baseline font-mono text-[0.68em] leading-none tabular-nums"
    >
      {nums.map((n, i) => (
        <button
          key={`${n}-${i}`}
          type="button"
          onClick={() => onCite(n)}
          aria-label={`Show source ${n}`}
          title={`Show source ${n}`}
          className="px-[0.42em] py-[0.34em] text-signal transition-colors duration-150
                     hover:bg-signal hover:text-onaccent"
        >
          {n}
        </button>
      ))}
    </span>
  );
}

/**
 * Walks the text nodes react-markdown hands a component and swaps citation
 * runs for chips. Applied per element, so `code`/`pre` — which simply don't
 * call it — are structurally incapable of being rewritten.
 */
function withCitations(children: ReactNode, onCite: (n: number) => void): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== 'string' || !child.includes('[')) return child;
    const parts = child.split(CITE_RUN);
    if (parts.length === 1) return child;
    return parts.map((part, i) => {
      if (!part) return null;
      if (CITE_RUN_ONLY.test(part)) {
        const nums = (part.match(/\d{1,3}/g) ?? []).map(Number);
        return <CiteGroup key={i} nums={nums} onCite={onCite} />;
      }
      return <Fragment key={i}>{part}</Fragment>;
    });
  });
}

/* ─── Bug 2: real markdown, in this instrument's type system ─────────────── */

function buildComponents(onCite: (n: number) => void): Components {
  const cite = (children: ReactNode) => withCitations(children, onCite);

  return {
    p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{cite(children)}</p>,

    // Headings inside an answer are section breaks in something you are
    // reading, so they are set in the reading face, one notch up and heavier.
    // They used to be mono micro-caps, which made every answer look like a
    // config dump.
    h1: ({ children }) => (
      <h3 className="mb-2 mt-6 text-[1.0625rem] font-semibold tracking-[-0.01em] text-paper first:mt-0">
        {cite(children)}
      </h3>
    ),
    h2: ({ children }) => (
      <h3 className="mb-2 mt-6 text-[1.0625rem] font-semibold tracking-[-0.01em] text-paper first:mt-0">
        {cite(children)}
      </h3>
    ),
    h3: ({ children }) => (
      <h4 className="mb-1.5 mt-5 text-[0.95rem] font-semibold text-paper first:mt-0">
        {cite(children)}
      </h4>
    ),
    h4: ({ children }) => (
      <h5 className="mb-1.5 mt-4 text-[0.9rem] font-semibold text-paper-dim first:mt-0">
        {cite(children)}
      </h5>
    ),

    ul: ({ children }) => (
      <ul className="my-3 list-disc space-y-2 pl-[1.15rem] marker:text-signal/60">{children}</ul>
    ),
    ol: ({ children, start }) => (
      <ol
        start={start ?? undefined}
        className="my-3 list-decimal space-y-2 pl-[1.6rem] marker:font-mono marker:text-[0.8em]
                   marker:tabular-nums marker:text-signal/70"
      >
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="pl-0.5 [&>ol]:mt-1.5 [&>ul]:mt-1.5">{cite(children)}</li>,

    // What the model bolded is what the model thought mattered — so emphasis is
    // treated as a term being introduced, and marked like one. A bolded
    // *sentence* is just emphasis, and gets weight without the highlighter.
    strong: ({ children }) => {
      const raw = toText(children).trim();
      const isTerm =
        raw.length > 1 && raw.length <= 48 && raw.split(/\s+/).length <= 5 && /[a-zA-Z]/.test(raw);
      return (
        <strong className={['font-semibold text-paper', isTerm ? 'term-mark' : ''].join(' ')}>
          {cite(children)}
        </strong>
      );
    },
    em: ({ children }) => <em className="italic text-paper-dim">{cite(children)}</em>,
    del: ({ children }) => <del className="text-paper-mute line-through">{cite(children)}</del>,

    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal"
      >
        {cite(children)}
      </a>
    ),

    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-signal/40 pl-3 text-paper-dim">{children}</blockquote>
    ),

    hr: () => <hr className="my-4 border-0 border-t border-line" />,

    // Code keeps the model's exact characters. Citations are deliberately not
    // touched in here — inside a code span, `[3]` is content, not a reference.
    //
    // Only *inline* spans are styled here. A fenced block arrives as
    // `pre > code`, and `pre` below owns that case entirely, so a block is
    // never wrapped in a chip on its way to its frame.
    code: ({ children, className }) => {
      if (/language-/.test(className ?? '')) return <>{children}</>;
      return (
        <code className="rounded border border-line-soft bg-ink-750 px-1 py-0.5 font-mono text-[0.85em] text-paper-dim">
          {children}
        </code>
      );
    },

    // A fence is one of three things, and which one decides the frame it gets.
    pre: ({ children }) => {
      const child = Children.toArray(children)[0] as
        | { props?: { className?: string; children?: ReactNode } }
        | undefined;
      const lang = /language-(\w+)/.exec(child?.props?.className ?? '')?.[1]?.toLowerCase() ?? null;
      const body = toText(child?.props?.children ?? children).replace(/\n$/, '');

      if (lang === 'formula') return <FormulaBlock text={body} />;
      if (isDiagram(lang, body)) return <DiagramBlock text={body} />;
      return <CodeBlock text={body} lang={lang} />;
    },

    // GFM tables scroll inside their own frame. The page never scrolls sideways.
    table: ({ children }) => (
      <div className="scroll-quiet my-3 w-full overflow-x-auto rounded-lg border border-line bg-ink-850/60">
        <table className="w-full min-w-[24rem] border-collapse text-left">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-ink-800">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="border-b border-line-soft last:border-0">{children}</tr>,
    th: ({ children, style }) => (
      <th
        style={style as CSSProperties}
        className="border-b border-line px-3 py-2 font-mono text-2xs font-normal uppercase tracking-micro text-paper-mute"
      >
        {cite(children)}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style as CSSProperties} className="px-3 py-2 align-top text-[13.5px] leading-relaxed">
        {cite(children)}
      </td>
    ),

    img: ({ alt }) => <span className="font-mono text-2xs text-paper-mute">[image: {alt || 'untitled'}]</span>,
  };
}

/* ─── Safety net ─────────────────────────────────────────────────────────── */

/**
 * A malformed fragment should cost the reader the formatting, never the
 * answer. Resets itself on the next token, so a mid-stream stumble heals.
 */
class MarkdownBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean; key: string }
> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; key: string },
  ) {
    if (props.resetKey !== state.key) return { failed: false, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Worth seeing in the console: this should not happen for model output.
    console.warn('AnswerText fell back to plain text', error, info.componentStack);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
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
  const source = useMemo(() => sanitizeLatex(stabilize(text, streaming)), [text, streaming]);
  const components = useMemo(() => buildComponents(onCite), [onCite]);

  return (
    <div
      className={[
        'answer-md min-w-0 text-[15.5px] leading-[1.72] text-paper',
        streaming ? 'answer-streaming' : '',
      ].join(' ')}
    >
      <MarkdownBoundary
        resetKey={String(source.length)}
        fallback={<p className="whitespace-pre-wrap">{text}</p>}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {source}
        </ReactMarkdown>
      </MarkdownBoundary>
      {/* Nothing has arrived yet — an empty line so the caret has somewhere to sit. */}
      {source.length === 0 && streaming && <p aria-hidden="true" />}
    </div>
  );
}
