import {
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import { runCancel } from "../src/commands/cancel-core";

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

describe("runCancel", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  test("waits for Jenkins to confirm a build was aborted before printing success", async () => {
    const logSpy = spyOn(console, "log");
    const sleepSpy = spyOn(Bun, "sleep");
    sleepSpy.mockImplementation(async () => undefined);
    const stopBuild = mock(async () => undefined);
    const getBuildStatus = mock(async () => {
      const callCount = getBuildStatus.mock.calls.length;
      if (callCount === 1) {
        return {
          buildUrl: "https://jenkins.example.com/job/my-job/123/",
          buildNumber: 123,
          building: true,
          result: null,
        };
      }
      return {
        buildUrl: "https://jenkins.example.com/job/my-job/123/",
        buildNumber: 123,
        building: false,
        result: "ABORTED",
      };
    });

    await runCancel({
      client: createClient({
        stopBuild,
        getBuildStatus,
      }),
      env: {} as EnvConfig,
      buildUrl: "https://jenkins.example.com/job/my-job/123/",
      nonInteractive: true,
    });

    expect(stopBuild).toHaveBeenCalledWith(
      "https://jenkins.example.com/job/my-job/123/",
    );
    expect(getBuildStatus).toHaveBeenCalledTimes(2);
    const messages = logSpy.mock.calls
      .map((call) => call[0])
      .filter((entry): entry is string => typeof entry === "string");
    expect(messages).toContain(
      "OK: Cancellation requested for build: https://jenkins.example.com/job/my-job/123/",
    );
    expect(messages.some((message) => message.includes("ABORTED"))).toBe(true);
    expect(messages.some((message) => message.includes("RUNNING"))).toBe(true);
    sleepSpy.mockRestore();
    logSpy.mockRestore();
  });

  test("stops watching once Jenkins reports a terminal post-cancel status", async () => {
    const logSpy = spyOn(console, "log");
    const stopBuild = mock(async () => undefined);
    const getBuildStatus = mock(async () => ({
      buildUrl: "https://jenkins.example.com/job/my-job/123/",
      buildNumber: 123,
      building: false,
      result: "SUCCESS",
    }));

    await runCancel({
      client: createClient({
        stopBuild,
        getBuildStatus,
      }),
      env: {} as EnvConfig,
      buildUrl: "https://jenkins.example.com/job/my-job/123/",
      nonInteractive: true,
    });

    expect(getBuildStatus).toHaveBeenCalledTimes(1);
    const messages = logSpy.mock.calls
      .map((call) => call[0])
      .filter((entry): entry is string => typeof entry === "string");
    expect(messages).toContain(
      "OK: Cancellation requested for build: https://jenkins.example.com/job/my-job/123/",
    );
    expect(messages.some((message) => message.includes("SUCCESS"))).toBe(true);
    logSpy.mockRestore();
  });
});
