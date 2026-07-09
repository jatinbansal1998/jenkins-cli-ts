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
import type { NodeSummary, NodesSummary } from "../src/types/jenkins";
import { runNodes } from "../src/commands/nodes";

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

function loggedLines(): string[] {
  return logSpy.mock.calls
    .map((call) => call[0])
    .filter((entry): entry is string => typeof entry === "string");
}

const controller: NodeSummary = {
  displayName: "built-in",
  offline: false,
  temporarilyOffline: false,
  numExecutors: 2,
  busyExecutors: 1,
  totalExecutors: 2,
  labels: ["master"],
};

const offlineAgent: NodeSummary = {
  displayName: "agent-2",
  offline: true,
  temporarilyOffline: true,
  offlineCauseReason: "Disconnected by admin",
  numExecutors: 4,
  busyExecutors: 0,
  totalExecutors: 4,
  labels: ["linux", "docker"],
};

function summaryFrom(nodes: NodeSummary[]): NodesSummary {
  return {
    nodes,
    totalNodes: nodes.length,
    offlineNodes: nodes.filter((n) => n.offline || n.temporarilyOffline).length,
    busyExecutors: nodes.reduce((sum, n) => sum + n.busyExecutors, 0),
    totalExecutors: nodes.reduce((sum, n) => sum + n.totalExecutors, 0),
  };
}

describe("runNodes", () => {
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("lists nodes with status, executors, labels, and a summary line", async () => {
    const listNodes = mock(async () => summaryFrom([controller, offlineAgent]));

    await runNodes({
      client: createClient({ listNodes }),
      env,
      offlineOnly: false,
      nonInteractive: true,
    });

    const lines = loggedLines();
    expect(lines).toContain("OK: 2 nodes, 1 offline, 1/6 executors busy.");
    expect(lines.some((line) => line.includes("built-in"))).toBe(true);
    expect(lines.some((line) => line.includes("online"))).toBe(true);
    expect(lines.some((line) => line.includes("1/2"))).toBe(true);
    expect(lines.some((line) => line.includes("master"))).toBe(true);
  });

  test("renders offline reason for temporarily offline nodes", async () => {
    const listNodes = mock(async () => summaryFrom([offlineAgent]));

    await runNodes({
      client: createClient({ listNodes }),
      env,
      offlineOnly: false,
      nonInteractive: true,
    });

    const lines = loggedLines();
    expect(
      lines.some((line) =>
        line.includes("temp-offline (Disconnected by admin)"),
      ),
    ).toBe(true);
  });

  test("--offline-only shows only offline nodes", async () => {
    const listNodes = mock(async () => summaryFrom([controller, offlineAgent]));

    await runNodes({
      client: createClient({ listNodes }),
      env,
      offlineOnly: true,
      nonInteractive: true,
    });

    const lines = loggedLines();
    expect(lines.some((line) => line.includes("agent-2"))).toBe(true);
    expect(lines.some((line) => line.includes("built-in"))).toBe(false);
    // Summary still reflects the whole fleet.
    expect(lines).toContain("OK: 2 nodes, 1 offline, 1/6 executors busy.");
  });

  test("prints a friendly message when no offline nodes exist", async () => {
    const listNodes = mock(async () => summaryFrom([controller]));

    await runNodes({
      client: createClient({ listNodes }),
      env,
      offlineOnly: true,
      nonInteractive: true,
    });

    expect(loggedLines()).toContain("OK: no offline nodes");
  });

  test("prints a friendly message when there are no nodes at all", async () => {
    const listNodes = mock(async () => summaryFrom([]));

    await runNodes({
      client: createClient({ listNodes }),
      env,
      offlineOnly: false,
      nonInteractive: true,
    });

    expect(loggedLines()).toContain("OK: no nodes found");
  });
});
