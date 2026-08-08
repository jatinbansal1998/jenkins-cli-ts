import { describe, expect, test } from "bun:test";
import { macOsExpectScript } from "./integration/jenkins/harness";

describe("macOS interactive integration harness", () => {
  test("synchronizes repeated messages through meaningful output", () => {
    const env: Record<string, string | undefined> = {};
    const script = macOsExpectScript(
      "jenkins-cli list",
      [
        { text: "Action for cli-no-params", input: "\r" },
        { text: 'ERROR: Profile "release" is read-only.', input: "" },
        { text: "Action for cli-no-params", input: "\u001b" },
      ],
      env,
    );

    expect(script).toContain('-exact "$env($textKey)"');
    expect(script).not.toContain("◆");
    expect(script).not.toContain("◇");
    expect(env.JENKINS_CLI_EXPECT_TEXT_0).toBe("Action for cli-no-params");
    expect(env.JENKINS_CLI_EXPECT_TEXT_1).toBe(
      'ERROR: Profile "release" is read-only.',
    );
    expect(env.JENKINS_CLI_EXPECT_TEXT_2).toBe("Action for cli-no-params");
    expect(env.JENKINS_CLI_EXPECT_STEP_COUNT).toBe("3");
  });
});
