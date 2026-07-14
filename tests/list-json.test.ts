import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CliError } from "../src/cli";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { JenkinsJob } from "../src/types/jenkins";
import { listDeps } from "../src/commands/list-deps";
import { runList } from "../src/commands/list";

const restoreFns: Array<() => void> = [];

function trackRestore<T extends { mockRestore(): void }>(
  mockWithRestore: T,
): T {
  restoreFns.push(() => mockWithRestore.mockRestore());
  return mockWithRestore;
}

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

const jobs: JenkinsJob[] = [
  {
    name: "alpha",
    fullName: "team/alpha",
    url: "https://jenkins.example.com/job/alpha",
  },
  { name: "beta", url: "https://jenkins.example.com/job/beta" },
];

function capture(): { write: (text: string) => void; output: () => string } {
  const chunks: string[] = [];
  return {
    write: (text) => {
      chunks.push(text);
    },
    output: () => chunks.join(""),
  };
}

describe("list --json", () => {
  beforeEach(() => {
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = undefined;
    while (restoreFns.length > 0) {
      restoreFns.pop()?.();
    }
  });

  test("emits a success envelope with the cached jobs", async () => {
    trackRestore(spyOn(listDeps, "loadJobs")).mockResolvedValue(jobs);
    const logSpy = trackRestore(spyOn(console, "log")).mockImplementation(
      () => undefined,
    );
    const sink = capture();

    await runList({
      client: {} as JenkinsClient,
      env,
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      command: string;
      data: Array<{ name: string; fullName?: string; url: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("list");
    expect(parsed.data).toEqual(
      expect.arrayContaining([
        {
          name: "alpha",
          fullName: "team/alpha",
          url: "https://jenkins.example.com/job/alpha",
        },
        { name: "beta", url: "https://jenkins.example.com/job/beta" },
      ]),
    );
    expect(logSpy).toHaveBeenCalledTimes(0);
  });

  test("emits exactly one JSON document on stdout", async () => {
    trackRestore(spyOn(listDeps, "loadJobs")).mockResolvedValue(jobs);
    const sink = capture();

    await runList({
      client: {} as JenkinsClient,
      env,
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const lines = sink.output().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] as string)).not.toThrow();
  });

  test("emits a JSON error envelope and non-zero exit code on failure", async () => {
    trackRestore(spyOn(listDeps, "loadJobs")).mockRejectedValue(
      new CliError("Job cache is missing.", ["Run list --refresh."]),
    );
    const sink = capture();

    await runList({
      client: {} as JenkinsClient,
      env,
      nonInteractive: true,
      json: true,
      write: sink.write,
    });

    const parsed = JSON.parse(sink.output()) as {
      ok: boolean;
      error: { message: string; code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toBe("Job cache is missing.");
    expect(parsed.error.code).toBe("CLI_ERROR");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
