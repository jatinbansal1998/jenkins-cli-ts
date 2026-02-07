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

    expect(payload.useCrumb).toBeTrue();
    expect(payload.debug).toBeFalse();
    expect(payload.jenkinsUrl).toBe("https://jenkins.example.com");
    expect(payload.jenkinsUser).toBe("user");
    expect(payload.jenkinsApiToken).toBe("token");
    expect(payload.branchParam).toBe("BRANCH");
  });

  test("supports legacy key formats when preserving settings", async () => {
    readFileMock.mockImplementation(async () =>
      JSON.stringify({
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

    expect(payload.useCrumb).toBeFalse();
    expect(payload.debug).toBeFalse();
  });
});
