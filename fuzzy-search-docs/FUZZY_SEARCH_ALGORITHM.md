# Fuzzy Search Algorithm Documentation

This document explains the custom fuzzy search algorithm used for matching Jenkins job names.

## Overview

The algorithm uses a multi-tier scoring system that prioritizes exact matches, then prefix matches, then substring matches, and finally token-based weighted matches. It also identifies common/trivial tokens dynamically and weights them lower.

## Scoring Hierarchy

Scores range from 0 to 100, with higher scores indicating better matches:

| Match Type          | Score | Description                                      |
| ------------------- | ----- | ------------------------------------------------ |
| **Exact Match**     | 100   | Query exactly equals the job name                |
| **Prefix Match**    | 80    | Job name starts with the query                   |
| **Substring Match** | 60    | Job name contains the query                      |
| **Token Match**     | 0-40  | Based on overlapping tokens (weighted by rarity) |

### Token Presence Requirement

Before any scoring happens, **all query tokens must be present** in the job name
as full tokens or token prefixes. If a query token is completely absent, the
candidate is rejected (score 0), even if other tokens match.

This ensures explicit tokens like `staging`, `prod`, or `engine` are always
respected.

### 1. Exact Match (Score: 100)

**When:** The normalized query exactly equals the normalized job name.

**Example:**

```
Query: "payment-service-prod"
Job: "payment-service-prod"
Score: 100 ✓
```

### 2. Prefix Match (Score: 80)

**When:** The job name starts with the query.

**Example:**

```
Query: "payment-service"
Job: "payment-service-prod"
Score: 80 ✓

Query: "payment-service"
Job: "payment-service-staging"
Score: 80 ✓
```

### 3. Substring Match (Score: 60 with penalties)

**When:** The job name contains the query somewhere in the middle.

**Base Score:** 60

**Penalties:**

- If job has more tokens than query, apply penalties based on extra tokens
- **With exact/prefix match available:** -20 points per extra token
- **Without better match:** -8 points per extra token (minimum 25)
- **Single-token queries:** penalties are reduced (strict: -10, lenient: -4)

**Examples:**

**Scenario A: Exact match exists**

```
Query: "payment-service-prod" (3 tokens)
Job A: "payment-service-prod" → Score: 100 (exact) ✓
Job B: "credit-card-payment-service-prod" (5 tokens)
  - Contains query as substring ✓
  - Extra tokens: 5 - 3 = 2
  - Penalty: 2 × 20 = 40
  - Score: 60 - 40 = 20 ✗ (below MIN_SCORE of 30)
```

**Scenario B: No exact match exists**

```
Query: "analytics ml" (2 tokens)
Job: "data-analytics-ml-pipeline-prod" (5 tokens)
  - Contains "analytics ml" as substring ✓
  - Extra tokens: 5 - 2 = 3
  - Penalty: 3 × 8 = 24
  - Score: 60 - 24 = 36 ✓
```

### 4. Token Match (Score: 0-40)

**When:** Individual tokens from the query appear in the job name.

**Algorithm:**

1. Analyze all jobs to find token frequencies
2. Weight each query token: `weight = 1.1 - frequency`
   - Rare tokens: weight ≈ 1.0 (full contribution)
   - Common tokens: weight ≈ 0.1 (minimal contribution)
3. Calculate weighted overlap ratio
4. Score = ratio × 40

**Example:**

```
Jobs in system:
- user-service-prod
- payment-service-prod
- order-service-staging
- api-gateway-deploy
- frontend-webapp-staging
- notification-service-staging
- database-migration-deploy
- docker-image-build

Token frequencies:
- "service": 4/8 = 50% (trivial, weight = 0.6)
- "prod": 2/8 = 25% (weight = 0.85)
- "staging": 3/8 = 37.5% (trivial, weight = 0.725)
- "deploy": 2/8 = 25% (weight = 0.85)
- "user": 1/8 = 12.5% (weight = 0.975)
- "payment": 1/8 = 12.5% (weight = 0.975)

Query: "service user" (2 tokens)
Job: "user-service-prod"

Token matching:
- "service": match ✓, weight = 0.6
- "user": match ✓, weight = 0.975
- Total weight: 0.975 + 0.6 = 1.575
- Weighted overlap: 0.975 + 0.6 = 1.575
- Ratio: 1.575 / 1.575 = 1.0
- Score: 1.0 × 40 = 40 ✓

Job: "payment-service-prod"
- "user": no match ✗
- "service": match ✓, weight = 0.6
- Total weight: 1.575
- Weighted overlap: 0.6
- Ratio: 0.6 / 1.575 = 0.38
- Score: 0.38 × 40 = 15 ✗ (below MIN_SCORE)
```

## Special Features

### Dynamic Trivial Token Detection

Instead of hardcoding common words, the algorithm analyzes the job list and weights high-frequency tokens lower (often the ones appearing in roughly a third of jobs or more).

**Example:**

```
If most jobs are "*-service-*", then "service" becomes trivial and contributes less to matching.
```

### Length-Based Sorting

When scores are equal, shorter job names are preferred:

```
Query: "payment-service-prod"
Results:
1. payment-service-prod (length: 20, score: 100)
2. credit-card-payment-service-prod (length: 32, score: 20)
```

### Smart Substring Penalties

The algorithm distinguishes between:

- **Strict mode:** When an exact/prefix match exists, substring matches with extra tokens are heavily penalized
- **Lenient mode:** When no better match exists, substring matches are allowed with lighter penalties

This ensures:

- "payment-service" query returns only payment-service-\* jobs when they exist
- But "analytics ml" can still match "data-analytics-ml-pipeline-prod" when no exact match exists

## Complete Examples

### Example 1: Simple Service Query

```
Jobs:
- user-service-prod
- payment-service-prod
- order-service-staging
- notification-service-deploy

Query: "payment service"

Scoring:
1. payment-service-prod:
   - Prefix match ("payment service" is the start of the job name)
   - Score: 80 ✓

2. user-service-prod:
   - Token match: only "service" matches
   - In this 4-job set, service appears in 4/4 → weight = 0.10
   - Total query weight: payment (0.85) + service (0.10) = 0.95
   - Score: (0.10 / 0.95) × 40 ≈ 4 ✗

3. order-service-staging:
   - Same as above: Score ≈ 4 ✗

4. notification-service-deploy:
   - Same as above: Score ≈ 4 ✗

Results:
1. payment-service-prod (Score: 80) ✓
```

### Example 2: Nested Services

```
Jobs:
- payment-service-prod
- credit-card-payment-service-prod
- debit-card-payment-service-prod
- wire-transfer-payment-service-prod

Query: "payment-service-prod" (3 tokens)

Scoring:
1. payment-service-prod:
   - Exact match: Score 100 ✓

2. credit-card-payment-service-prod (5 tokens):
   - Contains "payment-service-prod" as substring ✓
   - But exact match exists → strict penalty mode
   - Extra tokens: 5 - 3 = 2
   - Penalty: 2 × 20 = 40
   - Score: 60 - 40 = 20 ✗ (below MIN_SCORE of 30)

3. debit-card-payment-service-prod (5 tokens):
   - Same as above: Score 20 ✗

4. wire-transfer-payment-service-prod (5 tokens):
   - Same as above: Score 20 ✗

Results:
1. payment-service-prod (Score: 100) ✓
```

### Example 3: Partial Match on Long Job

```
Jobs:
- data-analytics-ml-pipeline-prod
- api-gateway-deploy
- frontend-webapp-staging

Query: "analytics ml" (2 tokens)

Scoring:
1. data-analytics-ml-pipeline-prod (5 tokens):
   - Contains "analytics ml" as substring ✓
   - No exact/prefix match exists → lenient mode
   - Extra tokens: 5 - 2 = 3
   - Penalty: 3 × 8 = 24
   - Score: 60 - 24 = 36 ✓

2. api-gateway-deploy:
   - No token matches
   - Score: 0 ✗

3. frontend-webapp-staging:
   - No token matches
   - Score: 0 ✗

Results:
1. data-analytics-ml-pipeline-prod (Score: 36) ✓
```

## Configuration

The algorithm uses these configurable parameters:

- **MIN_SCORE** (default: 30): Minimum score for a match to be considered valid
- **AMBIGUITY_GAP** (default: 8): Score gap for determining ambiguous matches
- **MAX_OPTIONS** (default: 10): Maximum options to show when ambiguous

## Why Custom Implementation?

This custom implementation was chosen over libraries like Fuse.js because:

1. **Domain-specific scoring:** Understands Jenkins job naming patterns (service-_ vs credit-card-service-_)
2. **Token awareness:** Weights common tokens lower dynamically
3. **Specificity preference:** Shorter matches rank higher when scores are equal
4. **Nested service handling:** Distinguishes between base services and nested variants
5. **No dependencies:** Self-contained, easy to maintain
