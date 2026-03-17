import { describe, expect, test } from "bun:test";
import { formatCompactStatus } from "../src/status-format";

describe("status formatting", () => {
  test("shows stage ordinal without a denominator when total is unknown", () => {
    const message = formatCompactStatus({
      buildNumber: 417,
      result: "RUNNING",
      status: {
        building: true,
        timestampMs: Date.now() - 8_000,
        estimatedDurationMs: 56_000,
        stages: [
          { id: "9", name: "Checkout", status: "SUCCESS" },
          { id: "22", name: "Maven Build", status: "IN_PROGRESS" },
        ],
      },
    });

    expect(message).toContain(
      "#417 | RUNNING | Stage 2: Maven Build (IN_PROGRESS)",
    );
  });

  test("shows cached total stages for running builds when known", () => {
    const message = formatCompactStatus({
      buildNumber: 421,
      result: "RUNNING",
      status: {
        building: true,
        timestampMs: Date.now() - 49_000,
        estimatedDurationMs: 85_000,
        knownTotalStages: 10,
        stages: [
          { id: "9", name: "Declarative: Checkout SCM", status: "SUCCESS" },
          { id: "22", name: "Cloning Tools", status: "IN_PROGRESS" },
        ],
      },
    });

    expect(message).toContain(
      "#421 | RUNNING | Stage: [2/10] Cloning Tools (IN_PROGRESS)",
    );
  });

  test("falls back to the last known stage for completed builds", () => {
    const message = formatCompactStatus({
      buildNumber: 695,
      result: "SUCCESS",
      status: {
        durationMs: 146_871,
        stages: [
          { id: "9", name: "Declarative: Checkout SCM", status: "SUCCESS" },
          { id: "193", name: "Declarative: Post Actions", status: "SUCCESS" },
        ],
      },
    });

    expect(message).toContain("[2/2] Declarative: Post Actions (SUCCESS)");
  });
});
