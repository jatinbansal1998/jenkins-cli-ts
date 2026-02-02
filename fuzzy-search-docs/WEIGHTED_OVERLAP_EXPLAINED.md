# How Weighted Overlap Works

## The Problem with Simple Token Matching

If we just count matching tokens equally:

```
Query: "payment service"
Job A: payment-service-prod (matches both)
Job B: order-service-staging (matches only "service")

Simple scoring:
- Job A: 2/2 = 100% → Score 40 ✓
- Job B: 1/2 = 50% → Score 20 ✗

This works okay, but...
```

**The problem:** "service" appears in 80% of jobs (very common), while "payment" appears in only 5% (very specific).

Should a match on "service" (common) be worth the same as "payment" (rare)? **No!**

---

## Weighted Overlap Solution

### Step 1: Calculate Token Weights

Weight formula: `weight = 1.1 - frequency`

```
Token          | Frequency | Weight Calculation | Weight
---------------|-----------|-------------------|-------
payment        | 5%        | 1.1 - 0.05       | 1.05
order          | 5%        | 1.1 - 0.05       | 1.05
user           | 5%        | 1.1 - 0.05       | 1.05
service        | 80%       | 1.1 - 0.80       | 0.30
staging        | 60%       | 1.1 - 0.60       | 0.50
prod           | 50%       | 1.1 - 0.50       | 0.60
deploy         | 30%       | 1.1 - 0.30       | 0.80

Why 1.1? To ensure even 100% frequency tokens have weight > 0.
```

### Step 2: Calculate Query's Total Weight

Sum up weights of all query tokens:

```
Query: "payment service"
Tokens: ["payment", "service"]
Weights: 1.05 + 0.30 = 1.35
totalWeight = 1.35
```

### Step 3: Calculate Weighted Overlap

Sum weights of **only the matching tokens**:

**Job A: payment-service-prod**

```
Query tokens:     ["payment", "service"]
Job A tokens:     ["payment", "service", "prod"]

Matching:
- "payment": found ✓ → add 1.05
- "service": found ✓ → add 0.30

weightedOverlap = 1.05 + 0.30 = 1.35
```

**Job B: order-service-staging**

```
Query tokens:     ["payment", "service"]
Job B tokens:     ["order", "service", "staging"]

Matching:
- "payment": NOT found ✗ → add 0
- "service": found ✓ → add 0.30

weightedOverlap = 0 + 0.30 = 0.30
```

### Step 4: Calculate Weighted Ratio

```
weightedRatio = weightedOverlap / totalWeight

Job A: 1.35 / 1.35 = 1.00 (100%)
Job B: 0.30 / 1.35 = 0.22 (22%)
```

### Step 5: Convert to Score (0-40 scale)

```
score = weightedRatio × 40

Job A: 1.00 × 40 = 40 ✓
Job B: 0.22 × 40 = 8.8 → round to 9 ✗
```

---

## Visual Comparison

### Without Weights (Simple Counting)

```
Query: "payment service"
              ↓        ↓
Job A:   payment-service-prod
         ✓      ✓
         Match: 2/2 = 100% → Score 40 ✓

Job B:   order-service-staging
         ✗      ✓
         Match: 1/2 = 50% → Score 20 ✗

Difference: 40 vs 20 (2x gap)
```

### With Weights (Weighted Overlap)

```
Query: "payment service"
       (1.05)  (0.30)
       ↓       ↓
Job A: payment-service-prod
       ✓       ✓
       (1.05)  (0.30)

       Overlap: 1.35
       Total: 1.35
       Ratio: 100%
       Score: 40 ✓

Job B: order-service-staging
       ✗       ✓
       (0)     (0.30)

       Overlap: 0.30
       Total: 1.35
       Ratio: 22%
       Score: 9 ✗

Difference: 40 vs 9 (4.4x gap)
```

**Result:** The weighted system creates a much bigger gap between correct and incorrect matches!

---

## Real Example from Our Code

```typescript
const candidateTokens = new Set(candidate.split(" "));

let weightedOverlap = 0;
let totalWeight = 0;

for (const queryToken of queryTokens) {
  const frequency = tokenFrequencies?.get(queryToken) ?? 0.5;
  // Weight = inverse of frequency (rare tokens get higher weight)
  const weight = 1.1 - frequency;
  totalWeight += weight;

  if (candidateTokens.has(queryToken)) {
    weightedOverlap += weight;
  }
}

const weightedRatio = weightedOverlap / totalWeight;
return Math.round(weightedRatio * 40);
```

### Walk Through with Real Data

**System:** 10 jobs

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

**Token frequencies calculated:**

```
service:  7/10 = 70% → weight = 0.40
staging:  5/10 = 50% → weight = 0.60
prod:     3/10 = 30% → weight = 0.80
deploy:   2/10 = 20% → weight = 0.90
user:     2/10 = 20% → weight = 0.90
payment:  2/10 = 20% → weight = 0.90
order:    2/10 = 20% → weight = 0.90
api:      2/10 = 20% → weight = 0.90
gateway:  2/10 = 20% → weight = 0.90
frontend: 1/10 = 10% → weight = 1.00
webapp:   1/10 = 10% → weight = 1.00
notification: 1/10 = 10% → weight = 1.00
```

**Query:** "payment service staging"

**Step 1: Calculate Total Query Weight**

```
tokens: ["payment", "service", "staging"]
weights: [0.90, 0.40, 0.60]
totalWeight = 0.90 + 0.40 + 0.60 = 1.90
```

**Step 2: Score Each Job**

**Job 1: user-service-staging**

```
Matches: "service" ✓, "staging" ✓, "payment" ✗
weightedOverlap = 0.40 + 0.60 + 0 = 1.00
weightedRatio = 1.00 / 1.90 = 53%
score = 53% × 40 = 21.05 → 21 ✗
```

**Job 3: payment-service-staging** ✓

```
Matches: "payment" ✓, "service" ✓, "staging" ✓
weightedOverlap = 0.90 + 0.40 + 0.60 = 1.90
weightedRatio = 1.90 / 1.90 = 100%
score = 100% × 40 = 40 ✓
```

**Job 5: order-service-deploy**

```
Matches: "service" ✓, "deploy" ?, "payment" ✗, "staging" ✗
Wait, "deploy" not in query!
Matches: "service" ✓
weightedOverlap = 0.40
weightedRatio = 0.40 / 1.90 = 21.1%
score = 21.1% × 40 = 8.42 → 8 ✗
```

**Job 7: api-gateway-deploy**

```
Matches: none
weightedOverlap = 0
score = 0 ✗
```

---

## Why This Matters

### Scenario: Many Similar Jobs

**System:** 20 jobs, all `*-service-*`

**Query:** "user service"

**Without weights:**

```
Job: user-service-prod
Match: "user" ✓, "service" ✓
Score: 2/2 × 40 = 40 ✓

Job: payment-service-staging
Match: "service" ✓
Score: 1/2 × 40 = 20 ✗

Problem: 20 is close to threshold, many false positives!
```

**With weights:**

```
"service" weight: 0.10 (appears in all 20 jobs = 100%)
"user" weight: 1.00 (appears in 2 jobs = 10%)

Job: user-service-prod
Overlap: 1.00 + 0.10 = 1.10
Total: 1.10
Score: 40 ✓

Job: payment-service-staging
Overlap: 0 + 0.10 = 0.10
Total: 1.10
Score: (0.10/1.10) × 40 = 4 ✗

Benefit: Gap is now 40 vs 4 (10x instead of 2x)!
Fewer false positives!
```

---

## Summary Formula

```
┌─────────────────────────────────────────────┐
│  1. For each query token:                   │
│     - Get its frequency in all jobs         │
│     - Calculate weight = 1.1 - frequency    │
│                                             │
│  2. totalWeight = sum of all token weights  │
│                                             │
│  3. For each job:                           │
│     - Check which query tokens exist        │
│     - weightedOverlap = sum of weights      │
│       of matching tokens only               │
│                                             │
│  4. weightedRatio = weightedOverlap /       │
│                     totalWeight             │
│                                             │
│  5. finalScore = weightedRatio × 40         │
└─────────────────────────────────────────────┘
```

**Key Insight:** We're not counting matches equally. We're saying:

- "If you match the rare/specific tokens, that's worth a lot"
- "If you only match the common/trivial tokens, that's worth less"

This makes the algorithm much better at finding the **specific** job you want!
