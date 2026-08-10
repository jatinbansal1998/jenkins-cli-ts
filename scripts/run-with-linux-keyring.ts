const SESSION_MARKER = "JENKINS_CLI_LINUX_KEYRING_SESSION";
const KEYRING_PASSWORD = "jenkins-cli-ci";
const REQUIRED_COMMANDS = [
  "dbus-run-session",
  "gnome-keyring-daemon",
  "secret-tool",
] as const;
const EXPORTED_KEYRING_VARIABLES = new Set([
  "GNOME_KEYRING_CONTROL",
  "SSH_AUTH_SOCK",
]);

export function parseKeyringEnvironment(
  output: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = line
      .trim()
      .match(/^([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^;]*));?/);
    const key = match?.[1];
    if (!key || !EXPORTED_KEYRING_VARIABLES.has(key)) continue;
    env[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return env;
}

async function main(): Promise<number> {
  // Bun consumes the conventional `--` separator before populating argv.
  const command = process.argv.slice(2);
  if (command.length === 0) {
    throw new Error(
      "Usage: bun scripts/run-with-linux-keyring.ts -- <command> [args...]",
    );
  }

  if (process.platform !== "linux") {
    return runInherited(command, process.env);
  }

  assertLinuxKeyringCommands();
  if (process.env[SESSION_MARKER] !== "1") {
    return runInherited(
      [process.execPath, import.meta.path, "--", ...command],
      {
        ...process.env,
        [SESSION_MARKER]: "1",
      },
      [Bun.which("dbus-run-session") ?? "dbus-run-session", "--"],
    );
  }

  const daemon = await runCaptured(
    ["gnome-keyring-daemon", "--unlock", "--components=secrets"],
    process.env,
    KEYRING_PASSWORD,
  );
  const keyringEnv = {
    ...process.env,
    ...parseKeyringEnvironment(daemon.stdout),
    REQUIRE_KEYCHAIN_INTEGRATION: "1",
  };
  await verifySecretService(keyringEnv);
  return runInherited(command, keyringEnv);
}

function assertLinuxKeyringCommands(): void {
  const missing = REQUIRED_COMMANDS.filter((command) => !Bun.which(command));
  if (missing.length === 0) return;
  throw new Error(
    `Linux Secret Service integration requires: ${missing.join(", ")}. Install with: sudo apt-get install -y libsecret-tools gnome-keyring dbus-x11`,
  );
}

async function verifySecretService(
  env: Record<string, string | undefined>,
): Promise<void> {
  const account = `integration-probe-${process.pid}`;
  const attributes = ["service", "jenkins-cli-ci", "account", account];
  try {
    await runCaptured(
      [
        "secret-tool",
        "store",
        "--label=jenkins-cli integration probe",
        ...attributes,
      ],
      env,
      "keyring-probe",
    );
    const lookup = await runCaptured(
      ["secret-tool", "lookup", ...attributes],
      env,
    );
    if (lookup.stdout.trim() !== "keyring-probe") {
      throw new Error("Secret Service probe returned the wrong credential.");
    }
  } finally {
    await runCaptured(["secret-tool", "clear", ...attributes], env).catch(
      () => undefined,
    );
  }
}

async function runCaptured(
  command: string[],
  env: Record<string, string | undefined>,
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const subprocess = Bun.spawn({
    cmd: command,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) await subprocess.stdin.write(input);
  await subprocess.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command[0]} exited with code ${exitCode}: ${stderr.trim() || stdout.trim() || "no output"}`,
    );
  }
  return { stdout, stderr };
}

async function runInherited(
  command: string[],
  env: Record<string, string | undefined>,
  prefix: string[] = [],
): Promise<number> {
  const subprocess = Bun.spawn({
    cmd: [...prefix, ...command],
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return subprocess.exited;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
