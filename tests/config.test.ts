import { beforeEach, describe, expect, mock, test } from "bun:test";

const mkdirMock = mock(async () => undefined);
const writeFileMock = mock(async (..._args: unknown[]) => undefined);
const chmodMock = mock(async () => undefined);
const readFileMock = mock(async (): Promise<string> => {
  throw new Error("missing");
});

mock.module("node:fs/promises", () => ({
  chmod: chmodMock,
  mkdir: mkdirMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
}));

const { writeConfigFile } = await import("../src/config");

beforeEach(() => {
  mock.clearAllMocks();
  mkdirMock.mockImplementation(async () => undefined);
  writeFileMock.mockImplementation(async () => undefined);
  chmodMock.mockImplementation(async () => undefined);
  readFileMock.mockImplementation(async () => {
    throw new Error("missing");
  });
});

describe("writeConfigFile", () => {
  test("preserves useCrumb and debug from existing config", async () => {
    readFileMock.mockImplementation(async () =>
      JSON.stringify({
        jenkinsUrl: "https://old-jenkins.example.com",
        jenkinsUser: "old-user",
        jenkinsApiToken: "old-token",
        useCrumb: true,
        debug: false,
      }),
    );

    await writeConfigFile({
      jenkinsUrl: "https://jenkins.example.com",
      jenkinsUser: "user",
      jenkinsApiToken: "token",
      branchParam: "BRANCH",
    });

    const writeCall = writeFileMock.mock.calls[0];
    expect(writeCall).toBeDefined();
    if (!writeCall) {
      throw new Error("Expected writeFile to be called.");
    }
    const payload = JSON.parse(String(writeCall[1]));

    expect(payload.defaultProfile).toBe("default");
    expect(payload.profiles.default.useCrumb).toBeTrue();
    expect(payload.debug).toBeFalse();
    expect(payload.profiles.default.jenkinsUrl).toBe(
      "https://jenkins.example.com",
    );
    expect(payload.profiles.default.jenkinsUser).toBe("user");
    expect(payload.profiles.default.jenkinsApiToken).toBe("token");
    expect(payload.profiles.default.branchParam).toBe("BRANCH");
  });

  test("supports legacy key formats when preserving settings", async () => {
    readFileMock.mockImplementation(async () =>
      JSON.stringify({
        JENKINS_URL: "https://old-jenkins.example.com",
        JENKINS_USER: "old-user",
        JENKINS_API_TOKEN: "old-token",
        JENKINS_USE_CRUMB: true,
        JENKINS_DEBUG: "true",
      }),
    );

    await writeConfigFile({
      jenkinsUrl: "https://jenkins.example.com",
      jenkinsUser: "user",
      jenkinsApiToken: "token",
      useCrumb: false,
      debug: false,
    });

    const writeCall = writeFileMock.mock.calls[0];
    expect(writeCall).toBeDefined();
    if (!writeCall) {
      throw new Error("Expected writeFile to be called.");
    }
    const payload = JSON.parse(String(writeCall[1]));

    expect(payload.profiles.default.useCrumb).toBeFalse();
    expect(payload.debug).toBeFalse();
  });
});
