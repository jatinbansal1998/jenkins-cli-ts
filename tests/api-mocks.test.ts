import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchLatestRelease,
  fetchVersionPolicy,
} from "../src/github/api-wrapper";
import { JenkinsClient } from "../src/jenkins/client";
import { installApiMocks } from "./helpers.api-mocks";

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

describe("shared API mocks", () => {
  test("mocks Jenkins listJobs using dummy jobs fixture", async () => {
    const mocks = await installApiMocks();
    restoreFetch = mocks.restore;

    const client = new JenkinsClient({
      baseUrl: mocks.cacheFixture.jenkinsUrl,
      user: mocks.cacheFixture.user,
      apiToken: "ci-token",
      timeoutMs: 1_000,
    });

    const jobs = await client.listJobs();
    expect(jobs).toEqual(
      mocks.cacheFixture.jobs.map((job) => ({
        name: job.name,
        fullName: job.fullName,
        url: job.url,
      })),
    );
  });

  test("mocks GitHub release and minimum version policy endpoints", async () => {
    const mocks = await installApiMocks();
    restoreFetch = mocks.restore;

    const release = await fetchLatestRelease({ currentVersion: "0.6.2" });
    expect(release.tag_name).toBe("v9.9.9");
    expect(release.assets[0]?.name).toBe("jenkins-cli");

    const policy = await fetchVersionPolicy({ currentVersion: "0.6.2" });
    expect(policy).toEqual({
      minVersion: "0.6.0",
      message: "Mocked policy for tests.",
      updatedAt: "2026-02-12T00:00:00.000Z",
    });
  });
});
