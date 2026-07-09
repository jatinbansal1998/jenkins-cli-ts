import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeUrl } from "../src/env";

type LoadEnvResult = {
  ok: boolean;
  env?: {
    jenkinsUrl: string;
    jenkinsUser: string;
    jenkinsApiToken: string;
    profileName?: string;
    branchParamDefault: string;
    useCrumb: boolean;
    folderDepth: number;
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
  options?: {
    profile?: string;
    url?: string;
    user?: string;
    apiToken?: string;
  };
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
      JENKINS_USE_CRUMB: undefined,
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

describe("normalizeUrl", () => {
  test("strips trailing slashes", () => {
    expect(normalizeUrl("https://jenkins.example.com/")).toBe(
      "https://jenkins.example.com",
    );
    expect(normalizeUrl("https://jenkins.example.com///")).toBe(
      "https://jenkins.example.com",
    );
    expect(normalizeUrl("https://jenkins.example.com/jenkins/")).toBe(
      "https://jenkins.example.com/jenkins",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeUrl("  https://jenkins.example.com  ")).toBe(
      "https://jenkins.example.com",
    );
  });

  test("preserves port and path", () => {
    expect(normalizeUrl("http://jenkins.example.com:8080/ci")).toBe(
      "http://jenkins.example.com:8080/ci",
    );
  });

  test("rejects malformed URLs", () => {
    expect(() => normalizeUrl("not a url")).toThrow("Invalid JENKINS_URL.");
    expect(() => normalizeUrl("")).toThrow("Invalid JENKINS_URL.");
    expect(() => normalizeUrl("jenkins.example.com")).toThrow(
      "Invalid JENKINS_URL.",
    );
  });

  test("rejects non-http(s) protocols", () => {
    expect(() => normalizeUrl("ftp://jenkins.example.com")).toThrow(
      "Invalid JENKINS_URL protocol.",
    );
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(
      "Invalid JENKINS_URL protocol.",
    );
  });
});

describe("loadEnv credential sources", () => {
  test("complete CLI credentials override the default profile", () => {
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
        options: {
          url: "https://cli-jenkins.example.com/",
          user: "cli-user",
          apiToken: "cli-token",
        },
      });

      expect(result.exitCode).toBe(0);
      // Trailing slash must be normalized away.
      expect(result.payload.env?.jenkinsUrl).toBe(
        "https://cli-jenkins.example.com",
      );
      expect(result.payload.env?.jenkinsUser).toBe("cli-user");
      expect(result.payload.env?.jenkinsApiToken).toBe("cli-token");
      expect(result.payload.env?.profileName).toBeUndefined();
    });
  });

  test("partial CLI credentials fail fast", () => {
    withTempHome((homeDir) => {
      const partials = [
        { url: "https://cli-jenkins.example.com" },
        { user: "cli-user" },
        { url: "https://cli-jenkins.example.com", apiToken: "cli-token" },
      ];
      for (const options of partials) {
        const result = runLoadEnv({ homeDir, options });
        expect(result.exitCode).toBe(1);
        expect(result.payload.ok).toBeFalse();
        expect(result.payload.message).toBe(
          "Incomplete Jenkins CLI credentials.",
        );
      }
    });
  });

  test("unknown requested profile fails even when env credentials exist", () => {
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

      const result = runLoadEnv({ homeDir, options: { profile: "missing" } });
      expect(result.exitCode).toBe(1);
      expect(result.payload.message).toBe('Profile "missing" was not found.');
    });
  });

  test("requested profile without any config file fails", () => {
    withTempHome((homeDir) => {
      const result = runLoadEnv({ homeDir, options: { profile: "missing" } });
      expect(result.exitCode).toBe(1);
      expect(result.payload.message).toBe('Profile "missing" was not found.');
    });
  });

  test("missing or blank env credentials produce targeted errors", () => {
    withTempHome((homeDir) => {
      const cases: Array<{
        env: Record<string, string>;
        message: string;
      }> = [
        { env: { JENKINS_URL: "" }, message: "Missing JENKINS_URL." },
        { env: { JENKINS_URL: "   " }, message: "Missing JENKINS_URL." },
        { env: { JENKINS_USER: "" }, message: "Missing JENKINS_USER." },
        {
          env: { JENKINS_API_TOKEN: "   " },
          message: "Missing JENKINS_API_TOKEN.",
        },
      ];
      for (const testCase of cases) {
        const result = runLoadEnv({ homeDir, env: testCase.env });
        expect(result.exitCode).toBe(1);
        expect(result.payload.message).toBe(testCase.message);
      }
    });
  });

  test("env credentials are trimmed", () => {
    withTempHome((homeDir) => {
      const result = runLoadEnv({
        homeDir,
        env: {
          JENKINS_USER: "  padded-user  ",
          JENKINS_API_TOKEN: "  padded-token  ",
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.jenkinsUser).toBe("padded-user");
      expect(result.payload.env?.jenkinsApiToken).toBe("padded-token");
    });
  });
});

describe("loadEnv branchParam and folderDepth resolution", () => {
  const profileConfig = {
    defaultProfile: "work",
    profiles: {
      work: {
        jenkinsUrl: "https://work-jenkins.example.com",
        jenkinsUser: "work-user",
        jenkinsApiToken: "work-token",
        branchParam: "PROFILE_BRANCH",
        folderDepth: 5,
      },
    },
  };

  test("JENKINS_BRANCH_PARAM env var beats profile branchParam", () => {
    withTempHome((homeDir) => {
      writeConfig(homeDir, profileConfig);
      const result = runLoadEnv({
        homeDir,
        env: { JENKINS_BRANCH_PARAM: "GIT_BRANCH" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.branchParamDefault).toBe("GIT_BRANCH");
    });
  });

  test("profile branchParam beats built-in default", () => {
    withTempHome((homeDir) => {
      writeConfig(homeDir, profileConfig);
      const result = runLoadEnv({
        homeDir,
        env: { JENKINS_BRANCH_PARAM: "" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.branchParamDefault).toBe("PROFILE_BRANCH");
    });
  });

  test("falls back to BRANCH when nothing is configured", () => {
    withTempHome((homeDir) => {
      const result = runLoadEnv({
        homeDir,
        env: { JENKINS_BRANCH_PARAM: "" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.payload.env?.branchParamDefault).toBe("BRANCH");
    });
  });

  test("profile folderDepth is honored and defaults to 3 otherwise", () => {
    withTempHome((homeDir) => {
      writeConfig(homeDir, profileConfig);
      const profileResult = runLoadEnv({ homeDir });
      expect(profileResult.payload.env?.folderDepth).toBe(5);
    });

    withTempHome((homeDir) => {
      const envResult = runLoadEnv({ homeDir });
      expect(envResult.payload.env?.folderDepth).toBe(3);
    });
  });
});
