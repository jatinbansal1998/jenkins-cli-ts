import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli";
import { parseBuildCustomParams } from "../src";

describe("cli default command", () => {
  test("defaults to list flow when no command is provided", () => {
    const tempHome = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));

    try {
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/index.ts", "--non-interactive"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          JENKINS_URL: "https://jenkins.example.com",
          JENKINS_USER: "ci-user",
          JENKINS_API_TOKEN: "ci-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output =
        new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);

      expect(result.exitCode).toBe(1);
      expect(output).toContain("Job cache is missing.");
      expect(output).not.toContain("Missing command. Use --help to see usage.");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("migrates legacy config during normal command execution", () => {
    const tempHome = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));
    const configDir = join(tempHome, ".config", "jenkins-cli");
    const configPath = join(configDir, "jenkins-cli-config.json");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            jenkinsUrl: "https://legacy.example.com",
            jenkinsUser: "legacy-user",
            jenkinsApiToken: "legacy-token",
            branchParam: "BRANCH",
            useCrumb: true,
          },
          null,
          2,
        ),
      );

      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/index.ts", "list", "--non-interactive"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output =
        new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);

      expect(result.exitCode).toBe(1);
      expect(output).toContain("Job cache is missing.");

      const migratedConfig = JSON.parse(
        fs.readFileSync(configPath, "utf8"),
      ) as {
        version?: number;
        defaultProfile?: string;
        profiles?: Record<string, unknown>;
      };
      expect(migratedConfig.version).toBe(2);
      expect(migratedConfig.defaultProfile).toBe("default");
      expect(migratedConfig.profiles?.default).toBeDefined();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("does not fallback to legacy global cache file", () => {
    const tempHome = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));
    const cacheDir = join(tempHome, "Library", "Caches", "jenkins-cli");
    const legacyCachePath = join(cacheDir, "jobs.json");

    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        legacyCachePath,
        JSON.stringify(
          {
            jenkinsUrl: "https://jenkins.example.com",
            user: "ci-user",
            fetchedAt: new Date().toISOString(),
            jobs: [
              {
                name: "api-prod",
                url: "https://jenkins.example.com/job/api-prod/",
              },
            ],
          },
          null,
          2,
        ),
      );

      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/index.ts", "list", "--non-interactive"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          JENKINS_URL: "https://jenkins.example.com",
          JENKINS_USER: "ci-user",
          JENKINS_API_TOKEN: "ci-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output =
        new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);

      expect(result.exitCode).toBe(1);
      expect(output).toContain("Job cache is missing.");
      expect(output).not.toContain("api-prod");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("fails fast in non-interactive mode when cached minimum version is higher", () => {
    const tempHome = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));
    const configDir = join(tempHome, ".config", "jenkins-cli");
    const updateStatePath = join(configDir, "update-state.json");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        updateStatePath,
        JSON.stringify({
          minAllowedVersion: "v9.9.9",
          minAllowedFetchedAt: "2026-02-12T00:00:00.000Z",
        }),
      );

      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/index.ts", "list", "--non-interactive"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          JENKINS_URL: "https://jenkins.example.com",
          JENKINS_USER: "ci-user",
          JENKINS_API_TOKEN: "ci-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output =
        new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);

      expect(result.exitCode).toBe(1);
      expect(output).toContain(
        "Minimum supported jenkins-cli version is v9.9.9",
      );
      expect(output).toContain("Minimum required version: v9.9.9.");
      expect(output).toContain("Run `jenkins-cli update` to update.");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("startup remains non-blocking when min-version cache is missing", () => {
    const tempHome = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));

    try {
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/index.ts", "list", "--non-interactive"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          JENKINS_URL: "https://jenkins.example.com",
          JENKINS_USER: "ci-user",
          JENKINS_API_TOKEN: "ci-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output =
        new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);

      expect(result.exitCode).toBe(1);
      expect(output).toContain("Job cache is missing.");
      expect(output).not.toContain("Minimum required version:");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("cli argument routing", () => {
  function runCli(args: string[]): {
    exitCode: number;
    output: string;
  } {
    const tempHome = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));
    try {
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/index.ts", ...args],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          JENKINS_URL: "https://jenkins.example.com",
          JENKINS_USER: "ci-user",
          JENKINS_API_TOKEN: "ci-token",
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
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }

  test("--version reports the package version and build target", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };

    const result = runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(packageJson.version);
  });

  test("unknown commands fail fast with a usage hint", () => {
    const result = runCli(["bogus-command", "--non-interactive"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Unknown argument: bogus-command");
    expect(result.output).toContain("Run with --help to see usage.");
  });

  test("profile use without a name fails with a targeted error", () => {
    const result = runCli(["profile", "use", "--non-interactive"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Missing required <name> for profile use.");
  });

  test("build rejects --job together with --job-url", () => {
    const result = runCli([
      "build",
      "--non-interactive",
      "--job",
      "api",
      "--job-url",
      "https://jenkins.example.com/job/api",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "Provide either --job or --job-url, not both.",
    );
  });

  test("deploy alias routes to the build command", () => {
    const result = runCli([
      "deploy",
      "--non-interactive",
      "--job",
      "api",
      "--job-url",
      "https://jenkins.example.com/job/api",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "Provide either --job or --job-url, not both.",
    );
  });

  test("build maps --without-params to the default-branch conflict check", () => {
    const result = runCli([
      "build",
      "--non-interactive",
      "--job-url",
      "https://jenkins.example.com/job/api",
      "--branch",
      "staging",
      "--without-params",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "Use either --branch or --without-params, not both.",
    );
  });

  test("build rejects malformed --param values", () => {
    const result = runCli([
      "build",
      "--non-interactive",
      "--job-url",
      "https://jenkins.example.com/job/api",
      "--param",
      "NO_EQUALS_SIGN",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Invalid --param value.");
    expect(result.output).not.toContain("NO_EQUALS_SIGN");
  });

  test("build rejects duplicate --param keys", () => {
    const result = runCli([
      "build",
      "--non-interactive",
      "--job-url",
      "https://jenkins.example.com/job/api",
      "--param",
      "KEY=a",
      "--param",
      "KEY=b",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Duplicate --param key "KEY".');
  });

  test("cancel rejects a malformed --build-url", () => {
    const result = runCli([
      "cancel",
      "--non-interactive",
      "--build-url",
      "not-a-url",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Invalid --build-url value.");
  });

  test("update rejects conflicting --check and --enable-auto flags", () => {
    const result = runCli([
      "update",
      "--check",
      "--enable-auto",
      "--non-interactive",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("mutually exclusive");
  });
});

describe("parseBuildCustomParams", () => {
  test("returns undefined for empty input", () => {
    expect(parseBuildCustomParams([])).toBeUndefined();
    expect(parseBuildCustomParams(undefined)).toBeUndefined();
  });

  test("parses multiple KEY=VALUE entries", () => {
    expect(parseBuildCustomParams(["FOO=bar", "BAZ=qux"])).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  test("throws a CliError when a param entry is not a string", () => {
    try {
      parseBuildCustomParams(["DEPLOY_ENV=staging", 42]);
      throw new Error("Expected parseBuildCustomParams to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBe("Invalid --param value.");
      expect((error as CliError).hints).toContain(
        "Expected each --param entry to be a string in KEY=VALUE format.",
      );
      expect((error as CliError).hints).toContain(
        "Use --param KEY=VALUE (example: --param DEPLOY_ENV=staging).",
      );
    }
  });

  test("throws a CliError when a param entry is missing an equals sign", () => {
    try {
      parseBuildCustomParams(["INVALID"]);
      throw new Error("Expected parseBuildCustomParams to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBe("Invalid --param value.");
      expect((error as CliError).hints).toEqual([
        "Use --param KEY=VALUE (example: --param DEPLOY_ENV=staging).",
      ]);
    }
  });

  test("throws a CliError when duplicate keys are provided", () => {
    try {
      parseBuildCustomParams(["KEY=a", "KEY=b"]);
      throw new Error("Expected parseBuildCustomParams to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBe('Duplicate --param key "KEY".');
      expect((error as CliError).hints).toEqual([
        "Use unique parameter names when passing --param multiple times.",
      ]);
    }
  });

  test("allows empty values", () => {
    expect(parseBuildCustomParams(["EMPTY="])).toEqual({
      EMPTY: "",
    });
  });
});
