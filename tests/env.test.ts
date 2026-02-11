import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const existsSyncMock = mock(() => false);
const readFileSyncMock = mock(() => "{}");
const mkdirSyncMock = mock(() => undefined);
const writeFileSyncMock = mock(() => undefined);
const chmodSyncMock = mock(() => undefined);

mock.module("node:fs", () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    mkdirSync: mkdirSyncMock,
    writeFileSync: writeFileSyncMock,
    chmodSync: chmodSyncMock,
  },
}));

const { loadEnv } = await import("../src/env");

const originalEnv = {
  JENKINS_URL: process.env.JENKINS_URL,
  JENKINS_USER: process.env.JENKINS_USER,
  JENKINS_API_TOKEN: process.env.JENKINS_API_TOKEN,
  JENKINS_BRANCH_PARAM: process.env.JENKINS_BRANCH_PARAM,
  JENKINS_USE_CRUMB: process.env.JENKINS_USE_CRUMB,
};

function setRequiredEnv(): void {
  process.env.JENKINS_URL = "https://jenkins.example.com";
  process.env.JENKINS_USER = "user";
  process.env.JENKINS_API_TOKEN = "token";
}

beforeEach(() => {
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
  readFileSyncMock.mockReset();
  readFileSyncMock.mockReturnValue("{}");
  mkdirSyncMock.mockReset();
  mkdirSyncMock.mockImplementation(() => undefined);
  writeFileSyncMock.mockReset();
  writeFileSyncMock.mockImplementation(() => undefined);
  chmodSyncMock.mockReset();
  chmodSyncMock.mockImplementation(() => undefined);

  setRequiredEnv();
  delete process.env.JENKINS_BRANCH_PARAM;
  delete process.env.JENKINS_USE_CRUMB;
});

afterAll(() => {
  process.env.JENKINS_URL = originalEnv.JENKINS_URL;
  process.env.JENKINS_USER = originalEnv.JENKINS_USER;
  process.env.JENKINS_API_TOKEN = originalEnv.JENKINS_API_TOKEN;
  process.env.JENKINS_BRANCH_PARAM = originalEnv.JENKINS_BRANCH_PARAM;
  process.env.JENKINS_USE_CRUMB = originalEnv.JENKINS_USE_CRUMB;
});

describe("loadEnv useCrumb parsing", () => {
  test("defaults useCrumb to false", () => {
    const env = loadEnv();
    expect(env.useCrumb).toBeFalse();
  });

  test("reads useCrumb=true from config", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        defaultProfile: "default",
        profiles: {
          default: {
            jenkinsUrl: "https://config-jenkins.example.com",
            jenkinsUser: "config-user",
            jenkinsApiToken: "config-token",
            useCrumb: true,
          },
        },
      }),
    );

    const env = loadEnv();
    expect(env.useCrumb).toBeTrue();
  });

  test("reads JENKINS_USE_CRUMB boolean value from config", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        JENKINS_URL: "https://legacy-jenkins.example.com",
        JENKINS_USER: "legacy-user",
        JENKINS_API_TOKEN: "legacy-token",
        JENKINS_USE_CRUMB: true,
      }),
    );

    const env = loadEnv();
    expect(env.useCrumb).toBeTrue();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  test("env value overrides config value", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        defaultProfile: "default",
        profiles: {
          default: {
            jenkinsUrl: "https://config-jenkins.example.com",
            jenkinsUser: "config-user",
            jenkinsApiToken: "config-token",
            useCrumb: false,
          },
        },
      }),
    );
    process.env.JENKINS_USE_CRUMB = "true";

    const env = loadEnv();
    expect(env.useCrumb).toBeTrue();
  });

  test("parses env string variants", () => {
    const truthy = ["true", "TRUE"];
    const falsy = ["false", "FALSE", "1", "0", "random-value", ""];

    for (const value of truthy) {
      process.env.JENKINS_USE_CRUMB = value;
      expect(loadEnv().useCrumb).toBeTrue();
    }
    for (const value of falsy) {
      process.env.JENKINS_USE_CRUMB = value;
      expect(loadEnv().useCrumb).toBeFalse();
    }
  });

  test("uses default profile and ignores env credentials", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        defaultProfile: "work",
        profiles: {
          work: {
            jenkinsUrl: "https://work-jenkins.example.com",
            jenkinsUser: "work-user",
            jenkinsApiToken: "work-token",
          },
        },
      }),
    );

    process.env.JENKINS_URL = "https://env-jenkins.example.com";
    process.env.JENKINS_USER = "env-user";
    process.env.JENKINS_API_TOKEN = "env-token";

    const env = loadEnv();
    expect(env.jenkinsUrl).toBe("https://work-jenkins.example.com");
    expect(env.jenkinsUser).toBe("work-user");
    expect(env.jenkinsApiToken).toBe("work-token");
    expect(env.profileName).toBe("work");
  });

  test("uses explicit profile and ignores env credentials", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
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
      }),
    );

    process.env.JENKINS_URL = "https://env-jenkins.example.com";
    process.env.JENKINS_USER = "env-user";
    process.env.JENKINS_API_TOKEN = "env-token";

    const env = loadEnv({ profile: "prod" });
    expect(env.jenkinsUrl).toBe("https://prod-jenkins.example.com");
    expect(env.jenkinsUser).toBe("prod-user");
    expect(env.jenkinsApiToken).toBe("prod-token");
    expect(env.profileName).toBe("prod");
  });
});
