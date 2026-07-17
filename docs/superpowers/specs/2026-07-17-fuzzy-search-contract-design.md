# Fuzzy Search Contract Design

## Objective

Define the expected behavior for two fuzzy-search improvements before changing
the ranking implementation:

1. Common one-character typing mistakes should still find the intended job.
2. A job's score should not change merely because another job was added to the
   searchable collection.

The first implementation step is test-only. It adds intentionally failing tests
to `tests/jobs.test.ts` and does not modify production search code.

## Current Behavior

The current matcher accepts exact query tokens and prefixes of candidate tokens.
It does not tolerate a missing, wrong, extra, or transposed character. For
example, `paymnt service prod` does not find `payment-service-prod`.

Candidate scoring also uses a collection-wide `hasExactOrPrefixMatch` flag. As
a result, `credit-card-payment-service-prod` scores 44 for the query
`payment service prod` when it is alone, but scores 20 when
`payment-service-prod` is added. Preferring the exact job is correct; changing
the other candidate's intrinsic score is unnecessary and makes ranking harder
to reason about.

## Considered Approaches

### Token-level one-edit tolerance

Compare each query token with candidate tokens and allow at most one insertion,
deletion, substitution, or adjacent-character transposition for tokens that are
at least four characters long. Continue requiring every query token to match a
distinct candidate token.

This is the recommended approach. It handles normal typing mistakes while
preserving the current all-token specificity rule and avoiding aggressive fuzzy
matches for short terms such as `api`, `qa`, and `ui`.

### Whole-name edit distance

Compare the normalized complete query with the normalized complete job name.
This is simpler conceptually, but it conflicts with the existing support for
different token order and partial natural-language queries.

### General-purpose fuzzy-search dependency

Adopt a library that combines edit distance, token scoring, and ranking. This
offers more features but makes the current carefully tested specificity rules
harder to preserve and tune. It is unnecessary for the initial contract.

## Approved Matching Contract

Given the job `payment-service-prod`, all of these queries must produce that job
as a valid result at or above `MIN_SCORE`:

- deletion: `paymnt service prod`;
- substitution: `paymant service prod`;
- insertion: `paymentt service prod`;
- adjacent transposition: `payemnt service prod`.

The contract is deliberately conservative:

- fuzzy edit matching applies only to query tokens of at least four characters;
- at most one edit is allowed per query token;
- every query token must match a distinct candidate token;
- exact and prefix matches continue to score higher than typo matches;
- unrelated words must remain below `MIN_SCORE`.

## Approved Score-Stability Contract

For a fixed query and candidate, that candidate's score must be independent of
other jobs in the collection.

For query `payment service prod`:

1. Rank `credit-card-payment-service-prod` by itself and record its score.
2. Rank the same candidate together with `payment-service-prod`.
3. Assert that `credit-card-payment-service-prod` has the same score in both
   results.
4. Assert that the exact `payment-service-prod` result still ranks first.

This separates two concerns: candidate-local scoring measures how well one job
matches the query, while result ordering ensures that an exact match wins.

## Test-First Change

Add focused cases to `tests/jobs.test.ts` for:

- one test for each supported one-edit typo type;
- a negative case proving unrelated words do not become valid matches;
- a short-token case proving that permissive typo matching is not applied to
  short query tokens;
- a score-stability case using the same candidate with and without an exact
  competitor;
- an ordering assertion proving the exact competitor still wins.

The tests should exercise the public `rankJobs` function and use `MIN_SCORE`,
matching the existing suite's style. No production implementation or threshold
tuning belongs in this first change. The expected result of the focused test run
is that existing tests pass and the new contract tests fail for the missing
behavior.

## Later Implementation Direction

After the failing tests are reviewed, implement bounded token-level edit
matching inside candidate scoring and remove the collection-wide scoring flag.
Exact-match preference should remain visible as ordering or selection policy,
not as a mutation of other candidates' scores.
