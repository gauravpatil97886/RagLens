"""Recursive character text splitter.

Why not just cut every N characters? Because an embedding is only as good as the
coherence of the text it summarises. Splitting mid-sentence produces a vector that
represents two half-thoughts and retrieves badly. So we try the *largest* natural
boundary first (blank line between paragraphs), fall back to single newlines, then
sentence ends, then words, and only hard-cut when a single "word" is longer than a
chunk.
"""

from __future__ import annotations

from collections.abc import Iterator

# Ordered widest-to-narrowest. "" is the last-resort hard cut.
SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""]


def chunk_text(text: str, size: int, overlap: int) -> list[str]:
    """Split `text` into ~`size`-character chunks that overlap by `overlap` characters.

    The overlap exists because a fact can straddle a boundary: if chunk 3 ends with
    "...refunds are accepted within" and chunk 4 begins "30 days of delivery", neither
    chunk answers "what is the refund window?". Repeating the tail of each chunk at the
    head of the next means every sentence appears whole in at least one chunk.
    """
    return list(iter_chunks(text, size, overlap))


def iter_chunks(text: str, size: int, overlap: int) -> Iterator[str]:
    """chunk_text, one chunk at a time, so a caller can report progress as they appear.

    Same splitter, same result — chunk_text is literally list() over this.
    """
    if size <= 0:
        raise ValueError("chunk size must be positive")
    overlap = max(0, min(overlap, size // 2))  # overlap >= size would never advance

    text = text.strip()
    if not text:
        return

    # Fragments are capped at size-overlap, not size: a chunk is one carried overlap tail
    # plus fragments, so this keeps the finished chunk at or under `size`.
    limit = max(1, size - overlap)
    pieces = _split(text, limit, SEPARATORS)
    yield from _merge(pieces, size, overlap)


def _split(text: str, limit: int, separators: list[str]) -> list[str]:
    """Break `text` into fragments no longer than `limit`, preferring early separators."""
    if len(text) <= limit:
        return [text]

    for i, sep in enumerate(separators):
        if not sep or sep not in text:
            continue
        parts = text.split(sep)
        # Re-attach the separator so the original text round-trips exactly.
        parts = [p + sep for p in parts[:-1]] + [parts[-1]]
        out: list[str] = []
        for part in parts:
            if not part:
                continue
            if len(part) > limit:
                out.extend(_split(part, limit, separators[i + 1 :]))
            else:
                out.append(part)
        return out

    # No separator helped (e.g. a 5000-character base64 blob): hard cut.
    return [text[i : i + limit] for i in range(0, len(text), limit)]


def _merge(pieces: list[str], size: int, overlap: int) -> Iterator[str]:
    """Greedily glue fragments back together up to `size`, carrying an overlap tail."""
    current = ""
    for piece in pieces:
        if current and len(current) + len(piece) > size:
            finished = current.strip()
            if finished:
                yield finished
            current = current[-overlap:] if overlap else ""
        current += piece
    if current.strip():
        yield current.strip()
