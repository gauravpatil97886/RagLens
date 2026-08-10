"""The two-layer answer cache.

Layer 1 — exact: the same question text, normalised, in the same document scope.
Layer 2 — semantic: a *different* wording of a question we already answered. "What's the
refund window?" and "How long do I have to return something?" are different strings but
the same question, and their embeddings sit next to each other.

Both layers key on `scope_key` as well as the question. A cached answer is only valid for
the exact set of documents it was retrieved from — replaying it for a different selection
would cite chunks the user did not search.
"""

from __future__ import annotations

import json
import re
from typing import Any

from pgvector import Vector

from .config import settings

# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------

_PUNCT = re.compile(r"[^\w\s]+")
_WS = re.compile(r"\s+")


def normalize_question(question: str) -> str:
    """Case, spacing and punctuation should not cause a cache miss."""
    return _WS.sub(" ", _PUNCT.sub(" ", question.lower())).strip()


def scope_key(document_ids: list[int] | None) -> str:
    """Stable key for the set of documents being searched.

    Deliberately human-readable ("ids:,1,3,") rather than a hash: deleting document 3
    must invalidate every cached answer whose scope contained 3, and you cannot look
    inside a hash to find out. The comma padding makes `LIKE '%,3,%'` an exact member
    test rather than a prefix match on 13 or 31.
    """
    if not document_ids:
        return "ALL"
    return "ids:," + ",".join(str(i) for i in sorted(set(document_ids))) + ","


def miss(nearest: dict[str, Any] | None = None) -> dict[str, Any]:
    """`nearest` is the best candidate that still failed the threshold. Surfacing it
    turns an invisible miss into a tunable one: you can see that the closest cached
    question scored 0.86 against a 0.87 bar and decide whether the bar is wrong."""
    return {
        "hit": False,
        "kind": "miss",
        "similarity": None,
        "matched_question": None,
        "age_seconds": None,
        "saved_api_calls": 0,
        "nearest": nearest,
        "threshold": settings.semantic_cache_threshold,
    }


def _hit(kind: str, similarity: float, matched_question: str, age_seconds: float) -> dict[str, Any]:
    return {
        "hit": True,
        "kind": kind,
        "similarity": round(float(similarity), 4),
        "matched_question": matched_question,
        "age_seconds": int(age_seconds),
        # One saved call: the generation request we did not have to make.
        "saved_api_calls": 1,
        "nearest": None,
        "threshold": settings.semantic_cache_threshold,
    }


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------

_TTL = "make_interval(hours => %(ttl)s)"

_SELECT = """
    SELECT id, question, answer, citations,
           EXTRACT(EPOCH FROM (now() - created_at)) AS age_seconds
"""


def lookup_exact(conn, question: str, scope: str) -> dict[str, Any] | None:
    """Layer 1. Needs no embedding at all, so it runs before we call the API."""
    row = conn.execute(
        f"""
        {_SELECT}
          FROM query_cache
         WHERE question_norm = %(qn)s
           AND scope_key = %(scope)s
           AND created_at > now() - {_TTL}
        """,
        {"qn": normalize_question(question), "scope": scope, "ttl": settings.cache_ttl_hours},
    ).fetchone()
    if row is None:
        return None
    return {
        "row": row,
        "cache": _hit("exact", 1.0, row["question"], row["age_seconds"]),
    }


def lookup_semantic(conn, question_embedding: list[float], scope: str) -> dict[str, Any] | None:
    """Layer 2. Reuses the embedding that retrieval needs anyway — we never pay for a
    second embedding call just to check the cache."""
    if not settings.semantic_cache_enabled:
        return None
    row = conn.execute(
        f"""
        {_SELECT},
               1 - (question_embedding <=> %(q)s) AS similarity
          FROM query_cache
         WHERE scope_key = %(scope)s
           AND created_at > now() - {_TTL}
         ORDER BY question_embedding <=> %(q)s
         LIMIT 1
        """,
        {
            "q": Vector(question_embedding),  # must be Vector(), not a bare list
            "scope": scope,
            "ttl": settings.cache_ttl_hours,
        },
    ).fetchone()
    if row is None:
        return None
    if row["similarity"] < settings.semantic_cache_threshold:
        # Not close enough to reuse, but worth reporting — see miss().
        return {
            "row": None,
            "cache": miss({
                "question": row["question"],
                "similarity": round(float(row["similarity"]), 4),
            }),
        }
    return {
        "row": row,
        "cache": _hit("semantic", row["similarity"], row["question"], row["age_seconds"]),
    }


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def record_hit(conn, entry_id: int) -> None:
    conn.execute(
        "UPDATE query_cache SET hits = hits + 1, last_hit_at = now() WHERE id = %s",
        (entry_id,),
    )


def store(
    conn,
    question: str,
    scope: str,
    question_embedding: list[float],
    answer: str,
    citations: list[dict],
) -> None:
    conn.execute(
        """
        INSERT INTO query_cache
            (question, question_norm, scope_key, question_embedding, answer, citations)
        VALUES (%(q)s, %(qn)s, %(scope)s, %(vec)s, %(answer)s, %(citations)s)
        ON CONFLICT (question_norm, scope_key) DO UPDATE
            SET question = EXCLUDED.question,
                question_embedding = EXCLUDED.question_embedding,
                answer = EXCLUDED.answer,
                citations = EXCLUDED.citations,
                created_at = now()
        """,
        {
            "q": question,
            "qn": normalize_question(question),
            "scope": scope,
            "vec": Vector(question_embedding),
            "answer": answer,
            "citations": json.dumps(citations),
        },
    )


def bump_stats(conn, kind: str) -> None:
    column = {"exact": "exact_hits", "semantic": "semantic_hits"}.get(kind, "misses")
    conn.execute(f"UPDATE cache_stats SET {column} = {column} + 1 WHERE id = true")


def invalidate_for_document(conn, document_id: int) -> int:
    """Drop every cached answer that could have cited this document.

    That means scope 'ALL' (searched everything, so it may have used this document) plus
    any explicit scope containing the id. Coarse on purpose: over-invalidating costs one
    regenerated answer, under-invalidating serves citations pointing at deleted chunks.
    """
    row = conn.execute(
        """
        DELETE FROM query_cache
         WHERE scope_key = 'ALL' OR scope_key LIKE %(needle)s
        RETURNING 1
        """,
        {"needle": f"%,{document_id},%"},
    ).fetchall()
    return len(row)


def invalidate_all_scope(conn) -> int:
    """A new document changes what 'search everything' means, so those answers are stale."""
    rows = conn.execute("DELETE FROM query_cache WHERE scope_key = 'ALL' RETURNING 1").fetchall()
    return len(rows)


def clear(conn) -> int:
    rows = conn.execute("DELETE FROM query_cache RETURNING 1").fetchall()
    conn.execute("UPDATE cache_stats SET exact_hits = 0, semantic_hits = 0, misses = 0")
    return len(rows)
