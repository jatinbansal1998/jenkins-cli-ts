import { describe, expect, test } from "bun:test";
import { macOsExpectScript } from "./integration/jenkins/harness";

describe("macOS interactive integration harness", () => {
  test("waits for active prompts instead of completed prompts", () => {
    const env: Record<string, string | undefined> = {};
    const script = macOsExpectScript(
      "jenkins-cli list",
      [
        { prompt: "Action for cli-no-params", input: "\r" },
        { prompt: "Action for cli-no-params", input: "\u001b" },
      ],
      env,
    );

    expect(script).toContain('-exact "◆  $env($promptKey)"');
    expect(script).toContain('-exact "*  $env($promptKey)"');
    expect(script).not.toContain('-exact "  $env($promptKey)"');
    expect(script).not.toContain("◇  $env($promptKey)");
    expect(env.JENKINS_CLI_EXPECT_STEP_COUNT).toBe("2");
  });
});
