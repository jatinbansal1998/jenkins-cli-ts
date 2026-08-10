import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    JENKINS_ANALYTICS_DISABLED: "true",
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
      analyticsDisabled: true,
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
