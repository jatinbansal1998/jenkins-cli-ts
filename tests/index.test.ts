import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("cli default command", () => {
  test("defaults to list flow when no command is provided", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));

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
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("migrates legacy config during normal command execution", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));
    const configDir = join(tempHome, ".config", "jenkins-cli");
    const configPath = join(configDir, "jenkins-cli-config.json");

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
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

      const migratedConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
        version?: number;
        defaultProfile?: string;
        profiles?: Record<string, unknown>;
      };
      expect(migratedConfig.version).toBe(2);
      expect(migratedConfig.defaultProfile).toBe("default");
      expect(migratedConfig.profiles?.default).toBeDefined();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("does not fallback to legacy global cache file", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "jenkins-cli-home-"));
    const cacheDir = join(tempHome, "Library", "Caches", "jenkins-cli");
    const legacyCachePath = join(cacheDir, "jobs.json");

    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
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
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
