import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

const realFsPromises = await import("node:fs/promises");
const mkdirMock = mock(async () => undefined);
const chmodMock = mock(async () => undefined);

// Capture the real functions before mock.module replaces the namespace.
const realRename = realFsPromises.rename.bind(realFsPromises);
const realRm = realFsPromises.rm.bind(realFsPromises);

const fileContents = new Map<string, string>();

async function renameInMemoryOrReal(fromPath: string, toPath: string) {
  const value = fileContents.get(fromPath);
  if (value !== undefined) {
    fileContents.set(toPath, value);
    fileContents.delete(fromPath);
    return;
  }
  return await realRename(fromPath, toPath);
}

async function rmInMemoryOrReal(
  filePath: string,
  options?: Parameters<typeof realFsPromises.rm>[1],
) {
  if (fileContents.has(filePath)) {
    fileContents.delete(filePath);
    return;
  }
  return await realRm(filePath, options);
}

const renameMock = mock(renameInMemoryOrReal);
const rmMock = mock(rmInMemoryOrReal);

mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  chmod: chmodMock,
  mkdir: mkdirMock,
  rename: renameMock,
  rm: rmMock,
}));

const { CONFIG_FILE, KEYCHAIN_TOKEN_SENTINEL, readConfig, writeConfigFile } =
  await import("../src/config");
const realBunFile = Bun.file;
const bunFileSpy = spyOn(Bun, "file");

beforeEach(() => {
  mkdirMock.mockImplementation(async () => undefined);
  chmodMock.mockImplementation(async () => undefined);
  renameMock.mockImplementation(renameInMemoryOrReal);
  rmMock.mockImplementation(rmInMemoryOrReal);
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

describe("tokenStorage persistence", () => {
  test("writes the keychain sentinel and tokenStorage flag", async () => {
    await writeConfigFile({
      profile: "work",
      jenkinsUrl: "https://jenkins.example.com",
      jenkinsUser: "user",
      jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
      tokenStorage: "keychain",
    });

    const payload = JSON.parse(fileContents.get(CONFIG_FILE) ?? "");
    expect(payload.profiles.work.tokenStorage).toBe("keychain");
    expect(payload.profiles.work.jenkinsApiToken).toBe(KEYCHAIN_TOKEN_SENTINEL);
  });

  test("omits tokenStorage for plaintext profiles", async () => {
    await writeConfigFile({
      profile: "work",
      jenkinsUrl: "https://jenkins.example.com",
      jenkinsUser: "user",
      jenkinsApiToken: "plain-token",
    });

    const payload = JSON.parse(fileContents.get(CONFIG_FILE) ?? "");
    expect(payload.profiles.work.tokenStorage).toBeUndefined();
    expect(payload.profiles.work.jenkinsApiToken).toBe("plain-token");
  });

  test("re-login to plaintext drops a previous keychain flag", async () => {
    fileContents.set(
      CONFIG_FILE,
      JSON.stringify({
        version: 2,
        defaultProfile: "work",
        profiles: {
          work: {
            jenkinsUrl: "https://jenkins.example.com",
            jenkinsUser: "user",
            jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
            tokenStorage: "keychain",
          },
        },
      }),
    );

    // writeConfigFile rebuilds the profile from input only, so passing no
    // tokenStorage clears the keychain flag.
    await writeConfigFile({
      profile: "work",
      jenkinsUrl: "https://jenkins.example.com",
      jenkinsUser: "user",
      jenkinsApiToken: "fresh-plaintext",
    });

    const payload = JSON.parse(fileContents.get(CONFIG_FILE) ?? "");
    expect(payload.profiles.work.tokenStorage).toBeUndefined();
    expect(payload.profiles.work.jenkinsApiToken).toBe("fresh-plaintext");
  });

  test("readConfig parses the tokenStorage flag", async () => {
    fileContents.set(
      CONFIG_FILE,
      JSON.stringify({
        version: 2,
        defaultProfile: "work",
        profiles: {
          work: {
            jenkinsUrl: "https://jenkins.example.com",
            jenkinsUser: "user",
            jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
            tokenStorage: "keychain",
          },
        },
      }),
    );

    const loaded = await readConfig();
    expect(loaded?.config.profiles.work?.tokenStorage).toBe("keychain");
  });
});
