import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { JenkinsJob } from "../src/types/jenkins";

const loadJobsMock = mock(async () => [] as JenkinsJob[]);
const resolveJobMatchMock = mock(async (): Promise<JenkinsJob> => {
  throw new Error("resolveJobMatchMock not configured");
});
const realJobs = await import("../src/jobs");

mock.module("../src/jobs", () => ({
  ...realJobs,
  getJobDisplayName: (job: JenkinsJob) => job.fullName || job.name,
  loadJobs: loadJobsMock,
  resolveJobCandidates: (_query: string, jobs: JenkinsJob[]) => jobs,
  resolveJobMatch: resolveJobMatchMock,
}));

const { resolveJobTarget, resolveJobTargets } =
  await import("../src/commands/ops-helpers");

describe("ops helpers", () => {
  beforeEach(() => {
    loadJobsMock.mockReset();
    loadJobsMock.mockImplementation(async () => [] as JenkinsJob[]);
    resolveJobMatchMock.mockReset();
    resolveJobMatchMock.mockImplementation(async () => {
      throw new Error("resolveJobMatchMock not configured");
    });
  });

  test("resolveJobTarget normalizes the selected job URL", async () => {
    const selectedJob: JenkinsJob = {
      name: "alpha",
      url: " https://jenkins.example.com/job/alpha/ ",
    };

    loadJobsMock.mockImplementation(async () => [selectedJob]);
    resolveJobMatchMock.mockImplementation(async () => selectedJob);

    const result = await resolveJobTarget({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      job: "alpha",
      nonInteractive: true,
    });

    expect(result).toEqual({
      jobUrl: "https://jenkins.example.com/job/alpha",
      jobLabel: "alpha",
    });
  });

  test("resolveJobTarget uses an explicit jobUrl without loading jobs", async () => {
    const result = await resolveJobTarget({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      jobUrl: " https://jenkins.example.com/job/direct/ ",
      nonInteractive: true,
    });

    expect(result).toEqual({
      jobUrl: "https://jenkins.example.com/job/direct",
      jobLabel: "https://jenkins.example.com/job/direct",
    });
    expect(loadJobsMock).toHaveBeenCalledTimes(0);
    expect(resolveJobMatchMock).toHaveBeenCalledTimes(0);
  });

  test("resolveJobTarget throws when the cache is empty", async () => {
    loadJobsMock.mockImplementation(async () => [] as JenkinsJob[]);

    await expect(
      resolveJobTarget({
        client: {} as JenkinsClient,
        env: {} as EnvConfig,
        job: "alpha",
        nonInteractive: true,
      }),
    ).rejects.toThrow("No jobs found in cache.");

    expect(loadJobsMock).toHaveBeenCalledTimes(1);
    expect(resolveJobMatchMock).toHaveBeenCalledTimes(0);
  });

  test("interactive single selection delegates to the shared picker", async () => {
    const selectedJob: JenkinsJob = {
      name: "alpha",
      url: "https://jenkins.example.com/job/alpha/",
    };
    loadJobsMock.mockImplementation(async () => [selectedJob]);
    const pickJobs = mock(async () => ({
      kind: "selected" as const,
      jobs: [selectedJob],
    }));

    const result = await resolveJobTargets({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      nonInteractive: false,
      mode: "single",
      pickJobs,
    });

    expect(pickJobs).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "single", jobs: [selectedJob] }),
    );
    expect(result).toEqual([
      {
        jobUrl: "https://jenkins.example.com/job/alpha",
        jobLabel: "alpha",
      },
    ]);
  });

  test("interactive multiple selection preserves picker order", async () => {
    const alpha: JenkinsJob = {
      name: "alpha",
      url: "https://jenkins.example.com/job/alpha",
    };
    const beta: JenkinsJob = {
      name: "beta",
      url: "https://jenkins.example.com/job/beta",
    };
    loadJobsMock.mockImplementation(async () => [alpha, beta]);
    resolveJobMatchMock.mockImplementation(async () => {
      throw new CliError('Job name is ambiguous for "deploy".');
    });
    const pickJobs = mock(async () => ({
      kind: "selected" as const,
      jobs: [beta, alpha],
    }));

    const result = await resolveJobTargets({
      client: {} as JenkinsClient,
      env: {} as EnvConfig,
      job: "deploy",
      nonInteractive: false,
      mode: "multiple",
      pickJobs,
    });

    expect(pickJobs).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "multiple", initialQuery: "deploy" }),
    );
    expect(result.map((target) => target.jobLabel)).toEqual(["beta", "alpha"]);
  });

  test("rejects an invalid selected job URL centrally", async () => {
    const selectedJob: JenkinsJob = { name: "broken", url: "not a url" };
    loadJobsMock.mockImplementation(async () => [selectedJob]);

    await expect(
      resolveJobTargets({
        client: {} as JenkinsClient,
        env: {} as EnvConfig,
        nonInteractive: false,
        mode: "single",
        pickJobs: async () => ({ kind: "selected", jobs: [selectedJob] }),
      }),
    ).rejects.toThrow("Invalid --job-url value.");
  });
});
