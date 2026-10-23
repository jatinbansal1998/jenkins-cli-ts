import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exitCodeForSignal,
  parseArguments,
  systemdScopeAvailable,
} from "../scripts/run-bounded";

async function runBounded(
  limits: string[],
  command: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn({
    env,
    cmd: [
      process.execPath,
      "scripts/run-bounded.ts",
      ...limits,
      "--",
      ...command,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signals land asynchronously, and a killed orphan stays visible until init
 * reaps it, so the process may still exist the instant run-bounded returns.
 */
async function isGoneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isRunning(pid)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(50);
  }
  return true;
}

describe("bounded test runner", () => {
  test("maps a named signal and an unnamed signal number to an exit code", () => {
    expect(exitCodeForSignal(null)).toBeUndefined();
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
    expect(exitCodeForSignal(35)).toBe(163);
  });

  test("rejects a run without both limits", () => {
    expect(() => parseArguments(["--minutes", "1", "--", "bun"])).toThrow(
      "Usage:",
    );
    expect(() => parseArguments(["--memory", "1G", "--", "bun"])).toThrow(
      "Usage:",
    );
    expect(
      parseArguments(["--minutes", "1", "--memory", "1G", "--", "bun", "test"]),
    ).toEqual({
      limits: { minutes: 1, memory: "1G" },
      command: ["bun", "test"],
    });
  });

  test.skipIf(process.platform === "win32")(
    "stops a run and everything it started once the time limit passes",
    async () => {
      const started = Date.now();
      const result = await runBounded(
        ["--minutes", "0.02", "--memory", "1G"],
        ["sh", "-c", "sleep 30 & echo $!; wait"],
      );
      const backgroundPid = Number(result.stdout.trim());

      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("ran past 0.02 min");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await isGoneWithin(backgroundPid, 5_000)).toBe(true);
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "still enforces the time limit where systemd cannot start a scope",
    async () => {
      // Mirrors GitHub's Ubuntu runners: systemd is installed, but its scopes
      // cannot be started from the runner's cgroup.
      const fakeBin = await mkdtemp(join(tmpdir(), "run-bounded-systemd-"));
      try {
        const systemdRun = join(fakeBin, "systemd-run");
        await Bun.write(
          systemdRun,
          '#!/bin/sh\n[ "$1" = --version ] && { echo "systemd 255"; exit 0; }\necho "Failed to get PID slice" >&2\nexit 1\n',
        );
        await chmod(systemdRun, 0o755);
        const result = await runBounded(
          ["--minutes", "0.02", "--memory", "1G"],
          ["sleep", "30"],
          { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        );

        expect(result.exitCode).toBe(124);
        expect(result.stderr).toContain("systemd scopes are unavailable");
      } finally {
        await rm(fakeBin, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test.skipIf(!systemdScopeAvailable())(
    "kills a run that allocates past its memory cap",
    async () => {
      const result = await runBounded(
        ["--minutes", "1", "--memory", "200M"],
        [
          process.execPath,
          "-e",
          "const chunks = []; for (;;) chunks.push(new Uint8Array(16 << 20).fill(1));",
        ],
      );

      expect(result.exitCode).toBe(137);
      expect(result.stderr).toContain("went over the 200M memory cap");
    },
    20_000,
  );

  test("every test package script is bounded", async () => {
    const packageJson = (await Bun.file("package.json").json()) as {
      scripts: Record<string, string>;
    };
    const testScripts = Object.entries(packageJson.scripts).filter(([name]) =>
      name.startsWith("test"),
    );

    expect(testScripts.length).toBeGreaterThan(0);
    for (const [name, script] of testScripts) {
      expect({
        name,
        bounded: script.includes("bun scripts/run-bounded.ts --minutes "),
      }).toEqual({ name, bounded: true });
    }
  });
});
