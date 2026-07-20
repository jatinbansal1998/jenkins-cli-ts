import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function runCompiled(args: string[], home = makeHome()): CliRun {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    env: {
      ...process.env,
      HOME: home,
      JENKINS_URL: undefined,
      JENKINS_USER: undefined,
      JENKINS_API_TOKEN: undefined,
      JENKINS_ANALYTICS_DISABLED: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output:
      new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
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
    define: {
      __BUILD_TARGET__: JSON.stringify(
        `bun-${process.platform}-${process.arch}`,
      ),
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
  test("starts and reports its version through both aliases", () => {
    for (const flag of ["-v", "--version"]) {
      const result = runCompiled([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        `bun-${process.platform}-${process.arch}`,
      );
      expect(result.output).not.toContain("SyntaxError");
    }
  });

  test("renders root and command help", () => {
    const root = runCompiled(["--help"]);
    expect(root.exitCode).toBe(0);
    expect(root.output).toContain("Usage: jenkins-cli [command] [options]");
    expect(root.output).toContain("jenkins-cli auth");
    expect(root.output).toContain("jenkins-cli build");

    const build = runCompiled(["build", "--help"]);
    expect(build.exitCode).toBe(0);
    expect(build.output).toContain("jenkins-cli build");
    expect(build.output).toContain("--param");
    expect(build.output).toContain("--watch");
  });

  test("renders the full compiled command reference", () => {
    const result = runCompiled(["help", "--full"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("jenkins-cli auth login --help");
    expect(result.output).toContain("jenkins-cli build --help");
    expect(result.output).toContain("jenkins-cli artifacts --help");
    expect(result.output).toContain("jenkins-cli update --help");
  });

  test("runs local profile commands without contacting Jenkins", () => {
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

    const list = runCompiled(["auth", "list", "--non-interactive"], home);
    expect(list.exitCode).toBe(0);
    expect(list.output).toContain(
      "work (default)  https://jenkins.example.com  ci-user  plaintext",
    );

    const current = runCompiled(["auth", "current", "--non-interactive"], home);
    expect(current.exitCode).toBe(0);
    expect(current.output).toContain("Source:           Default profile");
    expect(current.output).toContain("Profile:          work");
    expect(current.output).not.toContain("secret-token");

    const compatibility = runCompiled(
      ["profile", "list", "--non-interactive"],
      home,
    );
    expect(compatibility.exitCode).toBe(0);
    expect(compatibility.output).toBe(list.output);
  });

  test("handles offline validation errors through the compiled entry point", () => {
    const login = runCompiled(["login", "--non-interactive"]);
    expect(login.exitCode).toBe(1);
    expect(login.output).toContain("ERROR: Missing required --url.");

    const unknownOption = runCompiled([
      "--definitely-not-a-real-option",
      "--non-interactive",
    ]);
    expect(unknownOption.exitCode).toBe(1);
    expect(unknownOption.output).toContain("ERROR: Unknown arguments:");
    expect(unknownOption.output).toContain("definitely-not-a-real-option");
  });
});
