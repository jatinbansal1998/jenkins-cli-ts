import { existsSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const USAGE =
  "Usage: bun scripts/run-bounded.ts --minutes <n> --memory <size, e.g. 4G> -- <command> [args...]";
// Long enough for the Jenkins harness to remove its container after SIGTERM.
const KILL_GRACE_MS = 15_000;
// --slice-inherit keeps the scope inside the caller's slice (and its limits).
const MIN_SYSTEMD_VERSION = 254;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type Limits = { minutes: number; memory: string };

export function parseArguments(argv: string[]): {
  limits: Limits;
  command: string[];
} {
  const separator = argv.indexOf("--");
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const minutes = Number(readOption(options, "--minutes"));
  const memory = readOption(options, "--memory") ?? "";
  if (!(minutes > 0) || !/^\d+[KMG]$/.test(memory) || command.length === 0) {
    throw new Error(USAGE);
  }
  return { limits: { minutes, memory }, command };
}

function readOption(options: string[], name: string): string | undefined {
  const index = options.indexOf(name);
  return index < 0 ? undefined : options[index + 1];
}

/**
 * A transient systemd scope lets the kernel enforce the memory cap on every
 * process the command starts, and MemorySwapMax=0 stops a runaway from being
 * pushed into swap, which is what froze the machine instead of killing the test.
 */
export function systemdScopeAvailable(): boolean {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (process.platform !== "linux" || !runtimeDir) return false;
  if (!existsSync(join(runtimeDir, "systemd", "private"))) return false;
  if (!Bun.which("systemd-run")) return false;
  const version = Bun.spawnSync(["systemd-run", "--version"]).stdout.toString();
  return Number(version.match(/^systemd (\d+)/)?.[1]) >= MIN_SYSTEMD_VERSION;
}

async function main(): Promise<number> {
  const { limits, command } = parseArguments(process.argv.slice(2));
  const unit = systemdScopeAvailable()
    ? `jenkins-cli-bounded-${process.pid}-${Date.now()}.scope`
    : undefined;
  if (!unit) {
    console.error(
      `run-bounded: no systemd user manager; enforcing the ${limits.minutes} min limit only, not the ${limits.memory} memory cap.`,
    );
  }
  // Windows has no process groups; there only the direct child can be signalled.
  const ownGroup = process.platform !== "win32";
  const child = Bun.spawn({
    cmd: unit
      ? [
          "systemd-run",
          "--user",
          "--scope",
          "--quiet",
          "--slice-inherit",
          `--unit=${unit}`,
          `--property=MemoryMax=${limits.memory}`,
          "--property=MemorySwapMax=0",
          "--",
          ...command,
        ]
      : command,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: ownGroup,
  });
  const signalChild = (signal: NodeJS.Signals): void => {
    try {
      if (ownGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The group is already gone.
    }
  };
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => signalChild(signal));
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.error(
      `\nrun-bounded: ${command.join(" ")} ran past ${limits.minutes} min; stopping it.`,
    );
    signalChild("SIGTERM");
    setTimeout(() => signalChild("SIGKILL"), KILL_GRACE_MS).unref();
  }, limits.minutes * 60_000);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  // Children that ignored SIGTERM must not outlive the run.
  signalChild("SIGKILL");

  if (unit && scopeResult(unit) === "oom-kill") {
    console.error(
      `\nrun-bounded: ${command.join(" ")} went over the ${limits.memory} memory cap; the kernel killed it.`,
    );
    return 137;
  }
  if (timedOut) return 124;
  return child.signalCode
    ? 128 + constants.signals[child.signalCode]
    : exitCode;
}

function scopeResult(unit: string): string {
  const result = Bun.spawnSync([
    "systemctl",
    "--user",
    "show",
    "--property=Result",
    "--value",
    unit,
  ])
    .stdout.toString()
    .trim();
  // A failed scope stays loaded until it is reset.
  if (result !== "success") {
    Bun.spawnSync(["systemctl", "--user", "reset-failed", unit]);
  }
  return result;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
