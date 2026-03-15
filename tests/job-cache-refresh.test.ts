import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/api-wrapper";
import type { JenkinsJob } from "../src/types/jenkins";

const realFsPromises = await import("node:fs/promises");
const realOs = await import("node:os");

const files = new Map<string, string>();
const tempHome = "/tmp/jenkins-cli-cache-tests";

const mkdirMock = mock(async () => undefined);
const readFileMock = mock(async (filePath: string) => {
  const value = files.get(filePath);
  if (value !== undefined) {
    return value;
  }
  throw createErrno("ENOENT");
});
const writeFileMock = mock(async (filePath: string, data: string) => {
  files.set(filePath, data);
});
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
  readFile: readFileMock,
  rename: renameMock,
  rm: rmMock,
  writeFile: writeFileMock,
}));

mock.module("node:os", () => ({
  ...realOs,
  homedir: () => tempHome,
}));

const jobsModule = await import("../src/jobs");

const env = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
} as EnvConfig;

describe("job cache refresh", () => {
  beforeEach(() => {
    files.clear();
    mock.clearAllMocks();

    mkdirMock.mockImplementation(async () => undefined);
    readFileMock.mockImplementation(async (filePath: string) => {
      const value = files.get(filePath);
      if (value !== undefined) {
        return value;
      }
      throw createErrno("ENOENT");
    });
    writeFileMock.mockImplementation(async (filePath: string, data: string) => {
      files.set(filePath, data);
    });
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
    mock.restore();
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
      env,
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
        env,
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
