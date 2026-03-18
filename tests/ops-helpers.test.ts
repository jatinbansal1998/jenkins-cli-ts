import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const { resolveJobTarget } = await import("../src/commands/ops-helpers");

describe("ops helpers", () => {
  beforeEach(() => {
    loadJobsMock.mockReset();
    loadJobsMock.mockImplementation(async () => [] as JenkinsJob[]);
    resolveJobMatchMock.mockReset();
    resolveJobMatchMock.mockImplementation(async () => {
      throw new Error("resolveJobMatchMock not configured");
    });
  });

  afterEach(() => {
    mock.restore();
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
});
