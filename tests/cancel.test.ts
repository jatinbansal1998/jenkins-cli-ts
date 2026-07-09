import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import { runCancel } from "../src/commands/cancel-core";

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

describe("runCancel", () => {
  beforeEach(() => {});

  test("waits for Jenkins to confirm a build was aborted before printing success", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    const logSpy = spyOn(console, "log");
    const sleepSpy = spyOn(Bun, "sleep");
    sleepSpy.mockImplementation(async () => undefined);

    try {
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
      expect(messages.some((message) => message.includes("ABORTED"))).toBe(
        true,
      );
      expect(messages.some((message) => message.includes("RUNNING"))).toBe(
        true,
      );
    } finally {
      logSpy.mockRestore();
      sleepSpy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  test("stops watching once Jenkins reports a terminal post-cancel status", async () => {
    const logSpy = spyOn(console, "log");
    try {
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
      expect(messages.some((message) => message.includes("SUCCESS"))).toBe(
        true,
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("runCancel option validation", () => {
  const baseOptions = {
    client: createClient({}),
    env: {} as EnvConfig,
    nonInteractive: true,
  };

  test("rejects --job together with --job-url", async () => {
    await expect(
      runCancel({
        ...baseOptions,
        job: "my-job",
        jobUrl: "https://jenkins.example.com/job/my-job",
      }),
    ).rejects.toThrow("Provide either --job or --job-url, not both.");
  });

  test("rejects --build-url together with --queue-url", async () => {
    await expect(
      runCancel({
        ...baseOptions,
        buildUrl: "https://jenkins.example.com/job/my-job/1/",
        queueUrl: "https://jenkins.example.com/queue/item/9/",
      }),
    ).rejects.toThrow("Provide either --build-url or --queue-url, not both.");
  });

  test("rejects --build-url combined with a job selector", async () => {
    await expect(
      runCancel({
        ...baseOptions,
        buildUrl: "https://jenkins.example.com/job/my-job/1/",
        job: "my-job",
      }),
    ).rejects.toThrow(
      "When --build-url is provided, do not pass --job or --job-url.",
    );
  });

  test("rejects --queue-url combined with a job selector", async () => {
    await expect(
      runCancel({
        ...baseOptions,
        queueUrl: "https://jenkins.example.com/queue/item/9/",
        jobUrl: "https://jenkins.example.com/job/my-job",
      }),
    ).rejects.toThrow(
      "When --queue-url is provided, do not pass --job or --job-url.",
    );
  });

  test("rejects malformed --build-url before contacting Jenkins", async () => {
    const stopBuild = mock(async () => undefined);
    await expect(
      runCancel({
        ...baseOptions,
        client: createClient({ stopBuild }),
        buildUrl: "not-a-url",
      }),
    ).rejects.toThrow("Invalid --build-url value.");
    expect(stopBuild).not.toHaveBeenCalled();
  });

  test("rejects malformed --queue-url before contacting Jenkins", async () => {
    const cancelQueueItem = mock(async () => true);
    await expect(
      runCancel({
        ...baseOptions,
        client: createClient({ cancelQueueItem }),
        queueUrl: "not-a-url",
      }),
    ).rejects.toThrow("Invalid --queue-url value.");
    expect(cancelQueueItem).not.toHaveBeenCalled();
  });
});

describe("runCancel queue target", () => {
  test("cancels the queue item and reports success", async () => {
    const logSpy = spyOn(console, "log");
    try {
      const cancelQueueItem = mock(async () => true);
      await runCancel({
        client: createClient({ cancelQueueItem }),
        env: {} as EnvConfig,
        queueUrl: "https://jenkins.example.com/queue/item/42/",
        nonInteractive: true,
      });

      expect(cancelQueueItem).toHaveBeenCalledWith(
        "https://jenkins.example.com/queue/item/42/",
      );
      const messages = logSpy.mock.calls
        .map((call) => call[0])
        .filter((entry): entry is string => typeof entry === "string");
      expect(
        messages.some((message) =>
          message.includes(
            "Cancelled queue item: https://jenkins.example.com/queue/item/42/",
          ),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("surfaces an error when the queue item no longer exists", async () => {
    const cancelQueueItem = mock(async () => false);
    await expect(
      runCancel({
        client: createClient({ cancelQueueItem }),
        env: {} as EnvConfig,
        queueUrl: "https://jenkins.example.com/queue/item/42/",
        nonInteractive: true,
      }),
    ).rejects.toThrow("Queue item not found.");
  });
});

describe("runCancel job target resolution", () => {
  const jobUrl = "https://jenkins.example.com/job/api";

  test("stops the running build when the job is building", async () => {
    const logSpy = spyOn(console, "log");
    try {
      const stopBuild = mock(async () => undefined);
      const getJobStatus = mock(async () => ({
        building: true,
        lastBuildUrl: "https://jenkins.example.com/job/api/14/",
        lastBuildNumber: 14,
      }));
      const getBuildStatus = mock(async () => ({
        buildUrl: "https://jenkins.example.com/job/api/14/",
        buildNumber: 14,
        building: false,
        result: "ABORTED",
      }));

      await runCancel({
        client: createClient({ stopBuild, getJobStatus, getBuildStatus }),
        env: {} as EnvConfig,
        jobUrl,
        nonInteractive: true,
      });

      expect(getJobStatus).toHaveBeenCalledWith(jobUrl);
      expect(stopBuild).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/api/14/",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("cancels the newest queue item when the job is only queued", async () => {
    const logSpy = spyOn(console, "log");
    try {
      const getJobStatus = mock(async () => ({ building: false }));
      const cancelQueueItem = mock(async () => true);
      // Queue item URLs deliberately differ from the target by trailing
      // slash to verify canonical matching; the newest inQueueSince wins.
      const listQueueItems = mock(async () => [
        {
          id: 1,
          queueUrl: "https://jenkins.example.com/queue/item/1/",
          jobUrl: "https://jenkins.example.com/job/api/",
          inQueueSince: 1_000,
        },
        {
          id: 2,
          queueUrl: "https://jenkins.example.com/queue/item/2/",
          jobUrl: "https://jenkins.example.com/job/api/",
          inQueueSince: 2_000,
        },
        {
          id: 3,
          queueUrl: "https://jenkins.example.com/queue/item/3/",
          jobUrl: "https://jenkins.example.com/job/other/",
          inQueueSince: 3_000,
        },
      ]);

      await runCancel({
        client: createClient({ getJobStatus, listQueueItems, cancelQueueItem }),
        env: {} as EnvConfig,
        jobUrl,
        nonInteractive: true,
      });

      expect(cancelQueueItem).toHaveBeenCalledWith(
        "https://jenkins.example.com/queue/item/2/",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("fails clearly when nothing is running or queued", async () => {
    const getJobStatus = mock(async () => ({ building: false }));
    const listQueueItems = mock(async () => []);

    await expect(
      runCancel({
        client: createClient({ getJobStatus, listQueueItems }),
        env: {} as EnvConfig,
        jobUrl,
        nonInteractive: true,
      }),
    ).rejects.toThrow("No running or queued build found");
  });
});
