import { describe, expect, test } from "bun:test";
import { CliError } from "../src/cli";
import { EXIT_CODES, exitCodeFor, type ErrorCode } from "../src/error-codes";

function cliError(code: ErrorCode): CliError {
  return new CliError("message", [], code);
}

describe("exit codes", () => {
  test("derive from the error code class", () => {
    expect(exitCodeFor(cliError("INVALID_USAGE"))).toBe(2);
    expect(exitCodeFor(cliError("CONFIG_INVALID"))).toBe(2);
    expect(exitCodeFor(cliError("JENKINS_BAD_REQUEST"))).toBe(2);
    expect(exitCodeFor(cliError("JENKINS_AUTH_ERROR"))).toBe(3);
    expect(exitCodeFor(cliError("CREDENTIALS_MISSING"))).toBe(3);
    expect(exitCodeFor(cliError("JOB_NOT_FOUND"))).toBe(4);
    expect(exitCodeFor(cliError("BUILD_NOT_FOUND"))).toBe(4);
    expect(exitCodeFor(cliError("PROFILE_PROTECTED"))).toBe(5);
    expect(exitCodeFor(cliError("JENKINS_UNREACHABLE"))).toBe(6);
    expect(exitCodeFor(cliError("JENKINS_HTTP_ERROR"))).toBe(6);
    expect(exitCodeFor(cliError("OPERATION_CANCELLED"))).toBe(130);
    expect(exitCodeFor(cliError("UPDATE_FAILED"))).toBe(1);
  });

  test("an error that is not a CliError exits 1", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(1);
    expect(exitCodeFor("boom")).toBe(1);
  });

  test("the README documents every exit code", async () => {
    const readme = await Bun.file("README.md").text();
    const section = readme.split("## Exit codes")[1]?.split("\n## ")[0] ?? "";
    const documented = [...section.matchAll(/^\| `(\d+)`/gm)].map((match) =>
      Number(match[1]),
    );
    expect(documented.toSorted((a, b) => a - b)).toEqual(
      Object.values(EXIT_CODES).toSorted((a, b) => a - b),
    );
  });
});
