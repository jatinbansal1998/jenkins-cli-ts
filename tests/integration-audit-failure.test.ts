import { describe, expect, mock, test } from "bun:test";
import { invokeCliExecutable } from "./integration/jenkins/harness";

const executionError = new Error("synthetic spawn failure");
const auditError = new Error("synthetic incomplete audit");
await mock.module("./helpers.native-executable", () => ({
  runNativeExecutable: async ({ executable }: { executable: string }) => {
    if (executable === "throws") throw executionError;
    return {
      exitCode: executable === "fails" ? 137 : 0,
      stdout: "",
      stderr: "synthetic diagnostic",
    };
  },
}));
await mock.module("./integration/jenkins/network-audit", () => ({
  auditCommand: async (command: string[]) => ({
    command,
    finish: async () => {
      throw auditError;
    },
  }),
}));

describe("CLI and audit failure reporting", () => {
  test("preserves the original execution error alongside the audit failure", async () => {
    try {
      await invokeCliExecutable("/synthetic-home", "throws", []);
      throw new Error("Expected invocation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        executionError,
        auditError,
      ]);
      expect((error as Error).cause).toBe(executionError);
    }
  });
  test("preserves nonzero exit diagnostics alongside the audit failure", async () => {
    await expect(
      invokeCliExecutable("/synthetic-home", "fails", []),
    ).rejects.toThrow("CLI exited with code 137");
    await expect(
      invokeCliExecutable("/synthetic-home", "fails", []),
    ).rejects.toThrow("synthetic diagnostic");
  });
  test("fails an otherwise successful invocation when auditing fails", async () => {
    await expect(
      invokeCliExecutable("/synthetic-home", "succeeds", []),
    ).rejects.toBe(auditError);
  });
});
