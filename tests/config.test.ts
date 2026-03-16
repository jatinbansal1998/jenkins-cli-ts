import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

const mkdirMock = mock(async () => undefined);
const chmodMock = mock(async () => undefined);

mock.module("node:fs/promises", () => ({
  chmod: chmodMock,
  mkdir: mkdirMock,
}));

const { CONFIG_FILE, writeConfigFile } = await import("../src/config");
const realBunFile = Bun.file;
const bunFileSpy = spyOn(Bun, "file");
const fileContents = new Map<string, string>();

beforeEach(() => {
  mock.clearAllMocks();
  mkdirMock.mockImplementation(async () => undefined);
  chmodMock.mockImplementation(async () => undefined);
  fileContents.clear();
  bunFileSpy.mockImplementation(((filePath: string | URL) => {
    const resolvedPath =
      typeof filePath === "string" ? filePath : filePath.toString();
    return {
      text: async () => {
        const value = fileContents.get(resolvedPath);
        if (value !== undefined) {
          return value;
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      write: async (data: string) => {
        fileContents.set(resolvedPath, data);
        return data.length;
      },
    } as Bun.BunFile;
  }) as typeof Bun.file);
});

afterEach(() => {
  bunFileSpy.mockImplementation(realBunFile);
  fileContents.clear();
});

describe("writeConfigFile", () => {
  test("preserves useCrumb, debug, and analyticsDisabled from existing config", async () => {
    fileContents.set(
      CONFIG_FILE,
      JSON.stringify({
        jenkinsUrl: "https://old-jenkins.example.com",
        jenkinsUser: "old-user",
        jenkinsApiToken: "old-token",
        useCrumb: true,
        debug: false,
        analyticsDisabled: true,
      }),
    );

    await writeConfigFile({
      jenkinsUrl: "https://jenkins.example.com",
      jenkinsUser: "user",
      jenkinsApiToken: "token",
      branchParam: "BRANCH",
    });

    const payload = JSON.parse(fileContents.get(CONFIG_FILE) ?? "");

    expect(payload.defaultProfile).toBe("default");
    expect(payload.profiles.default.useCrumb).toBeTrue();
    expect(payload.debug).toBeFalse();
    expect(payload.analyticsDisabled).toBeTrue();
    expect(payload.profiles.default.jenkinsUrl).toBe(
      "https://jenkins.example.com",
    );
    expect(payload.profiles.default.jenkinsUser).toBe("user");
    expect(payload.profiles.default.jenkinsApiToken).toBe("token");
    expect(payload.profiles.default.branchParam).toBe("BRANCH");
  });

  test("supports legacy key formats when preserving settings", async () => {
    fileContents.set(
      CONFIG_FILE,
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

    const payload = JSON.parse(fileContents.get(CONFIG_FILE) ?? "");

    expect(payload.profiles.default.useCrumb).toBeFalse();
    expect(payload.debug).toBeFalse();
  });
});
