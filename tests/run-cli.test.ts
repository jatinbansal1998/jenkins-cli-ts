import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("run CLI routing", () => {
  test("registers the run command and help text", () => {
    const home = mkdtempSync(join(tmpdir(), "jenkins-cli-run-home-"));
    try {
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/index.ts", "run", "--help"],
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output =
        new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);

      expect(result.exitCode).toBe(0);
      expect(output).toContain(
        "List running builds and open one in the browser",
      );
      expect(output).toContain("--non-interactive");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
