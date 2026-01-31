import { describe, expect, test } from "bun:test";
import { rankJobs } from "../src/jobs";
import { MIN_SCORE } from "../src/config/fuzzy";
import type { JenkinsJob } from "../src/jenkins/client";

/** Helper to create job objects from names */
function createJob(name: string): JenkinsJob {
  return { name, url: `https://jenkins.example.com/job/${name}` };
}

const jobs: JenkinsJob[] = [
  // Service jobs - common pattern in microservices
  createJob("user-service-deploy"),
  createJob("user-service-staging"),
  createJob("user-service-prod"),
  createJob("order-service-deploy"),
  createJob("order-service-staging"),
  createJob("order-service-prod"),
  createJob("payment-service-deploy"),
  createJob("payment-service-staging"),
  createJob("payment-service-prod"),
  createJob("notification-service-deploy"),
  createJob("notification-service-staging"),

  // Complex nested service names (5+ tokens) - for testing specificity
  createJob("credit-card-payment-service-prod"),
  createJob("debit-card-payment-service-prod"),
  createJob("credit-card-processing-service-staging"),
  createJob("wire-transfer-payment-service-prod"),

  // API jobs
  createJob("api-gateway-deploy"),
  createJob("api-gateway-staging"),
  createJob("api-gateway-prod"),
  createJob("internal-api-deploy"),

  // Frontend jobs
  createJob("frontend-webapp-staging"),
  createJob("frontend-webapp-prod"),
  createJob("frontend-mobile-staging"),

  // Other jobs
  createJob("database-migration-deploy"),
  createJob("docker-image-build"),

  // Long unique job name (6 tokens) with no overlapping tokens
  // Used to test that partial matching works even for very specific long names
  createJob("data-analytics-ml-pipeline-prod"),
];

/** Helper to get the score for a specific job name from ranked results */
function scoreFor(results: ReturnType<typeof rankJobs>, name: string): number {
  const match = results.find((result) => result.job.name === name);
  return match?.score ?? 0;
}

describe("job fuzzy matching", () => {
  /**
   * Score Hierarchy Tests
   * Verifies: exact match > prefix match > substring match > token match
   */
  describe("score hierarchy", () => {
    /**
     * Query: "frontend-webapp-staging" (exact) vs "frontend-webapp-stag" (prefix) vs "webapp-staging" (substring)
     * Expected: exact > prefix > substring scores
     */
    test("exact > prefix > substring in scoring", () => {
      const exactScore = scoreFor(
        rankJobs("frontend-webapp-staging", jobs),
        "frontend-webapp-staging",
      );
      const prefixScore = scoreFor(
        rankJobs("frontend-webapp-stag", jobs),
        "frontend-webapp-staging",
      );
      const substringScore = scoreFor(
        rankJobs("webapp-staging", jobs),
        "frontend-webapp-staging",
      );

      expect(exactScore).toBeGreaterThan(prefixScore);
      expect(prefixScore).toBeGreaterThan(substringScore);
      expect(substringScore).toBeGreaterThanOrEqual(MIN_SCORE);
    });
  });

  /**
   * Exact Matching Tests
   */
  describe("exact matching", () => {
    /**
     * Query: "frontend-webapp-staging"
     * Expected: Exact match ranks first, and only ONE result above threshold
     */
    test("exact match ranks first with only one good match", () => {
      const results = rankJobs("frontend-webapp-staging", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      expect(results[0]?.job.name).toBe("frontend-webapp-staging");
      expect(goodMatches.length).toBe(1);
    });

    /**
     * Query: "FRONTEND-WEBAPP-STAGING" (uppercase)
     * Expected: Case-insensitive match, only ONE result above threshold
     */
    test("exact match is case insensitive with only one good match", () => {
      const results = rankJobs("FRONTEND-WEBAPP-STAGING", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      expect(results[0]?.job.name).toBe("frontend-webapp-staging");
      expect(goodMatches.length).toBe(1);
    });
  });

  /**
   * Prefix Matching Tests
   */
  describe("prefix matching", () => {
    /**
     * Query: "frontend-webapp-stag" (truncated)
     * Expected: Matches "frontend-webapp-staging"
     */
    test("prefix match finds correct job", () => {
      const results = rankJobs("frontend-webapp-stag", jobs);
      expect(results[0]?.job.name).toBe("frontend-webapp-staging");
    });
  });

  /**
   * Substring Matching Tests
   */
  describe("substring matching", () => {
    /**
     * Query: "webapp-staging"
     * Expected: Matches "frontend-webapp-staging"
     */
    test("substring match finds correct job", () => {
      const results = rankJobs("webapp-staging", jobs);
      expect(results[0]?.job.name).toBe("frontend-webapp-staging");
    });
  });

  /**
   * Service Specificity Tests
   * Critical: "payment-service" should NOT match "user-service-*" jobs
   */
  describe("service specificity", () => {
    /**
     * Query: "payment-service"
     * Expected: ONLY payment-service-* jobs score above threshold
     */
    test("payment-service only matches payment-service jobs", () => {
      const results = rankJobs("payment-service", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      // All good matches should be payment-service jobs only
      for (const match of goodMatches) {
        expect(match.job.name).toMatch(/^payment-service/);
      }

      // Other services should NOT be in good matches
      const otherServices = results.filter(
        (r) =>
          r.job.name.includes("service") &&
          !r.job.name.startsWith("payment-service"),
      );
      for (const other of otherServices) {
        expect(other.score).toBeLessThan(MIN_SCORE);
      }
    });

    /**
     * Query: "user-service"
     * Expected: ONLY user-service-* jobs score above threshold
     */
    test("user-service only matches user-service jobs", () => {
      const results = rankJobs("user-service", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      expect(goodMatches.length).toBe(3); // deploy, staging, prod
      expect(
        goodMatches.every((m) => m.job.name.startsWith("user-service")),
      ).toBe(true);
    });

    /**
     * Query: "order-service"
     * Expected: Exactly 3 matches (deploy, staging, prod)
     */
    test("order-service only matches order-service jobs", () => {
      const results = rankJobs("order-service", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      expect(goodMatches.length).toBe(3);
      for (const match of goodMatches) {
        expect(match.job.name).toMatch(/^order-service/);
      }
    });

    /**
     * Query: "payment-service-prod" (exact service+env)
     * Expected: Only ONE result above threshold
     */
    test("exact service+env match returns only one result", () => {
      const results = rankJobs("payment-service-prod", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      expect(results[0]?.job.name).toBe("payment-service-prod");
      expect(goodMatches.length).toBe(1);
    });
  });

  /**
   * Token Matching Tests
   */
  describe("token matching", () => {
    /**
     * Query: "frontend webapp" vs "webapp frontend"
     * Expected: Same result regardless of token order
     */
    test("token order does not matter", () => {
      const results1 = rankJobs("frontend webapp", jobs);
      const results2 = rankJobs("webapp frontend", jobs);
      expect(results1[0]?.job.name).toBe(results2[0]?.job.name);
    });

    /**
     * Query: "api gateway deploy" (space-separated)
     * Expected: Matches "api-gateway-deploy"
     */
    test("space-separated tokens match hyphenated names", () => {
      const results = rankJobs("api gateway deploy", jobs);
      expect(results[0]?.job.name).toBe("api-gateway-deploy");
    });

    /**
     * Query: "order service staging"
     * Expected: Matches "order-service-staging"
     */
    test("environment token disambiguates services", () => {
      const results = rankJobs("order service staging", jobs);
      expect(results[0]?.job.name).toBe("order-service-staging");
    });

    /**
     * Query: "order service"
     * Expected: ONLY order-service-* jobs above threshold, NOT user-service or payment-service
     * Tests that common token "service" doesn't cause false matches across different services.
     */
    test("order service does not match other services", () => {
      const results = rankJobs("order service", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      // All good matches should be order-service jobs only
      for (const match of goodMatches) {
        expect(match.job.name).toMatch(/^order-service/);
      }

      // Other services should NOT be in good matches even though they share "service" token
      const otherServices = results.filter(
        (r) =>
          r.job.name.includes("service") &&
          !r.job.name.startsWith("order-service"),
      );
      for (const other of otherServices) {
        expect(other.score).toBeLessThan(MIN_SCORE);
      }
    });

    /**
     * Query: "credit-card-payment-service"
     * Expected: Only credit-card-payment-service-prod (all tokens must match)
     * Tests that missing tokens exclude otherwise similar services.
     */
    test("credit-card-payment-service requires all tokens", () => {
      const results = rankJobs("credit-card-payment-service", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      // Exact/prefix match should rank first
      expect(results[0]?.job.name).toBe("credit-card-payment-service-prod");
      expect(results[0]?.score).toBeGreaterThanOrEqual(80);
      expect(goodMatches.length).toBe(1);

      // Should NOT match services missing any token
      const excludedServices = [
        "payment-service-prod",
        "debit-card-payment-service-prod",
        "credit-card-processing-service-staging",
      ];
      for (const serviceName of excludedServices) {
        const match = goodMatches.find((r) => r.job.name === serviceName);
        expect(match).toBeUndefined();
      }
    });

    /**
     * Query: "card-payment-service"
     * Expected: ONLY credit-card-payment-service-prod and debit-card-payment-service-prod (2 results)
     * Tests that partial overlap (3 tokens) with longer services returns exactly 2 matches
     * and excludes shorter services.
     */
    test("card-payment-service returns exactly two nested service matches", () => {
      const results = rankJobs("card-payment-service", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      // Should return exactly 2 results
      expect(goodMatches.length).toBe(2);

      // Should match credit-card-payment-service and debit-card-payment-service
      expect(
        goodMatches.some((m) =>
          m.job.name.startsWith("credit-card-payment-service"),
        ),
      ).toBe(true);
      expect(
        goodMatches.some((m) =>
          m.job.name.startsWith("debit-card-payment-service"),
        ),
      ).toBe(true);

      // Should NOT match any other services
      const allowedJobs = [
        "credit-card-payment-service-prod",
        "debit-card-payment-service-prod",
      ];
      for (const match of goodMatches) {
        expect(allowedJobs).toContain(match.job.name);
      }
    });

    /**
     * Query: "payment-service-prod" (exact base service)
     * Expected: Only payment-service-prod, NOT credit-card-payment-service-prod
     * Tests that exact match of a shorter service doesn't match longer nested services.
     */
    test("payment-service-prod exact match excludes nested services", () => {
      const results = rankJobs("payment-service-prod", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      // Only payment-service-prod should be a good match
      expect(goodMatches.length).toBe(1);
      expect(goodMatches[0]?.job.name).toBe("payment-service-prod");

      // Longer nested services should NOT be in good matches
      const nestedServiceMatch = goodMatches.find((m) =>
        m.job.name.startsWith("credit-card-payment-service"),
      );
      expect(nestedServiceMatch).toBeUndefined();
    });
  });

  /**
   * Edge Cases
   */
  describe("edge cases", () => {
    /**
     * Query: "" (empty)
     * Expected: Empty results
     */
    test("empty query returns empty results", () => {
      const results = rankJobs("", jobs);
      expect(results.length).toBe(0);
    });

    /**
     * Query: "nonexistent-xyz"
     * Expected: No good matches
     */
    test("nonexistent query returns no good matches", () => {
      const results = rankJobs("nonexistent-xyz", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);
      expect(goodMatches.length).toBe(0);
    });

    /**
     * Query: "frontend---webapp...staging" (special chars)
     * Expected: Normalizes to exact match, only ONE result above threshold
     */
    test("special characters are normalized to exact match with single result", () => {
      const results = rankJobs("frontend---webapp...staging", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      expect(results[0]?.job.name).toBe("frontend-webapp-staging");
      expect(goodMatches.length).toBe(1);
    });

    /**
     * Query: "analytics ml" (2 tokens)
     * Expected: Matches "data-analytics-ml-pipeline-prod" (6 token job)
     * Tests that partial queries can match very long unique job names
     * even when the job has many more tokens than the query.
     */
    test("partial query matches long unique job name", () => {
      const results = rankJobs("analytics ml", jobs);
      const goodMatches = results.filter((r) => r.score >= MIN_SCORE);

      // Should find the long job name even with only 2 matching tokens
      expect(goodMatches.length).toBe(1);
      expect(goodMatches[0]?.job.name).toBe("data-analytics-ml-pipeline-prod");
    });
  });
});
