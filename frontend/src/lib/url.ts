/**
 * Screening a pasted link, in the browser, before anything is fetched.
 *
 * The sibling of `screenFile`: the server enforces all of this and more (it
 * refuses private addresses after DNS, caps the body, checks the content type),
 * but a typo should be answered here rather than by a round trip. Everything
 * this file rejects, the server would have rejected too — it never invents a
 * rule of its own.
 */

/** What the server will actually be asked for, plus the host worth showing. */
export interface ParsedLink {
  /** The absolute URL, with the scheme filled in if the reader left it out. */
  href: string;
  /** The host as typed, lowercased — e.g. "www.martinfowler.com". */
  host: string;
  /** The host without `www.`, which is what the domain chip shows. */
  domain: string;
}

/**
 * Parse what was typed into something fetchable.
 *
 * `https://` is implied, because nobody types it: a bare `martinfowler.com/x`
 * is the overwhelmingly common paste and treating it as a relative path would
 * be pedantry. A scheme that *is* present is left exactly as it was, so
 * `http://` stays `http://` and a `ftp://` is still visible to the check below.
 *
 * Returns null when the string is not a URL at all.
 */
export function parseLink(raw: string): ParsedLink | null {
  const text = raw.trim();
  if (!text) return null;

  // A scheme is anything before the first "://". Without one, imply https.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;

  const host = parsed.hostname.toLowerCase();
  return {
    href: parsed.href,
    host,
    domain: host.startsWith('www.') ? host.slice(4) : host,
  };
}

/**
 * Reject a link the server would reject anyway, and say why in its words.
 *
 * Returns null when the link is worth sending. The two messages that mirror a
 * contract error are quoted verbatim, so the reader sees one sentence for one
 * problem whether it was caught here or there.
 */
export function screenLink(raw: string): string | null {
  const text = raw.trim();
  if (!text) return 'Paste a link to a web page.';

  const link = parseLink(text);
  if (!link) return 'That doesn’t look like a web address.';

  const scheme = new URL(link.href).protocol;
  if (scheme !== 'http:' && scheme !== 'https:') {
    return 'Only http and https links can be fetched.';
  }

  // A single-label host is either a typo or something on this machine, and the
  // server refuses loopback anyway. "localhost" is named explicitly because
  // that is the one people try, and the vague message would be unhelpful.
  if (link.host === 'localhost') {
    return 'That link points to a private network address, so it will not be fetched.';
  }
  if (!link.host.includes('.')) {
    return 'That doesn’t look like a web address — it has no domain in it.';
  }

  return null;
}

/**
 * A pasted link often arrives wrapped in whatever it was copied out of —
 * newlines from a terminal, angle brackets from an email, a trailing comma from
 * prose. Strip that rather than making the reader do it.
 */
export function cleanPastedLink(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/^[<("']+/, '')
    .replace(/[>)"',.]+$/, '');
}
