# Trivial Tokens and Weighted Scoring Simulation

This document shows how the algorithm identifies and penalizes common/trivial tokens.

## What Are Trivial Tokens?

Trivial tokens are words that appear in **more than 30% of all jobs**. These are typically:

- Common infrastructure words ("service", "deploy", "staging", "prod")
- Environment indicators
- Action verbs ("build", "test", "deploy")

These tokens get **lower weights** in scoring because they're less discriminative.

---

## Example Job System

Let's analyze this set of 10 jobs:

```
1. user-service-prod
2. user-service-staging
3. payment-service-prod
4. payment-service-staging
5. order-service-deploy
6. order-service-staging
7. api-gateway-deploy
8. api-gateway-staging
9. notification-service-prod
10. frontend-webapp-staging
```

## Step 1: Calculate Token Frequencies

The algorithm extracts all unique tokens from each job and counts occurrences:

```
Token Analysis:
═══════════════════════════════════════════════════════════════

Token          | Jobs Found In                    | Count | Frequency | Status
---------------|----------------------------------|-------|-----------|----------
service        | 1,2,3,4,5,6,9                    | 7     | 70.0%     | TRIVIAL ✗
staging        | 2,4,6,8,10                       | 5     | 50.0%     | TRIVIAL ✗
prod           | 1,3,9                            | 3     | 30.0%     | Normal ✓
deploy         | 5,7                              | 2     | 20.0%     | Normal ✓
user           | 1,2                              | 2     | 20.0%     | Normal ✓
payment        | 3,4                              | 2     | 20.0%     | Normal ✓
order          | 5,6                              | 2     | 20.0%     | Normal ✓
api            | 7,8                              | 2     | 20.0%     | Normal ✓
gateway        | 7,8                              | 2     | 20.0%     | Normal ✓
notification   | 9                                | 1     | 10.0%     | Normal ✓
frontend       | 10                               | 1     | 10.0%     | Normal ✓
webapp         | 10                               | 1     | 10.0%     | Normal ✓

═══════════════════════════════════════════════════════════════
Threshold: 30% (tokens above this are marked trivial)
Trivial tokens: ["service", "staging"]
```

## Step 2: Calculate Token Weights

Weight formula: `weight = 1.1 - frequency`

```
Token Weight Calculation:
═══════════════════════════════════════════════════════════════

Trivial Tokens (>30% frequency):
- "service" (70%):  weight = 1.1 - 0.70 = 0.40
- "staging" (50%):  weight = 1.1 - 0.50 = 0.60

Normal Tokens (≤30% frequency):
- "prod" (30%):     weight = 1.1 - 0.30 = 0.80
- "deploy" (20%):   weight = 1.1 - 0.20 = 0.90
- "user" (20%):     weight = 1.1 - 0.20 = 0.90
- "payment" (20%):  weight = 1.1 - 0.20 = 0.90
- "order" (20%):    weight = 1.1 - 0.20 = 0.90
- "api" (20%):      weight = 1.1 - 0.20 = 0.90
- "gateway" (20%):  weight = 1.1 - 0.20 = 0.90
- "notification" (10%): weight = 1.1 - 0.10 = 1.00
- "frontend" (10%): weight = 1.1 - 0.10 = 1.00
- "webapp" (10%):  weight = 1.1 - 0.10 = 1.00

═══════════════════════════════════════════════════════════════
```

---

## Scenario 1: Query with Trivial Tokens Only

**Query:** `service prod`

### Step-by-Step Scoring

**Job: payment-service-prod**

1. **Tokenize**

   ```
   Query tokens: ["service", "prod"]
   Job tokens: ["payment", "service", "prod"]
   ```

2. **Calculate Weights**

   ```
   Query token weights:
   - "service": 0.40 (trivial, 70% frequency)
   - "prod": 0.80 (normal, 30% frequency)

   Total query weight: 0.40 + 0.80 = 1.20
   ```

3. **Find Matches**

   ```
   - "service": found in job ✓
   - "prod": found in job ✓

   Weighted overlap: 0.40 + 0.80 = 1.20
   ```

4. **Calculate Score**
   ```
   Match ratio: 1.20 / 1.20 = 1.00 (100%)
   Score: 1.00 × 40 = 40
   ```

**Result:** Score 40 (even with a trivial token, full overlap gives max token score)

---

## Scenario 2: Query with Mix of Trivial and Normal Tokens

**Query:** `payment service`

### Comparison: Same Query, Different Jobs

**Job A: payment-service-prod** ✓ (intended match)

```
Query tokens: ["payment", "service"]
Weights: payment=0.90, service=0.40
Total weight: 1.30

Matches:
- "payment": found ✓ (weight 0.90)
- "service": found ✓ (weight 0.40)

Weighted overlap: 0.90 + 0.40 = 1.30
Match ratio: 1.30 / 1.30 = 1.00
Score: 1.00 × 40 = 40 ✓
```

**Job B: order-service-staging** ✗ (should not match well)

```
Query tokens: ["payment", "service"]
Weights: payment=0.90, service=0.40
Total weight: 1.30

Matches:
- "payment": NOT found ✗
- "service": found ✓ (weight 0.40)

Weighted overlap: 0.40
Match ratio: 0.40 / 1.30 = 0.31
Score: 0.31 × 40 = 12 ✗ (below MIN_SCORE of 30)
```

**Key Difference:**

- Job A matches the **rare** token "payment" (weight 0.90)
- Job B only matches the **trivial** token "service" (weight 0.40)
- Score difference: 40 vs 12 (over 3x)

---

## Scenario 3: Why Trivial Token Penalty Matters

**System with Trivial Token Penalty (Our Algorithm):**

```
Query: "service staging"

Job A: user-service-staging
- Both tokens trivial (service=0.40, staging=0.60)
- Total weight: 1.00
- Both match: 1.00
- Score: (1.00/1.00) × 40 = 40 ✓

Job B: payment-service-staging
- Same as Job A
- Score: 40 ✓

Job C: api-gateway-staging
- Only "staging" matches (0.60)
- Total query weight: 1.00
- Score: (0.60/1.00) × 40 = 24 ✗

Result: Only service jobs match, gateway job filtered out
```

**Hypothetical System WITHOUT Trivial Token Penalty:**

```
Query: "service staging"

Job A: user-service-staging
- Both tokens equal weight (1.0 each)
- Score: 40 ✓

Job B: api-gateway-staging
- "staging" matches (weight 1.0)
- 50% match ratio
- Score: 20 ✗

Better example (gap widens):

Query: "user service"

With penalty:
- Job: user-service-prod (matches both tokens)
  - Weights: user=0.90, service=0.40
  - Total: 1.30
  - Score: 40 ✓
- Job: payment-service-prod (matches only "service")
  - Ratio: 0.40 / 1.30 = 31%
  - Score: 12 ✗

Without penalty (all tokens weight 1.0):
- Job: user-service-prod
  - Score: 40 ✓
- Job: payment-service-prod
  - 50% match (1/2 tokens)
  - Score: 20 ✗

Difference: gap grows from 20 points to 28 points.
```

---

## Scenario 4: The Real Impact - Distinguishing Similar Jobs

**Query:** `user service staging`

**System:**

```
Job A: user-service-staging
Job B: user-service-prod
Job C: payment-service-staging
```

### With Trivial Token Weights:

**Job A: user-service-staging** (all 3 tokens match)

```
Tokens: ["user", "service", "staging"]
Weights: user=0.90, service=0.40, staging=0.60
Total: 1.90

All match: 1.90
Ratio: 1.90/1.90 = 1.00
Score: 40 ✓
```

**Job B: user-service-prod** ("staging" doesn't match)

```
Tokens: ["user", "service", "prod"]
Query weights: user=0.90, service=0.40, staging=0.60

Matches:
- "user": ✓ (0.90)
- "service": ✓ (0.40)
- "staging": ✗ (0)

Weighted overlap: 1.30
Ratio: 1.30/1.90 = 0.68
Score: 27 ✗ (below MIN_SCORE of 30!)
```

**Job C: payment-service-staging** ("user" doesn't match)

```
Tokens: ["payment", "service", "staging"]
Query weights: user=0.90, service=0.40, staging=0.60

Matches:
- "user": ✗
- "service": ✓ (0.40)
- "staging": ✓ (0.60)

Weighted overlap: 1.00
Ratio: 1.00/1.90 = 0.53
Score: 21 ✗ (below MIN_SCORE)
```

**Results:**

- Job A: 40 ✓ (perfect match)
- Job B: 27 ✗ (filtered out - wrong environment)
- Job C: 21 ✗ (filtered out - wrong service)

### Without Trivial Token Weights (all tokens = 1.0):

**Job A: user-service-staging**

```
All 3 match: 3/3 = 100%
Score: 40 ✓
```

**Job B: user-service-prod**

```
2/3 match: 67%
Score: 27 ✗ (still below, but closer)
```

**Job C: payment-service-staging**

```
2/3 match: 67%
Score: 27 ✗ (still below, but closer)
```

**Difference:** With weights, the wrong service drops further (40 vs 27 vs 21), making the correct match more dominant.

---

## Scenario 5: Extreme Case - Many Trivial Tokens

**Query:** `service staging` (both highly trivial)

**System:**

```
1. user-service-staging
2. payment-service-staging
3. order-service-staging
4. api-gateway-staging
5. frontend-webapp-staging
6. notification-service-prod
7. database-migration-deploy
```

### Scoring:

**Job 1-3: user/payment/order-service-staging**

```
Both tokens match
service=0.53, staging=0.39
Weighted overlap: 0.92 / 0.92 = 100%
Score: 40 ✓
```

**Job 4: api-gateway-staging**

```
Only "staging" matches
staging=0.39
Weighted overlap: 0.39 / 0.92 = 42%
Score: 17 ✗
```

**Job 5: frontend-webapp-staging**

```
Only "staging" matches
Score: 17 ✗
```

**Job 6: notification-service-prod**

```
Only "service" matches
service=0.53
Weighted overlap: 0.53 / 0.92 = 58%
Score: 23 ✗
```

**Job 7: database-migration-deploy**

```
No matches
Score: 0 ✗
```

**Results:**

- Good matches: 3 jobs (all \*-service-staging)
- Filtered out: 4 jobs

If we had used equal weights (no trivial penalty):

- Jobs 4 & 5 would score 50% × 40 = 20 (still below 30)
- Job 6 would score 50% × 40 = 20 (still below 30)

So in this case, trivial weights don't change which jobs pass, but they make the scores more spread out (better ranking).

---

## Scenario 6: When Trivial Token Penalty Helps Most

**Query:** `payment service` (both common in this system)

**System:**

```
1. payment-service-prod
2. payment-service-staging
3. payment-gateway-prod
4. wire-transfer-payment-service-prod
```

### With Trivial Token Weights:

**Job 1: payment-service-prod**

```
Tokens: ["payment", "service"]
Weights: payment=0.10, service=0.35
Total: 0.45

Both match: 0.45
Score: 40 ✓
```

**Job 2: payment-service-staging**

```
Both match: 0.45
Score: 40 ✓
```

**Job 3: payment-gateway-prod**

```
Tokens: ["payment", "gateway", "prod"]
Query: ["payment", "service"]

Matches:
- payment: ✓ (0.10)
- service: ✗

Weighted overlap: 0.10
Ratio: 0.10 / 0.45 = 22%
Score: 9 ✗ (below threshold)
```

**Job 4: wire-transfer-payment-service-prod**

```
Tokens: ["wire", "transfer", "payment", "service", "prod"]
Query: ["payment", "service"]

Matches:
- payment: ✓ (0.10)
- service: ✓ (0.35)

Weighted overlap: 0.45
Ratio: 0.45 / 0.45 = 100%
Score: 40 ✓
```

**Results:**

- Good matches: Jobs 1, 2, 4 (all have both tokens)
- Job 3 filtered out (only has "payment")

But wait - Job 4 is a nested service and we probably don't want it...
This shows the limitation of token matching vs substring matching with penalties.

---

## Summary: Impact of Trivial Token Weighting

### Benefits:

1. **Better discrimination:** Rare tokens (like "payment", "user", "order") contribute more to matching
2. **Natural filtering:** Common words ("service", "staging", "prod") contribute less
3. **No hardcoded list:** Trivial tokens detected automatically from your job names
4. **Adaptive:** If you add many "_-api-_" jobs, "api" becomes trivial automatically

### When It Matters Most:

- **Short queries** (2-3 tokens) where trivial tokens would otherwise dominate
- **Distinguishing similar jobs** (user-service vs payment-service)
- **Ranking results** when multiple jobs have the same score

### When It Doesn't Matter:

- **Exact matches** (score 100 regardless of token weights)
- **Long queries** with many specific tokens
- **Systems with diverse job names** (no dominant trivial tokens)

## Formula Recap

```
1. Token Frequency = (jobs containing token) / (total jobs)
2. Token Weight = 1.1 - Frequency
3. Weighted Overlap = Σ(weight of each matching query token)
4. Total Query Weight = Σ(weight of all query tokens)
5. Match Ratio = Weighted Overlap / Total Query Weight
6. Final Score = Match Ratio × 40

If all query tokens match → Ratio = 1.0 → Score = 40
If no query tokens match → Ratio = 0 → Score = 0
If half (by weight) match → Ratio = 0.5 → Score = 20
```

## Real-World Impact

In a typical Jenkins setup with microservices:

**Without trivial token weights:**

- Query: "service prod"
- Result: 15+ jobs match (any job with both words)
- User can't find specific service

**With trivial token weights:**

- Query: "user service prod"
- "user" (rare) gets weight 0.90
- "service" (common) gets weight 0.50
- "prod" (common) gets weight 0.80
- Only jobs with the rare "user" token score highly
- Result: 3 jobs (user-service-prod, user-service-staging if staging not in query)
- Much more focused results!
