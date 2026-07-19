# Fuzzy Job Search

Jenkins job search ranks the query against both `name` and `fullName`, keeping
the better score. The implementation lives in `src/jobs.ts`; scoring constants
and result thresholds live in `src/config/fuzzy.ts`.

## Normalization

Queries and candidate names are lowercased, non-alphanumeric runs become
spaces, repeated whitespace is collapsed, and leading/trailing whitespace is
removed. This makes separators such as `/`, `_`, and `-` equivalent for
matching.

## Token eligibility

Before a candidate receives a score, every query token must map to a distinct
candidate token. A token pair can match in three ways:

| Match                                | Credit |
| ------------------------------------ | ------ |
| Exact token                          | `1.00` |
| Query is a prefix of candidate token | `0.85` |
| One-character typo                   | `0.75` |

Typo matching applies only to query tokens at least four characters long. It
accepts one insertion, deletion, substitution, or adjacent transposition. A
candidate token cannot satisfy two query tokens.

For example, `paymnt prod` can match `payment-service-prod`, while a candidate
without a token matching `prod` is rejected.

## Scoring

Eligible candidates are scored by the first matching tier:

1. Exact normalized name: `100`.
2. Normalized name starts with the query: `80`.
3. Normalized name contains the query: base `60`, reduced for extra candidate
   tokens. The penalty is 4 points per extra token for a one-token query and 8
   otherwise, with a floor of `25`.
4. Token match: average token credit multiplied by `40`, rounded to the nearest
   integer.

Only scores of at least `30` are returned. Results are ordered by descending
score, then shorter display name, then alphabetical display name. Matches
within 8 points of the best score are treated as ambiguous, with at most 10
options presented to the user.

Scores depend only on the query and candidate. Adding unrelated jobs to the
collection does not change an existing job's score.

## Maintenance

Treat the tests in `tests/jobs.test.ts` as the executable search contract. When
the algorithm changes, update those tests and this short description together;
avoid checking in long simulations that duplicate implementation details.
