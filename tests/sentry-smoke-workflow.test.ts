import { describe, expect, test } from "bun:test";

describe("Sentry smoke workflow", () => {
  test("limits the auth token to pinned server-side verification", async () => {
    const workflow = await Bun.file(
      ".github/workflows/sentry-smoke.yml",
    ).text();
    const packageJson = (await Bun.file("package.json").json()) as {
      devDependencies: Record<string, string>;
    };
    const [jobConfiguration, steps] = workflow.split("    steps:");

    expect(jobConfiguration).not.toContain("SENTRY_AUTH_TOKEN");
    expect(steps).toContain(
      "- name: Verify events with Sentry CLI\n        env:\n          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}",
    );
    expect(packageJson.devDependencies["@sentry/cli"]).toBe("3.6.2");
    expect(steps).toContain("bun run sentry-cli events list");
    expect(steps).toContain('grep -Fq "$MANUAL_EVENT_ID"');
    expect(steps).toContain('grep -Fq "$GLOBAL_EVENT_ID"');
  });
});
