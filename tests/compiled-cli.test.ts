import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeExecutable } from "./helpers.native-executable";
import { embedCrossKeychainAssets } from "../scripts/build-plugins";

type CliRun = {
  exitCode: number;
  output: string;
};

let tempDir: string;
let executable: string;
let nextHomeId = 0;

function makeHome(config?: Record<string, unknown>): string {
  const home = join(tempDir, `home-${nextHomeId++}`);
  mkdirSync(home, { recursive: true });
  if (config) {
    const configDir = join(home, ".config", "jenkins-cli");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "jenkins-cli-config.json"),
      JSON.stringify(config),
    );
  }
  return home;
}

async function runCompiled(args: string[], home = makeHome()): Promise<CliRun> {
  const env = {
    ...process.env,
    HOME: home,
    ...(process.platform === "win32"
      ? {
          USERPROFILE: home,
          LOCALAPPDATA: join(home, "AppData", "Local"),
          APPDATA: join(home, "AppData", "Roaming"),
        }
      : {}),
    JENKINS_URL: undefined,
    JENKINS_USER: undefined,
    JENKINS_API_TOKEN: undefined,
  };
  const result = await runNativeExecutable({
    executable,
    args,
    env,
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout + result.stderr,
  };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "jenkins-cli-compiled-"));
  executable = join(
    tempDir,
    process.platform === "win32" ? "jenkins-cli.exe" : "jenkins-cli",
  );

  const build = await Bun.build({
    entrypoints: ["./src/index.ts"],
    target: "bun",
    compile: { outfile: executable },
    plugins: [embedCrossKeychainAssets],
    define: {
      __BUILD_TARGET__: JSON.stringify(
        `bun-${process.platform}-${process.arch}`,
      ),
      __COMPILED_ENTRYPOINT__: "true",
    },
  });

  if (!build.success) {
    throw new Error(build.logs.map(String).join("\n"));
  }
});

afterAll(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("compiled CLI", () => {
  test("embeds the Windows Credential Manager helper", async () => {
    const binaryText = Buffer.from(
      await Bun.file(executable).arrayBuffer(),
    ).toString("latin1");

    expect(binaryText).toContain("CredMan.CredentialManager");
    expect(binaryText).not.toContain('"scripts", "credman.ps1"');
  });

  test("starts and reports its version through both aliases", async () => {
    for (const flag of ["-v", "--version"]) {
      const result = await runCompiled([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        `bun-${process.platform}-${process.arch}`,
      );
      expect(result.output).not.toContain("SyntaxError");
    }
  });

  test("renders root and command help", async () => {
    const root = await runCompiled(["--help"]);
    expect(root.exitCode).toBe(0);
    expect(root.output).toContain("Usage: jenkins-cli [command] [options]");
    expect(root.output).toContain("jenkins-cli auth");
    expect(root.output).toContain("jenkins-cli build");

    const build = await runCompiled(["build", "--help"]);
    expect(build.exitCode).toBe(0);
    expect(build.output).toContain("jenkins-cli build");
    expect(build.output).toContain("--param");
    expect(build.output).toContain("--watch");

    const logs = await runCompiled(["logs", "--no-timestamps", "--help"]);
    expect(logs.exitCode).toBe(0);
    expect(logs.output).toContain("--no-timestamps");
    expect(logs.output).not.toContain("Unknown argument: timestamps");
  });

  test("renders the full compiled command reference", async () => {
    const result = await runCompiled(["help", "--full"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("jenkins-cli auth login --help");
    expect(result.output).toContain("jenkins-cli build --help");
    expect(result.output).toContain("jenkins-cli artifacts --help");
    expect(result.output).toContain("jenkins-cli update --help");
  });

  test("runs local profile commands without contacting Jenkins", async () => {
    const home = makeHome({
      version: 2,
      defaultProfile: "work",
      profiles: {
        work: {
          jenkinsUrl: "https://jenkins.example.com",
          jenkinsUser: "ci-user",
          jenkinsApiToken: "secret-token",
        },
      },
    });

    const list = await runCompiled(["auth", "list", "--non-interactive"], home);
    expect(list.exitCode).toBe(0);
    expect(list.output).toContain(
      "work (default)  https://jenkins.example.com  ci-user  plaintext",
    );

    const current = await runCompiled(
      ["auth", "current", "--non-interactive"],
      home,
    );
    expect(current.exitCode).toBe(0);
    expect(current.output).toContain("Source:           Default profile");
    expect(current.output).toContain("Profile:          work");
    expect(current.output).not.toContain("secret-token");

    const compatibility = await runCompiled(
      ["profile", "list", "--non-interactive"],
      home,
    );
    expect(compatibility.exitCode).toBe(0);
    expect(compatibility.output).toBe(list.output);
  });

  test("ignores a malformed cached minimum version", async () => {
    const home = makeHome({ version: 2, profiles: {} });
    writeFileSync(
      join(home, ".config", "jenkins-cli", "update-state.json"),
      JSON.stringify({
        enabled: false,
        minAllowedVersion: "9999.0",
        minAllowedFetchedAt: new Date().toISOString(),
      }),
    );

    const result = await runCompiled(
      ["auth", "list", "--non-interactive"],
      home,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("OK: No profiles configured.");
  });

  test("does not collect telemetry even when legacy settings opt in", async () => {
    let requests = 0;
    const collector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("{}");
      },
    });
    try {
      const home = makeHome({
        version: 2,
        profiles: {},
        analyticsDisabled: false,
      });
      writeFileSync(
        join(home, ".config", "jenkins-cli", "update-state.json"),
        JSON.stringify({
          autoUpdate: false,
          minAllowedVersion: "0.0.0",
          minAllowedFetchedAt: new Date().toISOString(),
        }),
      );
      const result = await runNativeExecutable({
        executable,
        args: ["auth", "list", "--non-interactive"],
        env: {
          ...process.env,
          HOME: home,
          JENKINS_ANALYTICS_DISABLED: "false",
          JENKINS_POSTHOG_API_KEY: "synthetic-test-key",
          JENKINS_POSTHOG_HOST: collector.url.toString(),
          SENTRY_DSN: `http://public@127.0.0.1:${collector.port}/1`,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No profiles configured.");
      expect(requests).toBe(0);
      expect(
        await Bun.file(
          join(home, ".config", "jenkins-cli", "analytics-id"),
        ).exists(),
      ).toBe(false);
    } finally {
      await collector.stop(true);
    }
  });

  test("handles offline validation errors through the compiled entry point", async () => {
    const login = await runCompiled(["login", "--non-interactive"]);
    expect(login.exitCode).toBe(1);
    expect(login.output).toContain("ERROR: Missing required --url.");

    const unknownOption = await runCompiled([
      "--definitely-not-a-real-option",
      "--non-interactive",
    ]);
    expect(unknownOption.exitCode).toBe(1);
    expect(unknownOption.output).toContain("ERROR: Unknown arguments:");
    expect(unknownOption.output).toContain("definitely-not-a-real-option");
  });
});

describe("compiled CLI local error logs", () => {
  let errorTempDir: string;
  let errorExecutable: string;
  let nextErrorHome = 0;

  beforeAll(async () => {
    errorTempDir = mkdtempSync(join(tmpdir(), "jenkins-error-logs-"));
    errorExecutable = join(errorTempDir, "jenkins-cli");
    const build = await Bun.build({
      entrypoints: ["./src/index.ts"],
      target: "bun",
      compile: { outfile: errorExecutable },
      define: { __COMPILED_ENTRYPOINT__: "true" },
      plugins: [
        embedCrossKeychainAssets,
        {
          name: "inject-synthetic-command-failure",
          setup(builder) {
            builder.onLoad(
              { filter: /\/src\/index\.ts$/ },
              async ({ path }) => ({
                loader: "ts",
                contents: (await Bun.file(path).text()).replace(
                  "await main().catch(",
                  `await (async () => {
            if (process.argv.includes("--api")) {
              const logger = await import("./logger");
              logger.setDebugMode(true);
              logger.logApiRequest("POST", "https://synthetic.invalid/job/example", { Authorization: "synthetic-header-secret" }, true);
            }
            const error = new TypeError("synthetic failure token=local-detail", { cause: new Error("synthetic cause") });
            if (process.argv.includes("--uncaught")) { setTimeout(() => { throw error; }, 0); return; }
            if (process.argv.includes("--rejection")) { void Promise.reject(error); return; }
            throw error;
          })().catch(`,
                ),
              }),
            );
          },
        },
      ],
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  });

  afterAll(() => {
    if (errorTempDir) rmSync(errorTempDir, { recursive: true, force: true });
  });

  function makeErrorHome() {
    const home = join(errorTempDir, `home-${nextErrorHome++}`);
    const dir = join(home, ".config", "jenkins-cli");
    mkdirSync(dir, { recursive: true });
    return {
      home,
      dir,
      log: join(dir, `error-${new Date().toISOString().slice(0, 10)}.log`),
    };
  }

  async function runErrorFixture(home: string, args: string[] = []) {
    let requests = 0;
    const collector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("{}");
      },
    });
    try {
      const result = await runNativeExecutable({
        executable: errorExecutable,
        args,
        env: {
          ...process.env,
          HOME: home,
          SENTRY_DSN: `http://public@127.0.0.1:${collector.port}/1`,
        },
        timeoutMs: 10_000,
      });
      expect(requests).toBe(0);
      return result;
    } finally {
      await collector.stop(true);
    }
  }

  test("persists full stacks and causes without debug and appends on the next invocation", async () => {
    const h = makeErrorHome();
    const result = await runErrorFixture(h.home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "ERROR: synthetic failure token=local-detail",
    );
    expect(result.stdout).toBe("");
    expectLog(h.log);
    await runErrorFixture(h.home);
    expect(
      readFileSync(h.log, "utf8").match(/TypeError: synthetic failure/g),
    ).toHaveLength(2);
    expect(readdirSync(h.dir)).toEqual([h.log.split(/[\\/]/).at(-1)!]);
  });

  test.skipIf(process.platform === "win32")(
    "protects existing API logs and refuses symlink targets",
    async () => {
      const h = makeErrorHome();
      const apiLog = join(h.dir, `api-${date(0)}.log`);
      writeFileSync(apiLog, "previous entry\n");
      chmodSync(apiLog, 0o644);
      await runErrorFixture(h.home, ["--api"]);
      expect(statSync(apiLog).mode & 0o777).toBe(0o600);
      expect(readFileSync(apiLog, "utf8")).toContain("Body:\n  <omitted>");
      expect(readFileSync(apiLog, "utf8")).not.toContain(
        "synthetic-header-secret",
      );
      rmSync(apiLog);
      const target = join(h.home, "api-target.txt");
      writeFileSync(target, "untouched");
      symlinkSync(target, apiLog);
      await runErrorFixture(h.home, ["--api"]);
      expect(readFileSync(target, "utf8")).toBe("untouched");
    },
  );

  test("persists the original cause from a real failed Jenkins request", async () => {
    const h = makeErrorHome();
    const controller = Bun.serve({
      port: 0,
      fetch: () => new Response("invalid-json"),
    });
    try {
      const result = await runNativeExecutable({
        executable,
        args: ["list", "--json", "--non-interactive"],
        env: {
          ...process.env,
          HOME: h.home,
          JENKINS_URL: controller.url.toString(),
          JENKINS_USER: "synthetic-user",
          JENKINS_API_TOKEN: "synthetic-token",
        },
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.message).toContain(
        "Invalid JSON response",
      );
      const log = readFileSync(h.log, "utf8");
      expect(log).toContain("Caused by\nSyntaxError:");
      expect(log).toMatch(/\s+at .+:\d+:\d+/);
    } finally {
      await controller.stop(true);
    }
  });

  test.each(["--json", "--jsonl"])(
    "preserves structured output for %s",
    async (flag) => {
      const h = makeErrorHome();
      const result = await runErrorFixture(h.home, [flag]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toEqual({
        code: "UNEXPECTED_ERROR",
        message: "synthetic failure token=local-detail",
      });
      expect(result.stderr).toBe("");
      expectLog(h.log);
    },
  );

  test.each([
    ["--uncaught", "--json"],
    ["--uncaught", "--jsonl"],
    ["--rejection", "--json"],
    ["--rejection", "--jsonl"],
  ])("preserves structured fatal output for %s %s", async (fatal, format) => {
    const h = makeErrorHome();
    const result = await runErrorFixture(h.home, [fatal, format]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.message).toBe(
      "synthetic failure token=local-detail",
    );
    expect(result.stderr).toBe("");
    expectLog(h.log);
  });

  test.skipIf(process.platform === "win32")(
    "tightens permissions on an existing error log",
    async () => {
      const h = makeErrorHome();
      writeFileSync(h.log, "previous entry\n");
      chmodSync(h.log, 0o644);
      await runErrorFixture(h.home);
      expectLog(h.log);
      expect(readFileSync(h.log, "utf8")).toContain("previous entry");
    },
  );

  test.each(["--uncaught", "--rejection"])(
    "persists fatal %s failures and exits nonzero",
    async (flag) => {
      const h = makeErrorHome();
      const result = await runErrorFixture(h.home, [flag]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ERROR: synthetic failure");
      expectLog(h.log);
    },
  );

  test("prunes expired error and API files while retaining the seven-day window and unrelated files", async () => {
    const h = makeErrorHome();
    const expired = [
      `error-${date(8)}.log`,
      `api-${date(8)}.log`,
      "analytics-id",
    ];
    const retained = [
      `error-${date(7)}.log`,
      `error-${date(1)}.log`,
      "unrelated.log",
    ];
    for (const file of [...expired, ...retained])
      writeFileSync(join(h.dir, file), "old entry");
    await runErrorFixture(h.home);
    const files = readdirSync(h.dir);
    for (const file of expired) expect(files).not.toContain(file);
    for (const file of retained) expect(files).toContain(file);
    expectLog(h.log);
  });

  test("keeps the original error and exit status when disk logging fails", async () => {
    const h = makeErrorHome();
    mkdirSync(h.log);
    const result = await runErrorFixture(h.home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("ERROR: synthetic failure token=local-detail\n");
  });

  test.skipIf(process.platform === "win32")(
    "does not follow an error-log symlink",
    async () => {
      const h = makeErrorHome();
      const target = join(h.home, "unrelated.txt");
      writeFileSync(target, "untouched");
      symlinkSync(target, h.log);
      expect((await runErrorFixture(h.home)).exitCode).toBe(1);
      expect(readFileSync(target, "utf8")).toBe("untouched");
    },
  );
});

const date = (days: number) =>
  new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
function expectLog(log: string) {
  const contents = readFileSync(log, "utf8");
  expect(contents).toContain("TypeError: synthetic failure token=local-detail");
  expect(contents).toMatch(/\s+at .+:\d+:\d+/);
  expect(contents).toContain("Caused by\nError: synthetic cause");
  expect(contents).toContain("jenkins-cli ");
  if (process.platform !== "win32")
    expect(statSync(log).mode & 0o777).toBe(0o600);
}
