import { describe, expect, test } from "bun:test";
import { parseArguments, systemdScopeAvailable } from "../scripts/run-bounded";

async function runBounded(
  limits: string[],
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn({
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

describe("bounded test runner", () => {
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
      expect(isRunning(backgroundPid)).toBe(false);
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
