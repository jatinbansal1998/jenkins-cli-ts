import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import fs from "node:fs";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/api-wrapper";
import type { JenkinsJob } from "../src/types/jenkins";

const realFsPromises = await import("node:fs/promises");
const realOs = await import("node:os");

const files = new Map<string, string>();
const tempHome = "/tmp/jenkins-cli-cache-tests";

const mkdirMock = mock(fs.promises.mkdir);
const renameMock = mock(async (fromPath: string, toPath: string) => {
  const value = files.get(fromPath);
  if (value === undefined) {
    throw createErrno("ENOENT");
  }
  files.set(toPath, value);
  files.delete(fromPath);
});
const rmMock = mock(async (filePath: string) => {
  files.delete(filePath);
});

mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  mkdir: mkdirMock,
  rename: renameMock,
  rm: rmMock,
}));

mock.module("node:os", () => ({
  ...realOs,
  homedir: () => tempHome,
}));

const jobsModule = await import("../src/jobs");

const env = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
} satisfies Pick<EnvConfig, "jenkinsUrl" | "jenkinsUser">;

const loadEnv: EnvConfig = {
  ...env,
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
};

const realBunFile = Bun.file;
const bunFileSpy = spyOn(Bun, "file");

describe("job cache refresh", () => {
  beforeEach(() => {
    files.clear();
    mock.clearAllMocks();
    bunFileSpy.mockImplementation(((filePath: string | URL) => {
      const resolvedPath =
        typeof filePath === "string" ? filePath : filePath.toString();
      return {
        text: async () => {
          const value = files.get(resolvedPath);
          if (value !== undefined) {
            return value;
          }
          throw createErrno("ENOENT");
        },
        write: async (data: string) => {
          files.set(resolvedPath, data);
          return data.length;
        },
      } as Bun.BunFile;
    }) as typeof Bun.file);

    mkdirMock.mockImplementation(async () => undefined);
    renameMock.mockImplementation(async (fromPath: string, toPath: string) => {
      const value = files.get(fromPath);
      if (value === undefined) {
        throw createErrno("ENOENT");
      }
      files.set(toPath, value);
      files.delete(fromPath);
    });
    rmMock.mockImplementation(async (filePath: string) => {
      files.delete(filePath);
    });
  });

  afterEach(() => {
    // Reset leaked module mocks back to the real fs so later test files that
    // import node:fs/promises do not inherit our in-memory cache shim.
    mkdirMock.mockImplementation(fs.promises.mkdir);
    renameMock.mockImplementation(fs.promises.rename);
    rmMock.mockImplementation(fs.promises.rm);
    bunFileSpy.mockImplementation(realBunFile);
    files.clear();
  });

  test("refresh replaces removed jobs and trims stale recent entries", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    files.set(
      cachePath,
      JSON.stringify({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        fetchedAt: "2026-02-12T00:00:00.000Z",
        jobs: [
          {
            name: "keep",
            url: "https://jenkins.example.com/job/keep",
            branches: ["release", "main"],
          },
          {
            name: "removed",
            url: "https://jenkins.example.com/job/removed",
            branches: ["old-branch"],
          },
        ],
        recentJobs: [
          "https://jenkins.example.com/job/keep",
          "https://jenkins.example.com/job/removed",
        ],
      }),
    );

    const refreshedJobs: JenkinsJob[] = [
      { name: "keep", url: "https://jenkins.example.com/job/keep" },
      { name: "fresh", url: "https://jenkins.example.com/job/fresh" },
    ];

    const result = await jobsModule.loadJobs({
      client: {
        listJobs: mock(async () => refreshedJobs),
      } as unknown as JenkinsClient,
      env: loadEnv,
      refresh: true,
      nonInteractive: true,
    });

    expect(result).toEqual(refreshedJobs);

    const cache = await jobsModule.readJobCache(env);
    expect(cache).not.toBeNull();
    expect(cache?.jobs).toEqual([
      {
        name: "keep",
        url: "https://jenkins.example.com/job/keep",
        branches: ["release", "main"],
      },
      {
        name: "fresh",
        url: "https://jenkins.example.com/job/fresh",
      },
    ]);
    expect(cache?.recentJobs).toEqual(["https://jenkins.example.com/job/keep"]);
  });

  test("refresh canonicalizes trailing slashes in recent jobs before dedupe", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    files.set(
      cachePath,
      JSON.stringify({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        fetchedAt: "2026-02-12T00:00:00.000Z",
        jobs: [{ name: "keep", url: "https://jenkins.example.com/job/keep" }],
        recentJobs: [
          "https://jenkins.example.com/job/keep/",
          " https://jenkins.example.com/job/keep ",
        ],
      }),
    );

    const refreshedJobs: JenkinsJob[] = [
      { name: "keep", url: "https://jenkins.example.com/job/keep" },
    ];

    const result = await jobsModule.loadJobs({
      client: {
        listJobs: mock(async () => refreshedJobs),
      } as unknown as JenkinsClient,
      env: loadEnv,
      refresh: true,
      nonInteractive: true,
    });

    expect(result).toEqual(refreshedJobs);

    const cache = await jobsModule.readJobCache(env);
    expect(cache).not.toBeNull();
    expect(cache?.recentJobs).toEqual(["https://jenkins.example.com/job/keep"]);
  });

  test("refresh keeps recent jobs when live job URLs only differ by trailing slash", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    files.set(
      cachePath,
      JSON.stringify({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        fetchedAt: "2026-02-12T00:00:00.000Z",
        jobs: [{ name: "keep", url: "https://jenkins.example.com/job/keep" }],
        recentJobs: ["https://jenkins.example.com/job/keep"],
      }),
    );

    const refreshedJobs: JenkinsJob[] = [
      { name: "keep", url: " https://jenkins.example.com/job/keep/ " },
    ];

    const result = await jobsModule.loadJobs({
      client: {
        listJobs: mock(async () => refreshedJobs),
      } as unknown as JenkinsClient,
      env,
      refresh: true,
      nonInteractive: true,
    });

    expect(result).toEqual(refreshedJobs);

    const cache = await jobsModule.readJobCache(env);
    expect(cache).not.toBeNull();
    expect(cache?.recentJobs).toEqual(["https://jenkins.example.com/job/keep"]);
  });

  test("failed cache write preserves the existing cache", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    const previousCache = JSON.stringify({
      jenkinsUrl: env.jenkinsUrl,
      user: env.jenkinsUser,
      fetchedAt: "2026-02-12T00:00:00.000Z",
      jobs: [
        { name: "existing", url: "https://jenkins.example.com/job/existing" },
      ],
    });
    files.set(cachePath, previousCache);

    renameMock.mockImplementation(async (fromPath: string, toPath: string) => {
      if (toPath === cachePath) {
        throw createErrno("EIO", "rename failed");
      }
      const value = files.get(fromPath);
      if (value === undefined) {
        throw createErrno("ENOENT");
      }
      files.set(toPath, value);
      files.delete(fromPath);
    });

    await expect(
      jobsModule.loadJobs({
        client: {
          listJobs: mock(async () => [
            { name: "fresh", url: "https://jenkins.example.com/job/fresh" },
          ]),
        } as unknown as JenkinsClient,
        env: loadEnv,
        refresh: true,
        nonInteractive: true,
      }),
    ).rejects.toThrow("rename failed");

    expect(files.get(cachePath)).toBe(previousCache);
    expect([...files.keys()]).toEqual([cachePath]);

    const cache = await jobsModule.readJobCache(env);
    expect(cache?.jobs).toEqual([
      { name: "existing", url: "https://jenkins.example.com/job/existing" },
    ]);
  });
});

function createErrno(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
