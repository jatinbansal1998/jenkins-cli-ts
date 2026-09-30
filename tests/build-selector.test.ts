import { describe, expect, mock, test } from "bun:test";
import {
  parseBuildSelection,
  resolveBuildSelector,
} from "../src/build-selector";
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

  test("parses --build as a build number or a permalink alias", () => {
    expect(parseBuildSelection(undefined)).toBeUndefined();
    expect(parseBuildSelection("184")).toBe(184);
    expect(parseBuildSelection(" 7 ")).toBe(7);
    for (const alias of [
      "lastSuccessful",
      "lastStable",
      "lastFailed",
      "lastCompleted",
    ] as const) {
      expect(parseBuildSelection(alias)).toBe(alias);
    }
  });

  test("rejects --build values that are neither numbers nor aliases", () => {
    for (const value of [
      "",
      "0",
      "-1",
      "1.5",
      "1e3",
      "lastBuild",
      "lastsuccessful",
      "toString",
      ["1", "2"],
      true,
    ]) {
      let error: unknown;
      try {
        parseBuildSelection(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("INVALID_BUILD_NUMBER");
    }
  });

  test("resolves an alias through the matching Jenkins permalink", async () => {
    for (const [alias, permalink] of [
      ["lastSuccessful", "lastSuccessfulBuild"],
      ["lastStable", "lastStableBuild"],
      ["lastFailed", "lastFailedBuild"],
      ["lastCompleted", "lastCompletedBuild"],
    ] as const) {
      const getPermalinkBuild = mock(async () => ({
        buildUrl: "https://ignored.example.com/31/",
        buildNumber: 31,
      }));
      const target = await resolveBuildSelector({
        client: { getPermalinkBuild } as unknown as JenkinsClient,
        env,
        job: "nested",
        build: alias,
        nonInteractive: true,
        resolveJob: resolver(),
      });

      expect(getPermalinkBuild).toHaveBeenCalledWith(nestedJobUrl, permalink);
      expect(target).toEqual({
        kind: "build",
        jobUrl: nestedJobUrl,
        jobLabel: "team/exact # % café",
        buildNumber: 31,
        buildUrl: `${nestedJobUrl}/31/`,
      });
    }
  });

  test("reports a missing permalink build as BUILD_NOT_FOUND", async () => {
    const error = await captureError({
      client: {
        getPermalinkBuild: mock(async () => null),
      } as unknown as JenkinsClient,
      env,
      job: "nested",
      build: "lastFailed",
      nonInteractive: true,
      resolveJob: resolver(),
    });
    expect(error.code).toBe("BUILD_NOT_FOUND");
    expect(error.message).toBe(
      "Job team/exact # % café has no lastFailed build.",
    );
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
