import { describe, expect, test } from "bun:test";

describe("Sentry smoke workflow", () => {
  test("limits the auth token to pinned server-side verification", async () => {
    const workflow = (
      await Bun.file(".github/workflows/sentry-smoke.yml").text()
    ).replaceAll("\r\n", "\n");
    const packageJson = (await Bun.file("package.json").json()) as {
      devDependencies: Record<string, string>;
    };
    const stepsMarker = "    steps:";
    const stepsStart = workflow.indexOf(stepsMarker);
    expect(stepsStart).toBeGreaterThanOrEqual(0);

    const jobConfiguration = workflow.slice(0, stepsStart);
    const steps = workflow.slice(stepsStart + stepsMarker.length);
    const verificationStart = steps.indexOf(
      "- name: Verify events with Sentry CLI",
    );

    expect(jobConfiguration).not.toContain("SENTRY_AUTH_TOKEN");
    expect(verificationStart).toBeGreaterThanOrEqual(0);
    expect(steps.slice(0, verificationStart)).not.toContain(
      "SENTRY_AUTH_TOKEN",
    );
    expect(steps).toContain(
      "- name: Verify events with Sentry CLI\n        env:\n          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}",
    );
    expect(packageJson.devDependencies["@sentry/cli"]).toBe("3.6.2");
    expect(steps).toContain(
      'if ! EVENTS="$(bun run sentry-cli events list --max-rows 200 --pages 2)"; then',
    );
    expect(steps).toContain(
      "Sentry event query failed on attempt $ATTEMPT; retrying.",
    );
    expect(steps).toContain("continue");
    expect(steps).toContain('grep -Fq "$MANUAL_EVENT_ID"');
    expect(steps).toContain('grep -Fq "$GLOBAL_EVENT_ID"');
  });
});
