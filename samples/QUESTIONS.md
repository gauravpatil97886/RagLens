# Test questions for `acme-employee-handbook.md`

Upload `acme-employee-handbook.md` first, then run these through `/api/chat` (or
the chat UI) roughly in order. Expected behavior is noted for each — use it to
sanity-check retrieval, grounding, and the semantic cache.

1. **"How long is the probation period?"**
   Directly answerable. Expect an answer citing 90 days, with a note that it can
   be extended once by up to 30 days (Section 1).

2. **"What's the notice period after I'm confirmed as an individual contributor?"**
   Directly answerable: 60 days (Section 6).

3. **"How much is the home office stipend for remote work?"**
   Directly answerable: ₹15,000, one-time, claimable once every 3 years
   (Section 4).

4. **"Within how many days of an expense must I submit my claim, and how long
   does reimbursement take after that?"**
   Directly answerable, two numbers from the same section: submit within 15
   days, Finance pays within 7 working days of approval (Section 5).

5. **"If I resign right after my probation ends, what notice do I owe, and will
   I get paid out for unused earned leave?"**
   Requires combining two sections: notice period for a just-confirmed
   individual contributor is 60 days (Section 6), and EL encashment on exit is
   capped at 30 days at last-drawn basic salary (Section 3). A good answer
   should cite both.

6. **"What's the company's policy on stock options and ESOP vesting?"**
   Deliberately NOT covered anywhere in the handbook. This should produce
   `citations: []` and an answer that says the documents don't cover it —
   not a guess. Use this to prove the system doesn't hallucinate when
   `MIN_SIMILARITY` isn't cleared.

## Semantic cache pairs

The default `SEMANTIC_CACHE_THRESHOLD` is `0.87`, derived empirically by
`backend/calibrate_cache.py` against real paraphrase and look-alike pairs
scored on `gemini-embedding-001` at 768 dims (see the README, Section 5). The
three pairs below demonstrate the three outcomes that threshold produces —
including the honest one, where a real paraphrase still misses.

7. **"How fast are expenses reimbursed?"**
   First time asked, this is a cache **miss**: `cache.kind = "miss"`,
   `timings_ms.generate` is non-zero. Answer comes from Section 5: Finance
   disburses within 7 working days of manager approval.

8. **"What is the turnaround time for expense reimbursement?"**
   Same question as #7, reworded. Ask this *after* #7. Measured similarity
   between this pair is **0.9394** — comfortably above 0.87. Expect
   `cache.kind = "semantic"`, `cache.hit = true`, `cache.similarity` around
   0.94, and `timings_ms.generate = 0` since the cached answer is replayed
   instead of calling the LLM again. This is the pair to demo when you want
   to show the cache working correctly.

9. **"Can I work from home?"**
   Answered from Section 4 (confirmed employees may work remotely up to 2
   days/week). First ask is a **miss**.

10. **"What is the remote work policy?"**
    Same question as #9 to a human reader — but measured similarity is only
    **0.7292**, below the 0.87 bar. Expect this to come back as a **miss**
    too (`cache.kind = "miss"`), with `cache.nearest` reporting question #9
    and its 0.7292 score against the 0.87 threshold it didn't clear. This is
    the demo's honest limitation, not a bug: 0.87 is tuned to sit above every
    known false-positive pair, and this genuine paraphrase happens to score
    below it. A missed cache hit costs one extra API call; that's the
    tradeoff being made.

11. **"What is the expense limit for travel?"**
12. **"What is the expense limit for meals?"**
    These are lexically close but ask about different limits (Section 5:
    per-diem, hotel caps, and international travel rules are all distinct
    numbers). Measured similarity is **0.8605** — this is *why* the
    threshold sits at 0.87 and not lower. Try lowering
    `SEMANTIC_CACHE_THRESHOLD` below `0.86` (see the README's "Things to
    try") and re-run #11 then #12: you should see #12 incorrectly served
    #11's cached answer — a wrong number delivered with full confidence.
    That's the failure mode the 0.87 default exists to prevent.

## Notes for demoing the cache

- Ask #7 verbatim a second time (identical string) first if you want to also
  show an **exact** hit (`cache.kind = "exact"`, `similarity = 1.0`) before
  showing the semantic one with #8.
- `DELETE /api/cache` (or the "clear cache" control in the UI) resets this, so
  you can re-run the demo without restarting anything.
- If #8 comes back as a `miss` instead of `semantic`, something has changed
  in the embedding model or `EMBED_DIM` since these numbers were measured —
  re-run `cd backend && uv run python calibrate_cache.py` to get current
  scores and, if needed, a new threshold.
