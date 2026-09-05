import { describe, expect, test } from "bun:test";
import { runNativeExecutable } from "./helpers.native-executable";
import {
  completedLineEnd,
  macOsExpectScript,
} from "./integration/jenkins/harness";

test.skipIf(process.platform === "win32")(
  "bounds a stalled native CLI process",
  async () => {
    const result = await runNativeExecutable({
      executable: process.execPath,
      args: ["-e", "await Bun.sleep(1500)"],
      env: process.env,
      timeoutMs: 100,
    });
    expect(result.exitCode).not.toBe(0);
  },
);

describe("interactive integration line matching", () => {
  test("matches only newline-complete semantic lines", () => {
    const text = "Jenkins username";

    expect(
      completedLineEnd(
        "◆  Open Jenkins? (useful for finding your Jenkins username)\n",
        text,
      ),
    ).toBeNull();
    expect(completedLineEnd(`◆  ${text}`, text)).toBeNull();
    expect(completedLineEnd(`◆  ${text}\n`, text)).toBe(`◆  ${text}\n`.length);
  });

  test("does not depend on a prompt glyph", () => {
    const text = "Action for cli-no-params";

    for (const prefix of ["◆", "*", "?", "◇"]) {
      const line = `${prefix}  ${text}\n`;
      expect(completedLineEnd(line, text)).toBe(line.length);
    }
    expect(completedLineEnd(`${text}\n`, text)).toBe(text.length + 1);
  });

  test("resumes after the matched line for repeated text", () => {
    const text = "Action for cli-no-params";
    const first = `◆  ${text}\n`;
    const barrier = 'ERROR: Profile "release" is read-only.\n';
    const second = `?  ${text}\n`;
    const output = first + barrier + second;

    const firstEnd = completedLineEnd(output, text);
    expect(firstEnd).toBe(first.length);
    expect(completedLineEnd(output.slice(firstEnd ?? 0), text)).toBe(
      barrier.length + second.length,
    );
  });
});

describe("macOS interactive integration harness", () => {
  test("stops after observing the required output", () => {
    const env: Record<string, string | undefined> = {};
    const script = macOsExpectScript(
      "jenkins-cli list",
      [
        { text: "Action for cli-no-params", input: "\r" },
        { text: 'ERROR: Profile "release" is read-only.', input: "" },
        { text: "Action for cli-no-params", input: "" },
      ],
      env,
    );

    expect(script).toContain('-exact "$env($textKey)\\r\\n"');
    expect(script).toContain('-exact "$env($textKey)\\n"');
    expect(script).not.toContain("◆");
    expect(script).not.toContain("◇");
    expect(script).toContain("catch close");
    expect(script).not.toContain(
      "Timed out waiting for the interactive CLI to exit.",
    );
    expect(env.JENKINS_CLI_EXPECT_TEXT_0).toBe("Action for cli-no-params");
    expect(env.JENKINS_CLI_EXPECT_TEXT_1).toBe(
      'ERROR: Profile "release" is read-only.',
    );
    expect(env.JENKINS_CLI_EXPECT_TEXT_2).toBe("Action for cli-no-params");
    expect(env.JENKINS_CLI_EXPECT_INPUT_2).toBe("");
    expect(env.JENKINS_CLI_EXPECT_STEP_COUNT).toBe("3");
  });
});
