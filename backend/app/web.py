"""Fetching a web page and getting the article out of it.

Three jobs, in order: prove the URL is safe to request, download it under strict limits,
then throw away the navigation, ads and cookie banner and keep the prose. The result is
plain text, which is all the rest of the pipeline has ever consumed — a link becomes an
ordinary document and nothing downstream knows the difference.

The safety half is the part worth reading twice. A backend that fetches a URL a stranger
typed is a proxy into whatever network it runs in, so every hop is resolved and checked
against the private ranges before the request is made, and again after every redirect.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import httpx
import trafilatura
from bs4 import BeautifulSoup
from trafilatura.metadata import extract_metadata

from .config import settings

log = logging.getLogger(__name__)


class FetchError(Exception):
    """A link we will not or cannot turn into a document.

    The message is the exact plain-English `detail` the contract promises, so callers
    hand it straight to the user with a 400 and never reword it.
    """


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FetchResult:
    """What came back off the wire, plus how it got here."""

    url: str  # as the user typed it
    final_url: str  # after redirects
    normalized_url: str  # dedup key; see normalize_url
    status: int
    content_type: str
    encoding: str
    body: bytes
    fetch_ms: int
    from_cache: bool

    @property
    def text(self) -> str:
        return self.body.decode(self.encoding, errors="replace")

    @property
    def host(self) -> str:
        return urlsplit(self.final_url).hostname or ""


@dataclass(frozen=True)
class Article:
    """The prose, and the handful of facts a reader uses to confirm we scraped the
    right thing before spending any embedding quota on it."""

    title: str
    author: str | None
    published: str | None
    site_name: str
    text: str
    n_words: int
    reading_minutes: int
    excerpt: str


@dataclass(frozen=True)
class Page:
    """A fetched page and the article scraped out of it.

    Produced once per user action by load(), then passed around: preflight, the 400-or-
    open-the-stream check and the ingest stream all describe the same bytes, so the
    excerpt a reader approved is exactly the text that gets indexed.
    """

    fetch: FetchResult
    article: Article


# ---------------------------------------------------------------------------
# URL normalisation
# ---------------------------------------------------------------------------

# Params that identify the campaign that sent you, never the page you asked for. Two
# links differing only in these are the same article and must dedup as one.
_TRACKING_PARAMS = {"gclid", "fbclid", "ref", "ref_src", "mc_cid", "mc_eid"}
_TRACKING_PREFIXES = ("utm_",)


def normalize_url(url: str) -> str:
    """The dedup key for a link: same article in, same string out.

    Lowercase the scheme and host, drop `www.`, drop the fragment (it never reaches the
    server), drop tracking params, sort what is left so param order stops mattering, and
    strip a trailing slash. Deliberately conservative — it only removes things that
    cannot change what the server returns.
    """
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]

    netloc = host
    if parts.port and not (
        (scheme == "http" and parts.port == 80) or (scheme == "https" and parts.port == 443)
    ):
        netloc = f"{host}:{parts.port}"

    kept = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in _TRACKING_PARAMS and not k.lower().startswith(_TRACKING_PREFIXES)
    ]
    query = urlencode(sorted(kept))

    path = parts.path.rstrip("/")
    return urlunsplit((scheme, netloc, path, query, ""))


# ---------------------------------------------------------------------------
# Fetching, safely
# ---------------------------------------------------------------------------

ALLOWED_CONTENT_TYPES = {
    "text/html",
    "application/xhtml+xml",
    "text/plain",
    "text/markdown",
}

USER_AGENT = (
    "RAGLens/1.0 (+https://github.com/raglens; teaching RAG demo; fetches pages a user pasted)"
)

# Plain-English names for the content types people most often paste by mistake, so the
# refusal says what the link actually is instead of echoing a MIME type at them.
_TYPE_NAMES = {
    "application/pdf": "a PDF",
    "application/zip": "a ZIP archive",
    "application/json": "JSON",
    "application/xml": "an XML file",
    "text/xml": "an XML file",
    "text/csv": "a CSV file",
}


def _describe_content_type(content_type: str) -> str:
    if content_type in _TYPE_NAMES:
        return _TYPE_NAMES[content_type]
    family = content_type.split("/", 1)[0]
    if family in {"image", "video", "audio"}:
        return {"image": "an image", "video": "a video", "audio": "an audio file"}[family]
    return f"a {content_type} file" if content_type else "not text"


# NAT64 (RFC 6052): on a DNS64 network every IPv4-only host also resolves to an address
# in this prefix with the real IPv4 address in its low 32 bits. Python calls the whole
# 64:ff9b::/96 block "reserved" because it starts inside ::/8, so judging it as-is would
# refuse every public site on such a network.
_NAT64_WELL_KNOWN = ipaddress.ip_network("64:ff9b::/96")


def _real_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address):
    """Unwrap an IPv6 address that is really carrying an IPv4 one.

    ::ffff:127.0.0.1 is loopback wearing an IPv6 hat, and 64:ff9b::a00:5 is 10.0.0.5 on a
    NAT64 network. Both must be judged by the address inside, or the guard is bypassable
    by writing the target in the other notation.
    """
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return address.ipv4_mapped
        if address in _NAT64_WELL_KNOWN:
            return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
    return address


def _check_address(host: str, port: int) -> None:
    """Resolve `host` ourselves and refuse anything that points inside our own network.

    Doing the DNS lookup here rather than letting httpx do it is the whole point: a name
    like `metadata.internal` or an A record pointing at 169.254.169.254 is only visible
    as an address, and the cloud metadata service is one unguarded fetch away from
    handing out credentials. Every resolved address must pass, not just the first —
    a name that answers with one public and one private address is the classic bypass.

    A determined attacker can still re-answer the DNS query between this check and the
    connection (DNS rebinding). Closing that needs connecting to a pinned IP and sending
    the hostname in the Host header, which is more machinery than this demo earns — the
    ranges below are the attack worth stopping.
    """
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError("That domain could not be found.") from exc

    for info in infos:
        address = _real_address(ipaddress.ip_address(info[4][0]))
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise FetchError(
                "That link points to a private network address, so it will not be fetched."
            )


def fetch(url: str) -> FetchResult:
    """GET a URL under the contract's limits, following redirects by hand.

    Redirects are followed manually because httpx's own follow_redirects would resolve
    and connect to each hop without asking us — and a public host that 302s to
    169.254.169.254 is the standard way past a guard that only checks the first URL.
    """
    started = time.perf_counter()
    current = url.strip()
    seen: list[str] = []

    with httpx.Client(
        follow_redirects=False,
        timeout=settings.fetch_timeout_seconds,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            "Accept-Language": "en",
        },
    ) as client:
        for _ in range(settings.max_redirects + 1):
            parts = urlsplit(current)
            if parts.scheme not in ("http", "https"):
                raise FetchError("Only http and https links can be fetched.")
            if not parts.hostname:
                raise FetchError("That domain could not be found.")
            _check_address(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))

            seen.append(current)
            try:
                with client.stream("GET", current) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise FetchError(
                                f"The site answered with {response.status_code} "
                                f"{response.reason_phrase} but did not say where to go."
                            )
                        current = urljoin(current, location)
                        continue
                    if response.status_code >= 400 or response.status_code < 200:
                        raise FetchError(
                            f"The site answered with {response.status_code} "
                            f"{response.reason_phrase}."
                        )

                    content_type = (
                        response.headers.get("content-type", "").split(";")[0].strip().lower()
                    )
                    if content_type and content_type not in ALLOWED_CONTENT_TYPES:
                        raise FetchError(
                            f"That link is {_describe_content_type(content_type)}, not a web "
                            "page — download it and upload the file instead."
                        )

                    body = _read_capped(response)
                    return FetchResult(
                        url=url,
                        final_url=str(response.url),
                        normalized_url=normalize_url(str(response.url)),
                        status=response.status_code,
                        content_type=content_type or "text/html",
                        encoding=response.encoding or "utf-8",
                        body=body,
                        fetch_ms=int((time.perf_counter() - started) * 1000),
                        from_cache=False,
                    )
            except httpx.TimeoutException as exc:
                raise FetchError("That site took too long to respond.") from exc
            except httpx.ConnectError as exc:
                # httpx wraps DNS failures in ConnectError too; ours already resolved, so
                # anything left here is the host refusing or unreachable.
                raise FetchError(f"That site could not be reached: {exc}") from exc
            except httpx.HTTPError as exc:
                raise FetchError(f"That page could not be fetched: {exc}") from exc

    raise FetchError(
        f"That link redirected more than {settings.max_redirects} times, so it was abandoned."
    )


def _read_capped(response: httpx.Response) -> bytes:
    """Read the body, stopping the moment it exceeds the cap.

    Streamed rather than `response.content` so a hostile or misconfigured server cannot
    make us hold a gigabyte in memory before we notice it was too big. A Content-Length
    that promises too much is refused without reading anything at all.
    """
    limit = settings.max_fetch_bytes
    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise FetchError(f"That page is larger than the {limit // 1_048_576} MB limit.")

    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > limit:
            raise FetchError(f"That page is larger than the {limit // 1_048_576} MB limit.")
        chunks.append(chunk)
    return b"".join(chunks)


# ---------------------------------------------------------------------------
# The page-body cache
#
# Preflight fetches the page to show the reader an excerpt; pressing Index then needs
# the same bytes seconds later. Without this the site is hit twice for one human action,
# which is rude to the site and makes `fetch_ms` on the second run a lie about work that
# did not need doing. Bodies only — this is not the embedding cache and not the answer
# cache.
# ---------------------------------------------------------------------------

_CACHE_MAX_ENTRIES = 32
_cache: OrderedDict[str, tuple[float, FetchResult]] = OrderedDict()
_cache_lock = threading.Lock()


def _cache_get(key: str) -> FetchResult | None:
    now = time.monotonic()
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        stored_at, result = entry
        if now - stored_at > settings.fetch_cache_ttl_seconds:
            del _cache[key]
            return None
    # fetch_ms: 0 is not a rounding artefact — no fetch happened. Saying so is the point.
    return replace(result, from_cache=True, fetch_ms=0)


def _cache_put(key: str, result: FetchResult) -> None:
    with _cache_lock:
        _cache[key] = (time.monotonic(), result)
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)  # oldest out first


def fetch_cached(url: str) -> FetchResult:
    """fetch(), but reusing a body fetched for the same normalised URL minutes ago."""
    key = normalize_url(url)
    hit = _cache_get(key)
    if hit is not None:
        return hit
    result = fetch(url)
    # Keyed on both the requested and the final URL: preflight and index may be given
    # different spellings of the same link, and either should hit.
    _cache_put(key, result)
    _cache_put(result.normalized_url, result)
    return result


# ---------------------------------------------------------------------------
# Scraping
# ---------------------------------------------------------------------------

# Below this there is no article — a paywall stub, a redirect notice, or a page whose
# text only exists after JavaScript runs, which this demo does not execute.
MIN_ARTICLE_CHARS = 200
_EXCERPT_CHARS = 320
# Adult silent-reading speed for prose, the figure most "N min read" badges use.
_WORDS_PER_MINUTE = 238
# Structure that surrounds an article without being part of it.
_BOILERPLATE_TAGS = ("script", "style", "noscript", "nav", "header", "footer", "aside", "form")


def extract_article(html: str, url: str) -> Article:
    """Pull the readable article out of a page.

    trafilatura is the extractor because it was built for exactly this and scores well
    against hand-labelled corpora; `favor_precision` tells it to drop anything it is not
    confident is body text, which is the right trade here — a reader is about to approve
    this excerpt as "yes, that is the article", so a missing paragraph is far cheaper
    than a cookie banner presented as content.
    """
    text = (
        trafilatura.extract(
            html,
            url=url,
            include_comments=False,
            include_tables=True,
            favor_precision=True,
        )
        or ""
    ).strip()

    if not text:
        # Not an article-shaped page (a plain .txt link, a wiki index, a stubborn
        # layout). Take every visible word instead and let the length check judge it.
        text = _visible_text(html)

    if len(text) < MIN_ARTICLE_CHARS:
        raise FetchError(
            f"Only {len(text)} characters of article text could be found — "
            "the page may be mostly JavaScript."
        )

    meta = _metadata(html, url)
    host = (urlsplit(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]

    n_words = len(text.split())
    return Article(
        title=_title(meta, url, host),
        author=_clean(getattr(meta, "author", None)),
        published=_clean(getattr(meta, "date", None)),
        site_name=host,
        text=text,
        n_words=n_words,
        reading_minutes=max(1, round(n_words / _WORDS_PER_MINUTE)),
        excerpt=_excerpt(text),
    )


def _metadata(html: str, url: str):
    """Title/author/date, or an object whose fields are all None if the parse fails."""
    try:
        return extract_metadata(html, default_url=url) or _EMPTY_METADATA
    except Exception:
        # Metadata is decoration; never let it fail an extraction that produced text.
        log.debug("metadata extraction failed for %s", url, exc_info=True)
        return _EMPTY_METADATA


class _EmptyMetadata:
    title = author = date = None


_EMPTY_METADATA = _EmptyMetadata()


def _visible_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(_BOILERPLATE_TAGS):
        tag.decompose()
    return soup.get_text("\n", strip=True)


def _title(meta, url: str, host: str) -> str:
    """A name for the document, in descending order of how much a human would like it."""
    title = _clean(getattr(meta, "title", None))
    if title:
        return title[:120]
    segment = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
    return segment[:120] if segment else host


def _clean(value: str | None) -> str | None:
    if not value:
        return None
    flat = " ".join(str(value).split())
    return flat or None


def _excerpt(text: str) -> str:
    """The opening of the article on one line — the reader's proof we scraped the prose
    and not the navigation."""
    flat = " ".join(text.split())
    return flat if len(flat) <= _EXCERPT_CHARS else flat[:_EXCERPT_CHARS].rstrip() + "…"


def load(url: str) -> Page:
    """Fetch (or reuse) a page and scrape it. Every URL path starts here."""
    fetched = fetch_cached(url)
    return Page(fetch=fetched, article=extract_article(fetched.text, fetched.final_url))
