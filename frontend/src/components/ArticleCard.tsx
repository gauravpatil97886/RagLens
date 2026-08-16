import { ExternalLink, Link2 } from 'lucide-react';
import { formatDay } from '../lib/format';

/**
 * Here is what I found.
 *
 * The payoff of the whole link flow: proof that the right page was fetched and
 * that the scraper reached the article rather than the nav bar. It appears
 * twice — in the quote, before anything is spent, and again in the run when the
 * `article` frame lands — and it is the same card both times, because it is the
 * same claim in two tenses.
 *
 * Two rules hold this component together:
 *
 *  1. **Everything here is scraped third-party text.** It is rendered as plain
 *     React children, never through `dangerouslySetInnerHTML`. A page can
 *     contain markup, and it can contain text written to manipulate a model —
 *     it is quoted, never executed and never obeyed.
 *  2. **Serif is the document's voice.** The title and the excerpt are the
 *     page's own words, so they are set in Newsreader like every other piece of
 *     retrieved text in this app. The measurements around them are the app
 *     talking, so they stay mono.
 */
export default function ArticleCard({
  title,
  siteName,
  author,
  published,
  readingMinutes,
  nWords,
  excerpt,
  url,
}: {
  title: string;
  siteName: string;
  author: string | null;
  published: string | null;
  readingMinutes: number;
  nWords: number;
  excerpt: string;
  /** The final URL after redirects. Shown as an escape hatch to the real page. */
  url?: string | null;
}) {
  // Only what the page actually said. A missing author is left out rather than
  // filled with "Unknown" — an em dash where a name should be is an invention.
  const facts = [
    author,
    formatDay(published),
    readingMinutes > 0 ? `${readingMinutes} min read` : null,
    nWords > 0 ? `${nWords.toLocaleString()} words` : null,
  ].filter(Boolean) as string[];

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-ink-800">
      <header className="border-b border-line-soft px-4 py-3">
        <div className="flex items-center gap-2">
          <Link2 size={13} className="shrink-0 text-signal" />
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-paper-mute">
            {siteName}
          </span>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost -mr-1.5 shrink-0 px-1.5 py-1 text-2xs"
              title={url}
            >
              <ExternalLink size={12} />
              open
            </a>
          )}
        </div>

        <h4 className="mt-1.5 font-serif text-[17px] font-medium leading-snug text-paper">
          {title}
        </h4>

        {facts.length > 0 && (
          <p className="mt-1.5 font-mono text-2xs tabular-nums text-paper-faint">
            {facts.join(' · ')}
          </p>
        )}
      </header>

      {/* The excerpt. Plain text, deliberately — this is the one place in the
          app where the content came off the open web, and it is quoted the same
          way a retrieved chunk is. */}
      <p className="px-4 py-3 font-serif text-[13.5px] leading-relaxed text-paper-dim">
        {excerpt}
      </p>
    </article>
  );
}
