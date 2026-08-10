import { describe, expect, mock, test } from "bun:test";
import { resolveBuildSelector } from "../src/build-selector";
import { CliError } from "../src/cli";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { resolveJobTarget } from "../src/commands/ops-helpers";

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com/jenkins",
  jenkinsUser: "ci",
  jenkinsApiToken: "token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

const client = {} as JenkinsClient;
const nestedJobUrl =
  "https://jenkins.example.com/jenkins/job/team/job/exact%20%23%20%25%20caf%C3%A9";

function resolver(jobUrl = nestedJobUrl): typeof resolveJobTarget {
  return mock(async () => ({ jobUrl, jobLabel: "team/exact # % café" }));
}

async function captureError(
  options: Parameters<typeof resolveBuildSelector>[0],
): Promise<CliError> {
  try {
    await resolveBuildSelector(options);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("Expected selector resolution to fail.");
}

describe("exact build selector", () => {
  test("normalizes a numeric build without decoding the Jenkins job path", async () => {
    const target = await resolveBuildSelector({
      client,
      env,
      job: "nested",
      build: 17,
      nonInteractive: true,
      resolveJob: resolver(),
    });

    expect(target).toEqual({
      kind: "build",
      jobUrl: nestedJobUrl,
      jobLabel: "team/exact # % café",
      buildNumber: 17,
      buildUrl: `${nestedJobUrl}/17/`,
    });
  });

  test("extracts canonical metadata from a direct encoded build URL", async () => {
    const target = await resolveBuildSelector({
      client,
      env,
      buildUrl: `${nestedJobUrl}/23/`,
      nonInteractive: true,
    });

    expect(target).toEqual({
      kind: "build",
      jobUrl: nestedJobUrl,
      jobLabel: nestedJobUrl,
      buildNumber: 23,
      buildUrl: `${nestedJobUrl}/23/`,
    });
  });

  test("rejects every malformed numeric build value", async () => {
    for (const build of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const error = await captureError({
        client,
        env,
        job: "nested",
        build,
        nonInteractive: true,
        resolveJob: resolver(),
      });
      expect(error.code).toBe("INVALID_BUILD_NUMBER");
    }
  });

  test("rejects conflicting exact-build selector combinations", async () => {
    for (const selector of [
      { build: 1 },
      { job: "api", jobUrl: nestedJobUrl, build: 1 },
      { job: "api", build: 1, buildUrl: `${nestedJobUrl}/1/` },
      { job: "api", build: 1, queueUrl: `${env.jenkinsUrl}/queue/item/1/` },
      {
        buildUrl: `${nestedJobUrl}/1/`,
        queueUrl: `${env.jenkinsUrl}/queue/item/1/`,
      },
    ]) {
      const error = await captureError({
        client,
        env,
        ...selector,
        nonInteractive: true,
        allowQueue: true,
        resolveJob: resolver(),
      });
      expect(error.code).toBe("INVALID_BUILD_SELECTOR");
    }
  });

  test("rejects cross-controller and out-of-context URLs before network access", async () => {
    for (const buildUrl of [
      "https://other.example.com/jenkins/job/api/1/",
      "https://jenkins.example.com/job/api/1/",
    ]) {
      const error = await captureError({
        client,
        env,
        buildUrl,
        nonInteractive: true,
      });
      expect(error.code).toBe("CROSS_CONTROLLER_URL");
    }
  });

  test("keeps queue targets distinct and permits a wait-specific job hint", async () => {
    const target = await resolveBuildSelector({
      client,
      env,
      jobUrl: nestedJobUrl,
      queueUrl: `${env.jenkinsUrl}/queue/item/42/`,
      nonInteractive: true,
      allowQueue: true,
      allowQueueWithJob: true,
      resolveJob: resolver(),
    });

    expect(target).toEqual({
      kind: "queue",
      queueUrl: `${env.jenkinsUrl}/queue/item/42/`,
      jobUrl: nestedJobUrl,
      jobLabel: "team/exact # % café",
    });
  });
});
