"""Calibrate SEMANTIC_CACHE_THRESHOLD empirically instead of guessing.

A semantic cache is a bet: "these two questions mean the same thing, so reuse the
answer." Set the threshold too high and the cache never fires. Set it too low and you
confidently serve the answer to a *different* question -- which is worse than a cache
miss, because it looks correct.

So we measure two populations against the real embedding model:

  POSITIVES  paraphrases that genuinely deserve a shared answer
  NEGATIVES  question pairs that LOOK similar but have different answers

A usable threshold sits above every negative and below as many positives as possible.
Run:  uv run python calibrate_cache.py
"""

from app import db
from app.gemini import embed_query

# Same question, different words. A hit here is correct and desirable.
POSITIVES = [
    ("How long is the probation period?",
     "What is the duration of the probationary period for new hires?"),
    ("What is the notice period?",
     "How much notice do I have to give before I resign?"),
    ("How many casual leaves do I get?",
     "What is the annual casual leave allowance?"),
    ("Can I work from home?",
     "What is the remote work policy?"),
    ("How fast are expenses reimbursed?",
     "What is the turnaround time for expense reimbursement?"),
]

# Different questions with different answers -- but lexically close, which is exactly
# where a naive threshold fails. A hit here is a WRONG answer served with confidence.
NEGATIVES = [
    ("How many casual leaves do I get?",
     "How many sick leaves do I get?"),
    ("What is the probation period?",
     "What is the notice period?"),
    ("What is the expense limit for travel?",
     "What is the expense limit for meals?"),
    ("What is the notice period during probation?",
     "What is the notice period after confirmation?"),
    ("How many days of maternity leave?",
     "How many days of paternity leave?"),
]


def cosine(a, b):
    # Vectors are already L2-normalized by embed_query, so the dot product IS cosine.
    return sum(x * y for x, y in zip(a, b))


def score(pairs):
    out = []
    for q1, q2 in pairs:
        s = cosine(embed_query(q1), embed_query(q2))
        out.append((s, q1, q2))
    return sorted(out, reverse=True)


def main() -> None:
    # embed_query() consults the Postgres embedding cache, so we need the pool.
    # Repeated runs of this script therefore cost zero API calls.
    db.init_db()
    pos = score(POSITIVES)
    neg = score(NEGATIVES)

    print("\nPOSITIVES  (same meaning -- we WANT these to hit)")
    for s, q1, q2 in pos:
        print(f"  {s:.4f}  {q1}\n          {q2}")

    print("\nNEGATIVES  (different answers -- these must NEVER hit)")
    for s, q1, q2 in neg:
        print(f"  {s:.4f}  {q1}\n          {q2}")

    worst_pos = min(s for s, _, _ in pos)
    best_neg = max(s for s, _, _ in neg)

    print(f"\nlowest  positive : {worst_pos:.4f}")
    print(f"highest negative : {best_neg:.4f}")
    print(f"separation       : {worst_pos - best_neg:+.4f}")

    if worst_pos > best_neg:
        # Sit in the gap, but nearer the negatives' ceiling: a missed cache hit costs
        # one API call, a false hit costs correctness.
        rec = round(best_neg + (worst_pos - best_neg) * 0.5, 2)
        print(f"\nClean separation. Recommended SEMANTIC_CACHE_THRESHOLD = {rec}")
        print(f"catches all {len(pos)} paraphrases, rejects all {len(neg)} near-misses")
    else:
        # The populations overlap: no single number is safe for every pair.
        safe = round(best_neg + 0.01, 2)
        caught = sum(1 for s, _, _ in pos if s >= safe)
        print("\nPopulations OVERLAP -- no threshold is both complete and safe.")
        print(f"Safety-first SEMANTIC_CACHE_THRESHOLD = {safe} "
              f"(above every negative)")
        print(f"catches {caught}/{len(pos)} paraphrases, rejects all {len(neg)} negatives")
        print("The pairs above the line in NEGATIVES are why you don't just pick 0.85.")

    db.close_db()


if __name__ == "__main__":
    main()
