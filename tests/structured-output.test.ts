import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import { runArtifacts } from "../src/commands/artifacts";
import { runCancel } from "../src/commands/cancel";
import { runLogs } from "../src/commands/logs";
import { runNodes } from "../src/commands/nodes";
import { runQueue } from "../src/commands/queue";
import { runRunningBuilds } from "../src/commands/run";
import {
  jsonArtifact,
  jsonNodes,
  jsonQueueItem,
  jsonRunningBuild,
  jsonTriggerTarget,
} from "../src/json-output";

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

function client(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

function sink(): { write: (text: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (text) => chunks.push(text),
    text: () => chunks.join(""),
  };
}

function document(output: string): {
  ok: boolean;
  command?: string;
  data?: unknown;
  error?: { code: string; message: string };
} {
  const lines = output.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("expanded JSON normalization", () => {
  test("normalizes every new Jenkins collection and mutation target", () => {
    expect(
      jsonQueueItem({
        id: 7,
        queueUrl: "https://jenkins.example.com/queue/item/7/",
        jobName: "api",
        blocked: true,
      }),
    ).toMatchObject({ id: 7, state: "blocked" });
    expect(
      jsonNodes({
        nodes: [
          {
            displayName: "agent-1",
            offline: false,
            temporarilyOffline: false,
            numExecutors: 2,
            busyExecutors: 1,
            totalExecutors: 2,
            labels: ["linux"],
          },
        ],
        totalNodes: 1,
        offlineNodes: 0,
        busyExecutors: 1,
        totalExecutors: 2,
      }),
    ).toMatchObject({
      nodes: [{ status: "online", executors: { busy: 1, total: 2 } }],
    });
    expect(
      jsonRunningBuild({
        jobName: "api",
        jobUrl: "https://jenkins.example.com/job/api/",
        buildNumber: 9,
        buildUrl: "https://jenkins.example.com/job/api/9/",
      }),
    ).toEqual({
      jobName: "api",
      number: 9,
      url: "https://jenkins.example.com/job/api/9/",
    });
    expect(
      jsonArtifact({ fileName: "app.tgz", relativePath: "dist/app.tgz" }),
    ).toEqual({ fileName: "app.tgz", relativePath: "dist/app.tgz" });
    expect(
      jsonTriggerTarget({
        queueUrl: "https://jenkins.example.com/queue/item/12/",
      }),
    ).toMatchObject({ queueId: 12 });
  });

  test("empty collections are successful arrays with one stdout document", async () => {
    for (const run of [
      async (write: (text: string) => void) =>
        runQueue({
          client: client({ listQueueItems: mock(async () => []) }),
          env,
          nonInteractive: true,
          json: true,
          write,
        }),
      async (write: (text: string) => void) =>
        runRunningBuilds({
          client: client({ listRunningBuilds: mock(async () => []) }),
          nonInteractive: true,
          json: true,
          write,
        }),
    ]) {
      const output = sink();
      await run(output.write);
      expect(document(output.text())).toMatchObject({
        ok: true,
        data: [],
      });
    }
  });

  test("nodes and artifacts emit normalized documents without table text", async () => {
    const nodesOutput = sink();
    await runNodes({
      client: client({
        listNodes: mock(async () => ({
          nodes: [],
          totalNodes: 0,
          offlineNodes: 0,
          busyExecutors: 0,
          totalExecutors: 0,
        })),
      }),
      env,
      offlineOnly: false,
      nonInteractive: true,
      json: true,
      write: nodesOutput.write,
    });
    expect(document(nodesOutput.text())).toMatchObject({
      ok: true,
      command: "nodes",
      data: { nodes: [] },
    });

    const artifactsOutput = sink();
    await runArtifacts({
      client: client({
        listArtifacts: mock(async (buildUrl: string) => ({
          buildNumber: 4,
          buildUrl,
          artifacts: [],
        })),
      }),
      env,
      buildUrl: "https://jenkins.example.com/job/api/4/",
      nonInteractive: true,
      json: true,
      write: artifactsOutput.write,
    });
    expect(document(artifactsOutput.text())).toMatchObject({
      ok: true,
      command: "artifacts",
      data: { buildNumber: 4, artifacts: [] },
    });
  });

  test("expected failures use the shared error envelope", async () => {
    const output = sink();
    await runQueue({
      client: client({
        listQueueItems: mock(async () => {
          throw new Error("controller unavailable");
        }),
      }),
      env,
      nonInteractive: true,
      json: true,
      write: output.write,
    });
    expect(document(output.text())).toMatchObject({
      ok: false,
      error: { code: "UNEXPECTED_ERROR", message: "controller unavailable" },
    });
    expect(process.exitCode).toBe(1);
  });
});

describe("structured mutation and streaming receipts", () => {
  test("cancel returns the canonical target type and URL", async () => {
    const output = sink();
    const cancelQueueItem = mock(async () => true);
    await runCancel({
      client: client({ cancelQueueItem }),
      env,
      queueUrl: "https://jenkins.example.com/queue/item/7/",
      nonInteractive: true,
      json: true,
      write: output.write,
    });
    expect(document(output.text())).toMatchObject({
      ok: true,
      command: "cancel",
      data: {
        targetType: "queue",
        url: "https://jenkins.example.com/queue/item/7/",
      },
    });
    expect(cancelQueueItem).toHaveBeenCalledTimes(1);
  });

  test("logs --jsonl emits valid start, chunk, and complete events in order", async () => {
    const output = sink();
    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl: "https://jenkins.example.com/job/api/9/",
          result: "SUCCESS",
          building: false,
        })),
        getConsoleChunk: mock(async () => ({
          text: "hello\n",
          nextStart: 6,
          hasMore: false,
        })),
      }),
      env,
      buildUrl: "https://jenkins.example.com/job/api/9/",
      follow: false,
      nonInteractive: true,
      jsonl: true,
      write: output.write,
    });
    const events = output
      .text()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "chunk",
      "complete",
    ]);
  });

  test("logs --jsonl terminates a failed stream with an error event", async () => {
    const output = sink();
    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl: "https://jenkins.example.com/job/api/9/",
          building: true,
        })),
        getConsoleChunk: mock(async () => {
          throw new Error("connection reset");
        }),
      }),
      env,
      buildUrl: "https://jenkins.example.com/job/api/9/",
      nonInteractive: true,
      jsonl: true,
      write: output.write,
    });
    const events = output
      .text()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(process.exitCode).toBe(1);
  });
});
