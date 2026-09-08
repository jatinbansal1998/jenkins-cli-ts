import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runCli(args: string[]): { exitCode: number; output: string } {
  const home = mkdtempSync(join(tmpdir(), "jenkins-cli-test-home-"));
  try {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "src/index.ts", ...args],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        JENKINS_URL: undefined,
        JENKINS_USER: undefined,
        JENKINS_API_TOKEN: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    return {
      exitCode: result.exitCode,
      output:
        new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
