import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { QueueItemSummary } from "../src/types/jenkins";
import { runQueue } from "../src/commands/queue";

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

let logSpy: ReturnType<typeof spyOn<typeof console, "log">>;
let dateNowSpy: ReturnType<typeof spyOn<typeof Date, "now">>;

function loggedLines(): string[] {
  return logSpy.mock.calls
    .map((call) => call[0])
    .filter((entry): entry is string => typeof entry === "string");
}

const NOW = 1_700_000_600_000;

const baseItem: QueueItemSummary = {
  id: 1,
  queueUrl: "https://jenkins.example.com/queue/item/1/",
  jobName: "api-prod",
  jobUrl: "https://jenkins.example.com/job/api-prod/",
  reason: "Waiting for next available executor",
  inQueueSince: NOW - 120_000,
  blocked: false,
  buildable: true,
  stuck: false,
};

describe("runQueue", () => {
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    dateNowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    logSpy.mockRestore();
    dateNowSpy.mockRestore();
  });

  test("lists queued items with a count summary and does not throw", async () => {
    const items: QueueItemSummary[] = [
      baseItem,
      {
        ...baseItem,
        id: 2,
        jobName: "web-build",
        reason: "In the quiet period",
        buildable: false,
        blocked: true,
        inQueueSince: NOW - 5_000,
      },
    ];
    const listQueueItems = mock(async () => items);

    await runQueue({
      client: createClient({ listQueueItems }),
      env,
      nonInteractive: true,
    });

    const lines = loggedLines();
    expect(lines).toContain("OK: 2 queued items.");
    const table = lines.find(
      (line) => line.includes("Job") && line.includes("State"),
    );
    expect(table).toBeDefined();
    expect(lines.some((line) => line.includes("api-prod"))).toBe(true);
    expect(lines.some((line) => line.includes("web-build"))).toBe(true);
    // buildable vs blocked state rendering
    expect(lines.some((line) => line.includes("buildable"))).toBe(true);
    expect(lines.some((line) => line.includes("blocked"))).toBe(true);
  });

  test("prints an empty-queue message and exits without error", async () => {
    const listQueueItems = mock(async () => []);

    await runQueue({
      client: createClient({ listQueueItems }),
      env,
      nonInteractive: true,
    });

    expect(loggedLines()).toContain("OK: queue is empty");
  });

  test("filters items by --job", async () => {
    const items: QueueItemSummary[] = [
      baseItem,
      { ...baseItem, id: 2, jobName: "web-build" },
    ];
    const listQueueItems = mock(async () => items);

    await runQueue({
      client: createClient({ listQueueItems }),
      env,
      job: "web",
      nonInteractive: true,
    });

    const lines = loggedLines();
    expect(lines).toContain('OK: 1 queued item matching "web".');
    expect(lines.some((line) => line.includes("web-build"))).toBe(true);
    expect(lines.some((line) => line.includes("api-prod"))).toBe(false);
  });

  test("reports when no items match the --job filter", async () => {
    const listQueueItems = mock(async () => [baseItem]);

    await runQueue({
      client: createClient({ listQueueItems }),
      env,
      job: "nomatch",
      nonInteractive: true,
    });

    expect(loggedLines()).toContain('OK: No queued items match "nomatch".');
  });

  test("prints the full why reason when a single item is shown", async () => {
    const longReason =
      "Waiting for next available executor on label linux && docker because everything is busy right now";
    const listQueueItems = mock(async () => [
      { ...baseItem, reason: longReason },
    ]);

    await runQueue({
      client: createClient({ listQueueItems }),
      env,
      nonInteractive: true,
    });

    const lines = loggedLines();
    expect(lines).toContain(`Why: ${longReason}`);
    expect(lines).toContain("OK: 1 queued item.");
  });

  test("marks stuck items as stuck even when blocked or buildable", async () => {
    const listQueueItems = mock(async () => [
      { ...baseItem, stuck: true, blocked: true, buildable: true },
    ]);

    await runQueue({
      client: createClient({ listQueueItems }),
      env,
      nonInteractive: true,
    });

    expect(loggedLines().some((line) => line.includes("stuck"))).toBe(true);
  });
});
