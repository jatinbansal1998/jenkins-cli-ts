import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type LoadEnvResult = {
  ok: boolean;
  env?: {
    jenkinsUrl: string;
    jenkinsUser: string;
    jenkinsApiToken: string;
    profileName?: string;
    branchParamDefault: string;
    useCrumb: boolean;
  };
  message?: string;
};

const FIXTURE_PATH = join(process.cwd(), "tests", "helpers.load-env.ts");

function withTempHome(run: (homeDir: string) => void): void {
  const homeDir = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-env-"));
  try {
    run(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function writeConfig(homeDir: string, config: unknown): void {
  const configDir = join(homeDir, ".config", "jenkins-cli");
  const configPath = join(configDir, "jenkins-cli-config.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function runLoadEnv(params: {
  homeDir: string;
  env?: Record<string, string | undefined>;
  options?: { profile?: string };
}): { exitCode: number; payload: LoadEnvResult } {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", FIXTURE_PATH],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: params.homeDir,
      JENKINS_URL: "https://jenkins.example.com",
      JENKINS_USER: "user",
      JENKINS_API_TOKEN: "token",
      ...params.env,
      TEST_LOAD_ENV_OPTIONS: params.options
        ? JSON.stringify(params.options)
        : undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = new TextDecoder().decode(result.stdout).trim();
  return {
    exitCode: result.exitCode,
    payload: JSON.parse(output) as LoadEnvResult,
  };
}

describe("loadEnv useCrumb parsing", () => {
  test("defaults useCrumb to false", () => {
    withTempHome((homeDir) => {
      const result = runLoadEnv({ homeDir });
      expect(result.exitCode).toBe(0);
      expect(result.payload.ok).toBeTrue();
      expect(result.payload.env?.useCrumb).toBeFalse();
    });
  });

  test("reads useCrumb=true from config", () => {
    withTempHome((homeDir) => {
      writeConfig(homeDir, {
        defaultProfile: "default",
        profiles: {
          default: {
            jenkinsUrl: "https://config-jenkins.example.com",
            jenkinsUser: "config-user",
            jenkinsApiToken: "config-token",
            useCrumb: true,
          },
        },
      });

      const result = runLoadEnv({ homeDir });
      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.useCrumb).toBeTrue();
    });
  });

  test("reads JENKINS_USE_CRUMB boolean value from config", () => {
    withTempHome((homeDir) => {
      writeConfig(homeDir, {
        JENKINS_URL: "https://legacy-jenkins.example.com",
        JENKINS_USER: "legacy-user",
        JENKINS_API_TOKEN: "legacy-token",
        JENKINS_USE_CRUMB: true,
      });

      const result = runLoadEnv({ homeDir });
      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.useCrumb).toBeTrue();

      const migrated = JSON.parse(
        fs.readFileSync(
          join(homeDir, ".config", "jenkins-cli", "jenkins-cli-config.json"),
          "utf8",
        ),
      ) as {
        version?: number;
      };
      expect(migrated.version).toBe(2);
    });
  });

  test("env value overrides config value", () => {
    withTempHome((homeDir) => {
      writeConfig(homeDir, {
        defaultProfile: "default",
        profiles: {
          default: {
            jenkinsUrl: "https://config-jenkins.example.com",
            jenkinsUser: "config-user",
            jenkinsApiToken: "config-token",
            useCrumb: false,
          },
        },
      });

      const result = runLoadEnv({
        homeDir,
        env: { JENKINS_USE_CRUMB: "true" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.useCrumb).toBeTrue();
    });
  });

  test("parses env string variants", () => {
    withTempHome((homeDir) => {
      const truthy = ["true", "TRUE"];
      const falsy = ["false", "FALSE", "1", "0", "random-value", ""];

      for (const value of truthy) {
        const result = runLoadEnv({
          homeDir,
          env: { JENKINS_USE_CRUMB: value },
        });
        expect(result.exitCode).toBe(0);
        expect(result.payload.env?.useCrumb).toBeTrue();
      }

      for (const value of falsy) {
        const result = runLoadEnv({
          homeDir,
          env: { JENKINS_USE_CRUMB: value },
        });
        expect(result.exitCode).toBe(0);
        expect(result.payload.env?.useCrumb).toBeFalse();
      }
    });
  });

  test("uses default profile and ignores env credentials", () => {
    withTempHome((homeDir) => {
      writeConfig(homeDir, {
        defaultProfile: "work",
        profiles: {
          work: {
            jenkinsUrl: "https://work-jenkins.example.com",
            jenkinsUser: "work-user",
            jenkinsApiToken: "work-token",
          },
        },
      });

      const result = runLoadEnv({
        homeDir,
        env: {
          JENKINS_URL: "https://env-jenkins.example.com",
          JENKINS_USER: "env-user",
          JENKINS_API_TOKEN: "env-token",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.jenkinsUrl).toBe(
        "https://work-jenkins.example.com",
      );
      expect(result.payload.env?.jenkinsUser).toBe("work-user");
      expect(result.payload.env?.jenkinsApiToken).toBe("work-token");
      expect(result.payload.env?.profileName).toBe("work");
    });
  });

  test("uses explicit profile and ignores env credentials", () => {
    withTempHome((homeDir) => {
      writeConfig(homeDir, {
        defaultProfile: "work",
        profiles: {
          work: {
            jenkinsUrl: "https://work-jenkins.example.com",
            jenkinsUser: "work-user",
            jenkinsApiToken: "work-token",
          },
          prod: {
            jenkinsUrl: "https://prod-jenkins.example.com",
            jenkinsUser: "prod-user",
            jenkinsApiToken: "prod-token",
          },
        },
      });

      const result = runLoadEnv({
        homeDir,
        options: { profile: "prod" },
        env: {
          JENKINS_URL: "https://env-jenkins.example.com",
          JENKINS_USER: "env-user",
          JENKINS_API_TOKEN: "env-token",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.jenkinsUrl).toBe(
        "https://prod-jenkins.example.com",
      );
      expect(result.payload.env?.jenkinsUser).toBe("prod-user");
      expect(result.payload.env?.jenkinsApiToken).toBe("prod-token");
      expect(result.payload.env?.profileName).toBe("prod");
    });
  });
});
