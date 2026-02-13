import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
