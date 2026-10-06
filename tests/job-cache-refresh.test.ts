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
import { CliError } from "../src/cli";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
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
const openMock = mock(exclusiveCreateOpen);

async function exclusiveCreateOpen(filePath: string, flags?: string) {
  if (flags !== "wx") {
    throw new Error(`unexpected open flags ${String(flags)}`);
  }
  if (files.has(filePath)) {
    throw createErrno("EEXIST");
  }
  files.set(filePath, "");
  return {
    writeFile: async (data: string) => {
      files.set(filePath, data);
    },
    close: async () => undefined,
  } as unknown as fs.promises.FileHandle;
}

void mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  mkdir: mkdirMock,
  open: openMock,
  rename: renameMock,
  rm: rmMock,
}));

void mock.module("node:os", () => ({
  ...realOs,
  homedir: () => tempHome,
}));

// Imported after mock.module so the module binds to the in-memory fs.
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
  folderDepth: 3,
  timeoutMs: 30_000,
  transportRetries: 2,
};

let bunFileSpy = spyOn(Bun, "file");

describe("job cache refresh", () => {
  beforeEach(() => {
    files.clear();
    bunFileSpy = spyOn(Bun, "file");
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
    openMock.mockImplementation(exclusiveCreateOpen);
  });

  afterEach(() => {
    // Restore the spy so subsequent test files get the real Bun.file back.
    bunFileSpy.mockRestore();
    // Reset leaked module mocks back to the real fs so later test files that
    // import node:fs/promises do not inherit our in-memory cache shim.
    mkdirMock.mockImplementation(fs.promises.mkdir);
    renameMock.mockImplementation(fs.promises.rename);
    rmMock.mockImplementation(fs.promises.rm);
    openMock.mockImplementation(fs.promises.open);
    files.clear();
  });

  test("stale cache is served immediately while a detached worker refreshes it", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    const lockPath = `${cachePath}.refreshing`;
    const cachedJobs: JenkinsJob[] = [
      { name: "keep", url: "https://jenkins.example.com/job/keep" },
    ];
    files.set(
      cachePath,
      JSON.stringify({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        folderDepth: loadEnv.folderDepth,
        fetchedAt: "2026-02-12T00:00:00.000Z",
        jobs: cachedJobs,
      }),
    );
    const listJobs = mock(async () => [] as JenkinsJob[]);
    const resolveApiToken = mock(async () => "test-token");
    const spawnDetached = mock(
      (_command: string[], _childEnv: Record<string, string>) => undefined,
    );
    const restore = jobsModule.setJobsDepsForTesting({ spawnDetached });
    const load = () =>
      jobsModule.loadJobs({
        client: { listJobs, resolveApiToken } as unknown as JenkinsClient,
        env: loadEnv,
      });

    try {
      expect(await load()).toEqual(cachedJobs);
      expect(listJobs).not.toHaveBeenCalled();
      expect(resolveApiToken).toHaveBeenCalledTimes(1);
      expect(spawnDetached).toHaveBeenCalledTimes(1);
      const [command, childEnv] = spawnDetached.mock.calls[0] ?? [];
      expect(command?.slice(-2)).toEqual([
        "refresh-job-cache",
        "--non-interactive",
      ]);
      expect(
        JSON.parse(childEnv?.[jobsModule.JOB_CACHE_REFRESH_ENV] ?? ""),
      ).toEqual({
        jenkinsUrl: env.jenkinsUrl,
        jenkinsUser: env.jenkinsUser,
        jenkinsApiToken: "test-token",
        useCrumb: false,
        folderDepth: 3,
        timeoutMs: 30_000,
        transportRetries: 2,
      });
      expect(files.has(lockPath)).toBe(true);
      // The claim must be an exclusive create, not check-then-write.
      expect(openMock).toHaveBeenCalledWith(lockPath, "wx");

      // A live lock means a worker is already running: no second spawn.
      expect(await load()).toEqual(cachedJobs);
      expect(spawnDetached).toHaveBeenCalledTimes(1);

      // An abandoned lock (worker died) must not block refreshes forever.
      files.set(lockPath, "2026-02-12T00:00:00.000Z");
      await load();
      expect(spawnDetached).toHaveBeenCalledTimes(2);

      await jobsModule.clearJobCacheRefreshLock(env.jenkinsUrl);
      expect(files.has(lockPath)).toBe(false);
    } finally {
      restore();
    }
  });

  test("fresh cache is served without resolving the API token", async () => {
    const cachedJobs: JenkinsJob[] = [
      { name: "keep", url: "https://jenkins.example.com/job/keep" },
    ];
    files.set(
      jobsModule.getJobCachePath(env.jenkinsUrl),
      JSON.stringify({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        folderDepth: loadEnv.folderDepth,
        fetchedAt: new Date().toISOString(),
        jobs: cachedJobs,
      }),
    );
    const listJobs = mock(async () => [] as JenkinsJob[]);
    const resolveApiToken = mock(async () => "test-token");

    const jobs = await jobsModule.loadJobs({
      client: { listJobs, resolveApiToken } as unknown as JenkinsClient,
      env: loadEnv,
    });

    expect(jobs).toEqual(cachedJobs);
    expect(listJobs).not.toHaveBeenCalled();
    expect(resolveApiToken).not.toHaveBeenCalled();
  });

  test("a failed token lookup surfaces and releases the refresh lock", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    const lockPath = `${cachePath}.refreshing`;
    files.set(
      cachePath,
      JSON.stringify({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        folderDepth: loadEnv.folderDepth,
        fetchedAt: "2026-02-12T00:00:00.000Z",
        jobs: [{ name: "keep", url: "https://jenkins.example.com/job/keep" }],
      }),
    );
    const tokenError = new CliError(
      "No Jenkins API token found.",
      [],
      "JENKINS_AUTH_ERROR",
    );
    const resolveApiToken = mock(async (): Promise<string> => {
      throw tokenError;
    });
    const spawnDetached = mock(
      (_command: string[], _childEnv: Record<string, string>) => undefined,
    );
    const restore = jobsModule.setJobsDepsForTesting({ spawnDetached });

    try {
      await expect(
        jobsModule.loadJobs({
          client: { resolveApiToken } as unknown as JenkinsClient,
          env: loadEnv,
        }),
      ).rejects.toBe(tokenError);
      expect(spawnDetached).not.toHaveBeenCalled();
      expect(files.has(lockPath)).toBe(false);
    } finally {
      restore();
    }
  });

  test("missing or mismatched cache is fetched synchronously without spawning", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    const liveJobs: JenkinsJob[] = [
      { name: "live", url: "https://jenkins.example.com/job/live" },
    ];
    const listJobs = mock(async () => liveJobs);
    const spawnDetached = mock(
      (_command: string[], _childEnv: Record<string, string>) => undefined,
    );
    const restore = jobsModule.setJobsDepsForTesting({ spawnDetached });
    const load = () =>
      jobsModule.loadJobs({
        client: { listJobs } as unknown as JenkinsClient,
        env: loadEnv,
      });

    try {
      expect(await load()).toEqual(liveJobs);
      expect(listJobs).toHaveBeenCalledTimes(1);
      expect((await jobsModule.readJobCache(env))?.jobs).toEqual(liveJobs);

      // Same URL and user but a different folder depth is not reusable.
      files.set(
        cachePath,
        JSON.stringify({
          jenkinsUrl: env.jenkinsUrl,
          user: env.jenkinsUser,
          folderDepth: 1,
          fetchedAt: new Date().toISOString(),
          jobs: [{ name: "shallow", url: "https://jenkins.example.com/job/s" }],
        }),
      );
      expect(await load()).toEqual(liveJobs);
      expect(listJobs).toHaveBeenCalledTimes(2);
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test("refresh replaces removed jobs and writes compact JSON", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    files.set(
      cachePath,
      JSON.stringify({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        folderDepth: loadEnv.folderDepth,
        fetchedAt: "2026-02-12T00:00:00.000Z",
        jobs: [
          { name: "keep", url: "https://jenkins.example.com/job/keep" },
          { name: "removed", url: "https://jenkins.example.com/job/removed" },
        ],
      }),
    );

    const refreshedJobs: JenkinsJob[] = [
      { name: "keep", url: " https://jenkins.example.com/job/keep/ " },
      { name: "fresh", url: "https://jenkins.example.com/job/fresh" },
    ];

    const result = await jobsModule.loadJobs({
      client: {
        listJobs: mock(async () => refreshedJobs),
      } as unknown as JenkinsClient,
      env: loadEnv,
      refresh: true,
    });

    expect(result).toEqual(refreshedJobs);
    expect(files.get(cachePath)).not.toContain("\n");

    const cache = await jobsModule.readJobCache(env);
    expect(cache?.jobs).toEqual([
      { name: "keep", url: "https://jenkins.example.com/job/keep" },
      { name: "fresh", url: "https://jenkins.example.com/job/fresh" },
    ]);
  });

  test("refresh persists activity metadata", async () => {
    const refreshedJobs: JenkinsJob[] = [
      {
        name: "keep",
        url: "https://jenkins.example.com/job/keep",
        disabled: false,
        lastBuild: {
          number: 12,
          url: "https://jenkins.example.com/job/keep/12/",
          result: "SUCCESS",
          building: false,
          timestampMs: 1767225600000,
        },
      },
      {
        name: "off",
        url: "https://jenkins.example.com/job/off",
        disabled: true,
        lastBuild: null,
      },
    ];

    await jobsModule.loadJobs({
      client: {
        listJobs: mock(async () => refreshedJobs),
      } as unknown as JenkinsClient,
      env: loadEnv,
      refresh: true,
    });

    const cache = await jobsModule.readJobCache(env);
    expect(cache?.jobs).toEqual(refreshedJobs);
  });

  test("legacy caches without activity metadata stay readable and malformed metadata is discarded", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    files.set(
      cachePath,
      JSON.stringify({
        jenkinsUrl: env.jenkinsUrl,
        user: env.jenkinsUser,
        folderDepth: loadEnv.folderDepth,
        fetchedAt: new Date().toISOString(),
        jobs: [
          { name: "legacy", url: "https://jenkins.example.com/job/legacy" },
          {
            name: "broken",
            url: "https://jenkins.example.com/job/broken",
            disabled: "yes",
            lastBuild: { result: "SUCCESS" },
          },
          {
            name: "never-built",
            url: "https://jenkins.example.com/job/never-built",
            disabled: false,
            lastBuild: null,
          },
        ],
      }),
    );

    const jobs = await jobsModule.loadJobs({
      client: {
        listJobs: mock(async () => {
          throw new Error("cache should be used without a Jenkins call");
        }),
      } as unknown as JenkinsClient,
      env: loadEnv,
    });

    expect(jobs).toEqual([
      { name: "legacy", url: "https://jenkins.example.com/job/legacy" },
      { name: "broken", url: "https://jenkins.example.com/job/broken" },
      {
        name: "never-built",
        url: "https://jenkins.example.com/job/never-built",
        disabled: false,
        lastBuild: null,
      },
    ]);
    expect(jobs[0]).not.toHaveProperty("lastBuild");
    expect(jobs[1]?.lastBuild).toBeUndefined();
    expect(jobs[1]?.disabled).toBeUndefined();
  });

  test("failed cache write preserves the existing cache", async () => {
    const cachePath = jobsModule.getJobCachePath(env.jenkinsUrl);
    const previousCache = JSON.stringify({
      jenkinsUrl: env.jenkinsUrl,
      user: env.jenkinsUser,
      folderDepth: loadEnv.folderDepth,
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
