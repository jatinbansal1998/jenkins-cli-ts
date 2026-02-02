# Step-by-Step Fuzzy Match Simulation

This document traces through exact algorithm execution for `data-analytics-ml-pipeline-prod`.

## Job Details

```
Job Name: data-analytics-ml-pipeline-prod
Tokens: ["data", "analytics", "ml", "pipeline", "prod"]
Token Count: 5
```

## Scenario 1: Exact Match

**Query:** `data-analytics-ml-pipeline-prod`

### Step-by-Step Execution:

1. **Normalize Query**

   ```
   Input: "data-analytics-ml-pipeline-prod"
   Output: "data analytics ml pipeline prod"
   ```

2. **Check Exact Match**

   ```
   Candidate: "data analytics ml pipeline prod"
   Query:     "data analytics ml pipeline prod"

   candidate === query?
   "data analytics ml pipeline prod" === "data analytics ml pipeline prod"
   → TRUE

   Return Score: 100
   ```

3. **Result**
   ```
   Score: 100 (Exact Match)
   Rank: #1
   ```

**Result:** Perfect match, score 100.

---

## Scenario 2: Prefix Match

**Query:** `data-analytics-ml`

### Step-by-Step Execution:

1. **Normalize Query**

   ```
   Input: "data-analytics-ml"
   Output: "data analytics ml"
   ```

2. **Check Exact Match**

   ```
   Candidate: "data analytics ml pipeline prod"
   Query:     "data analytics ml"

   candidate === query?
   "data analytics ml pipeline prod" === "data analytics ml"
   → FALSE (length differs)
   ```

3. **Check Prefix Match**

   ```
   candidate.startsWith(query)?
   "data analytics ml pipeline prod".startsWith("data analytics ml")
   → TRUE (starts at index 0)

   Return Score: 80
   ```

4. **Result**
   ```
   Score: 80 (Prefix Match)
   Rank: #1
   ```

**Result:** Job starts with query, score 80.

---

## Scenario 3: Substring Match with Penalty

**Query:** `analytics-ml-pipeline`

### Step-by-Step Execution:

1. **Normalize Query**

   ```
   Input: "analytics-ml-pipeline"
   Output: "analytics ml pipeline"
   Token Count: 3
   ```

2. **Check Exact Match**

   ```
   "data analytics ml pipeline prod" === "analytics ml pipeline"
   → FALSE
   ```

3. **Check Prefix Match**

   ```
   "data analytics ml pipeline prod".startsWith("analytics ml pipeline")
   → FALSE (starts with "data", not "analytics")
   ```

4. **Check Substring Match**

   ```
   candidate.includes(query)?
   "data analytics ml pipeline prod".includes("analytics ml pipeline")
   → TRUE (found at position after "data ")

   Calculate Penalty:
   - Query tokens: 3
   - Candidate tokens: 5
   - Extra tokens: 5 - 3 = 2
   - No exact/prefix match exists in the system for this query
   - Mode: LENIENT (lighter penalty)
   - Penalty: 2 × 8 = 16
   - Score: 60 - 16 = 44

   Return Score: 44
   ```

5. **Result**
   ```
   Score: 44 (Substring Match with Light Penalty)
   Rank: #1 (likely, depends on other jobs)
   ```

**Why it works:** Since no exact match exists for "analytics-ml-pipeline", we use lenient penalty mode, giving score 44 (above MIN_SCORE of 30).

---

## Scenario 4: Token Match (Partial Query)

**Query:** `analytics ml`

### Step-by-Step Execution:

1. **Normalize Query**

   ```
   Input: "analytics ml"
   Output: "analytics ml"
   Tokens: ["analytics", "ml"]
   ```

2. **Check Exact Match**

   ```
   "data analytics ml pipeline prod" === "analytics ml"
   → FALSE
   ```

3. **Check Prefix Match**

   ```
   "data analytics ml pipeline prod".startsWith("analytics ml")
   → FALSE (starts with "data")
   ```

4. **Check Substring Match**

   ```
   "data analytics ml pipeline prod".includes("analytics ml")
   → TRUE? Let's check...

   "data analytics ml pipeline prod"
        ↑ starts here

   Wait! The normalized query is "analytics ml" (without hyphens)
   The normalized candidate is "data analytics ml pipeline prod"

   Does "data analytics ml pipeline prod".includes("analytics ml")?
   → YES! "analytics ml" appears at position 5

   But wait - this is a substring match, so it should score 60 with penalties...

   Actually, let me re-check the code flow:
   The substring check happens BEFORE token matching.

   Query token count: 2
   Candidate token count: 5
   Extra tokens: 5 - 2 = 3
   Mode: LENIENT (no exact/prefix match for "analytics ml")
   Penalty: 3 × 8 = 24
   Score: 60 - 24 = 36

   Return Score: 36
   ```

5. **Actually, this becomes a substring match, not token match!**

   The string "analytics ml" is literally found within "data analytics ml pipeline prod", so it gets substring score with penalties.

6. **Result**
   ```
   Score: 36 (Substring Match)
   Above MIN_SCORE (30)? YES ✓
   ```

**Key Insight:** The query "analytics ml" appears as a contiguous substring in the job name, so it gets substring matching (score 36) rather than token matching. This is actually better than token matching would be!

---

## Scenario 5: True Token Match (Non-Contiguous)

**Query:** `ml prod`

### Step-by-Step Execution:

1. **Normalize Query**

   ```
   Input: "ml prod"
   Output: "ml prod"
   Tokens: ["ml", "prod"]
   ```

2. **Check Exact Match**

   ```
   "data analytics ml pipeline prod" === "ml prod"
   → FALSE
   ```

3. **Check Prefix Match**

   ```
   "data analytics ml pipeline prod".startsWith("ml prod")
   → FALSE (starts with "data")
   ```

4. **Check Substring Match**

   ```
   "data analytics ml pipeline prod".includes("ml prod")
   → FALSE ("ml" and "prod" are not adjacent)
   ```

5. **Token Match Calculation**

   First, analyze token frequencies in the job system:

   ```
   Let's say in a system of 25 jobs:
   - "ml": appears in 1 job (4%) → weight = 1.1 - 0.04 = 1.06
   - "prod": appears in 8 jobs (32%) → weight = 1.1 - 0.32 = 0.78
   - "data": appears in 2 jobs (8%) → weight = 1.1 - 0.08 = 1.02
   - "analytics": appears in 1 job (4%) → weight = 1.1 - 0.04 = 1.06
   - "pipeline": appears in 1 job (4%) → weight = 1.1 - 0.04 = 1.06
   ```

   Now calculate weighted overlap:

   ```
   Query tokens: ["ml", "prod"]
   Candidate tokens: ["data", "analytics", "ml", "pipeline", "prod"]

   Matches:
   - "ml": found in candidate ✓, weight = 1.06
   - "prod": found in candidate ✓, weight = 0.78

   Total weight: 1.06 + 0.78 = 1.84
   Weighted overlap: 1.06 + 0.78 = 1.84

   Weighted ratio: 1.84 / 1.84 = 1.0 (100%)
   Score: 1.0 × 40 = 40
   ```

6. **Result**
   ```
   Score: 40 (Token Match - 100% weighted overlap)
   Above MIN_SCORE (30)? YES ✓
   ```

**Why both tokens matched:**

- "ml" is a rare token (weight 1.06)
- "prod" is a common token (weight 0.78)
- Both found in the job
- 100% weighted overlap
- Score: 40

---

## Scenario 6: Partial Token Match

**Query:** `data pipeline`

### Step-by-Step Execution:

1. **Normalize Query**

   ```
   Input: "data pipeline"
   Output: "data pipeline"
   Tokens: ["data", "pipeline"]
   ```

2. **Check Exact Match** → FALSE

3. **Check Prefix Match** → FALSE

4. **Check Substring Match**

   ```
   "data analytics ml pipeline prod".includes("data pipeline")
   → FALSE (not contiguous)
   ```

5. **Token Match Calculation**

   ```
   Query tokens: ["data", "pipeline"]
   Candidate tokens: ["data", "analytics", "ml", "pipeline", "prod"]

   Token frequencies (example):
   - "data": 2/25 = 8% → weight = 1.02
   - "pipeline": 1/25 = 4% → weight = 1.06

   Matches:
   - "data": found ✓, weight = 1.02
   - "pipeline": found ✓, weight = 1.06

   Total weight: 1.02 + 1.06 = 2.08
   Weighted overlap: 1.02 + 1.06 = 2.08

   Ratio: 2.08 / 2.08 = 1.0 (100%)
   Score: 1.0 × 40 = 40
   ```

6. **Result**
   ```
   Score: 40 (Token Match)
   Above MIN_SCORE (30)? YES ✓
   ```

---

## Scenario 7: Single Token Match (Low Score)

**Query:** `pipeline`

### Step-by-Step Execution:

1. **Normalize Query**

   ```
   Input: "pipeline"
   Output: "pipeline"
   Tokens: ["pipeline"]
   ```

2. **Check Exact Match** → FALSE

3. **Check Prefix Match** → FALSE

4. **Check Substring Match**

   ```
   "data analytics ml pipeline prod".includes("pipeline")
   → TRUE

   Query token count: 1
   Candidate token count: 5
   Extra tokens: 5 - 1 = 4
   Mode: LENIENT (no exact/prefix match for "pipeline")
   Penalty: 4 × 8 = 32
   Score: 60 - 32 = 28

   But wait, 28 < MIN_SCORE (30), so this would fail...

   Actually, let's check: does it fail? Score 28 is below threshold.

   But hold on - there's also token matching path if substring fails...
   ```

5. **Alternative: Token Match**

   ```
   Since substring match score (28) is calculated but still returns a value,
   the job would be in results with score 28.

   However, the test filters: results.filter((r) => r.score >= MIN_SCORE)
   So jobs with score < 30 are excluded from "goodMatches".

   Token match calculation:
   - "pipeline": found ✓, weight = 1.06 (rare token)
   - Total weight: 1.06
   - Weighted overlap: 1.06
   - Ratio: 1.06 / 1.06 = 1.0
   - Score: 1.0 × 40 = 40

   Wait! The algorithm returns the BEST score from all checks.
   So it would take max(28, 40) = 40?

   Let me re-check the code flow...
   ```

6. **Code Flow Re-check**

   Looking at `scoreCandidate` function:

   ```typescript
   if (candidate === normalizedQuery) return 100;
   if (candidate.startsWith(normalizedQuery)) return 80;
   if (candidate.includes(normalizedQuery)) {
     // Calculate substring score with penalties
     return substringScore; // e.g., 28
   }
   // Only reaches here if no exact/prefix/substring match
   if (queryTokens.length === 0) return 0;
   // Calculate token match score
   return tokenMatchScore; // e.g., 40
   ```

   So the function returns early with substring score (28) and never reaches token matching!

   This means:
   - Score: 28
   - Below MIN_SCORE (30)? YES
   - Filtered out of goodMatches? YES

7. **Result**
   ```
   Score: 28 (Substring Match with Heavy Penalty)
   Above MIN_SCORE (30)? NO ✗
   Not included in goodMatches
   ```

**Lesson:** Single-word queries for long job names may fall below threshold due to substring penalties, even if token match would be good. This is intentional to avoid overly broad matches.

---

## Summary Table

| Query                             | Match Type | Score | Above Threshold? | Notes                 |
| --------------------------------- | ---------- | ----- | ---------------- | --------------------- |
| `data-analytics-ml-pipeline-prod` | Exact      | 100   | ✓                | Perfect match         |
| `data-analytics-ml`               | Prefix     | 80    | ✓                | Starts with query     |
| `analytics-ml-pipeline`           | Substring  | 44    | ✓                | Lenient penalty (-16) |
| `analytics ml`                    | Substring  | 36    | ✓                | Lenient penalty (-24) |
| `ml prod`                         | Token      | 40    | ✓                | 100% weighted overlap |
| `data pipeline`                   | Token      | 40    | ✓                | 100% weighted overlap |
| `pipeline`                        | Substring  | 28    | ✗                | Too many extra tokens |

## Key Insights

1. **Exact/Prefix are best:** Always try to type the beginning of the job name
2. **Substrings work:** Middle portions of job names match with penalties
3. **Lenient vs Strict mode:**
   - When no exact match exists: Lighter penalties, more results
   - When exact match exists: Heavier penalties, fewer results
4. **Token matching:** Non-contiguous word matching with rarity weighting
5. **Single-word queries:** May fail for long job names due to penalties

## Best Practices for Users

**To find `data-analytics-ml-pipeline-prod`:**

✅ **Good queries:**

- `data-analytics-ml-pipeline-prod` (exact, score 100)
- `data analytics ml` (prefix, score 80)
- `analytics ml pipeline` (substring, score 44)
- `ml prod` (token match, score 40)

❌ **Poor queries:**

- `pipeline` (too generic, score 28, filtered out)
- `prod` (single token; substring penalty on long names, score 28)
- `data` (single token; substring penalty on long names, score 28)
