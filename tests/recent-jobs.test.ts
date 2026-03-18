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
import type { JenkinsJob } from "../src/types/jenkins";

const realFsPromises = await import("node:fs/promises");
const realOs = await import("node:os");

const files = new Map<string, string>();
const tempHome = "/tmp/jenkins-cli-recent-jobs-tests";

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

const jobsModule = await import("../src/jobs.ts");

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

const cachedJobs: JenkinsJob[] = [
  {
    name: "api",
    fullName: "platform/api",
    url: "https://jenkins.example.com/job/api/",
  },
  {
    name: "worker",
    fullName: "platform/worker",
    url: "https://jenkins.example.com/job/worker/",
  },
  {
    name: "zeta",
    fullName: "platform/zeta",
    url: "https://jenkins.example.com/job/zeta/",
  },
];

const realBunFile = Bun.file;
const bunFileSpy = spyOn(Bun, "file");

describe("recent jobs", () => {
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
    mkdirMock.mockImplementation(fs.promises.mkdir);
    renameMock.mockImplementation(fs.promises.rename);
    rmMock.mockImplementation(fs.promises.rm);
    bunFileSpy.mockImplementation(realBunFile);
    files.clear();
  });

  test("loadRecentJobs returns recent jobs in recency order", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    writeCacheFixture({
      jobs: cachedJobs,
      recentJobs: [
        " https://jenkins.example.com/job/api/ ",
        "https://jenkins.example.com/job/worker/",
      ],
    });

    const recentJobs = await recentJobsModule.loadRecentJobs({ env: loadEnv });

    expect(recentJobs).toEqual([
      {
        url: "https://jenkins.example.com/job/api",
        label: "platform/api",
      },
      {
        url: "https://jenkins.example.com/job/worker",
        label: "platform/worker",
      },
    ]);
  });

  test("recordRecentJob updates recency order", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    writeCacheFixture({
      jobs: cachedJobs,
      recentJobs: ["https://jenkins.example.com/job/worker"],
    });

    await recentJobsModule.recordRecentJob({
      env: loadEnv,
      jobUrl: "https://jenkins.example.com/job/api/",
    });

    const cache = await jobsModule.readJobCache(env);
    expect(cache?.recentJobs).toEqual([
      "https://jenkins.example.com/job/api",
      "https://jenkins.example.com/job/worker",
    ]);
  });

  test("recordRecentJob ignores cache write failures", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    writeCacheFixture({
      jobs: cachedJobs,
      recentJobs: ["https://jenkins.example.com/job/worker"],
    });

    spyOn(jobsModule, "writeJobCache").mockRejectedValue(
      new Error("disk full"),
    );

    await expect(
      recentJobsModule.recordRecentJob({
        env: loadEnv,
        jobUrl: "https://jenkins.example.com/job/api/",
      }),
    ).resolves.toBeUndefined();
  });

  test("loadPreferredJobs sorts recent jobs by recency", async () => {
    const recentJobsModule = await loadRecentJobsModule();
    writeCacheFixture({
      jobs: cachedJobs,
      recentJobs: [
        "https://jenkins.example.com/job/api",
        "https://jenkins.example.com/job/worker",
      ],
    });

    const orderedJobs = await recentJobsModule.loadPreferredJobs({
      env: loadEnv,
      jobs: [
        cachedJobs[2] as JenkinsJob,
        cachedJobs[0] as JenkinsJob,
        cachedJobs[1] as JenkinsJob,
      ],
    });

    expect(orderedJobs.map((job: JenkinsJob) => job.name)).toEqual([
      "api",
      "worker",
      "zeta",
    ]);
  });
});

function writeCacheFixture(data: {
  jobs: JenkinsJob[];
  recentJobs?: string[];
}): void {
  files.set(
    jobsModule.getJobCachePath(env.jenkinsUrl),
    JSON.stringify({
      jenkinsUrl: env.jenkinsUrl,
      user: env.jenkinsUser,
      fetchedAt: "2026-02-12T00:00:00.000Z",
      jobs: data.jobs,
      ...(data.recentJobs ? { recentJobs: data.recentJobs } : {}),
    }),
  );
}

async function loadRecentJobsModule() {
  return await import(
    `../src/recent-jobs.ts?recent-jobs-test=${crypto.randomUUID()}`
  );
}

function createErrno(code: string, message = code): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
