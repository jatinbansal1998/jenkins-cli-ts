import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../src/cli";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { JenkinsJob } from "../src/types/jenkins";

// Keep the job cache inside the per-file test home even when the runner sets one.
process.env.XDG_CACHE_HOME = join(process.env.HOME ?? "", ".cache");
process.env.LOCALAPPDATA = join(process.env.HOME ?? "", "AppData", "Local");

const { getJobCacheDir } = await import("../src/jobs");
const { toJsonError } = await import("../src/json-output");
const { runStatus } = await import("../src/commands/status");
const { runLogs } = await import("../src/commands/logs");

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
    name: "deploy-api",
    fullName: "platform/deploy-api",
    url: "https://jenkins.example.com/job/platform/job/deploy-api",
  },
  {
    name: "deploy-web",
    fullName: "platform/deploy-web",
    url: "https://jenkins.example.com/job/platform/job/deploy-web",
  },
  {
    name: "nightly-backup",
    url: "https://jenkins.example.com/job/nightly-backup",
  },
];

const deployCandidates = [
  {
    name: "platform/deploy-api",
    url: "https://jenkins.example.com/job/platform/job/deploy-api",
  },
  {
    name: "platform/deploy-web",
    url: "https://jenkins.example.com/job/platform/job/deploy-web",
  },
];

const client = { listJobs: async () => jobs } as unknown as JenkinsClient;

type ErrorDocument = {
  ok?: false;
  type?: "error";
  error: {
    code: string;
    message: string;
    hints: string[];
    details?: { candidates: { name: string; url: string }[] };
  };
};

function capture(): {
  write: (text: string) => void;
  document: () => ErrorDocument;
} {
  const chunks: string[] = [];
  return {
    write: (text) => chunks.push(text),
    document: () => {
      const lines = chunks.join("").split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0] as string) as ErrorDocument;
    },
  };
}

async function statusJson(job: string): Promise<ErrorDocument> {
  const output = capture();
  await runStatus({
    client,
    env,
    job,
    nonInteractive: true,
    json: true,
    write: output.write,
  });
  return output.document();
}

async function logsJsonl(job: string): Promise<ErrorDocument> {
  const output = capture();
  await runLogs({
    client,
    env,
    job,
    nonInteractive: true,
    jsonl: true,
    write: output.write,
  });
  return output.document();
}

beforeEach(async () => {
  await rm(getJobCacheDir(), { recursive: true, force: true });
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("JSON error body", () => {
  test("carries the CliError hints", () => {
    expect(
      toJsonError(
        new CliError(
          "No test report.",
          ["Run the tests stage."],
          "TEST_REPORT_NOT_FOUND",
        ),
      ),
    ).toEqual({
      code: "TEST_REPORT_NOT_FOUND",
      message: "No test report.",
      hints: ["Run the tests stage."],
    });
  });

  test("gives errors that are not CliErrors empty hints", () => {
    expect(toJsonError(new Error("boom"))).toEqual({
      code: "UNEXPECTED_ERROR",
      message: "boom",
      hints: [],
    });
  });
});

describe("job candidates in --json", () => {
  test("JOB_AMBIGUOUS lists every candidate with its URL", async () => {
    const document = await statusJson("deploy");

    expect(document).toEqual({
      ok: false,
      error: {
        code: "JOB_AMBIGUOUS",
        message: 'Job name is ambiguous for "deploy".',
        hints: [
          "Options: platform/deploy-api, platform/deploy-web",
          "Pass `--job <exact name>` or `--job-url <url>`.",
        ],
        details: { candidates: deployCandidates },
      },
    });
    expect(process.exitCode).toBe(2);
  });

  test("JOB_NOT_FOUND lists the closest jobs with their URLs", async () => {
    const document = await statusJson("deploy mobile");

    expect(document.ok).toBe(false);
    expect(document.error.code).toBe("JOB_NOT_FOUND");
    expect(document.error.hints[0]).toBe(
      "Closest: platform/deploy-api, platform/deploy-web.",
    );
    expect(document.error.details).toEqual({ candidates: deployCandidates });
    expect(process.exitCode).toBe(4);
  });
});

describe("job candidates in --jsonl", () => {
  test("JOB_AMBIGUOUS error event carries the same body as --json", async () => {
    const jsonl = await logsJsonl("deploy");
    const json = await statusJson("deploy");

    expect(jsonl.type).toBe("error");
    expect(jsonl.error).toEqual(json.error);
    expect(jsonl.error.details).toEqual({ candidates: deployCandidates });
  });

  test("JOB_NOT_FOUND error event carries the closest jobs", async () => {
    const jsonl = await logsJsonl("deploy mobile");

    expect(jsonl.type).toBe("error");
    expect(jsonl.error.code).toBe("JOB_NOT_FOUND");
    expect(jsonl.error.details).toEqual({ candidates: deployCandidates });
  });
});
