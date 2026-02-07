import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const existsSyncMock = mock(() => false);
const readFileSyncMock = mock(() => "{}");

mock.module("node:fs", () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
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
    readFileSyncMock.mockReturnValue(JSON.stringify({ useCrumb: true }));

    const env = loadEnv();
    expect(env.useCrumb).toBeTrue();
  });

  test("reads JENKINS_USE_CRUMB boolean value from config", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ JENKINS_USE_CRUMB: true }),
    );

    const env = loadEnv();
    expect(env.useCrumb).toBeTrue();
  });

  test("env value overrides config value", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({ useCrumb: false }));
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
});
