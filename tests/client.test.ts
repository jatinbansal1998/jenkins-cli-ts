import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JenkinsClient } from "../src/jenkins/client";

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

afterEach(() => {
  globalThis.fetch = realFetch;
});

function readHeader(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const entries = headers as Array<[string, string]>;
    const lower = name.toLowerCase();
    const entry = entries.find(([key]) => key.toLowerCase() === lower);
    return entry?.[1];
  }
  const objectHeaders = headers as Record<string, string | readonly string[]>;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(objectHeaders)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return undefined;
}

describe("JenkinsClient triggerBuild", () => {
  test("uses buildWithParameters when params are provided", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
      if (
        typeof _input === "string" &&
        _input.includes("crumbIssuer/api/json")
      ) {
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
      useCrumb: true,
    });

    await client.triggerBuild("https://jenkins.example.com/job/my-job", {
      BRANCH: "main",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const triggerCall = fetchMock.mock.calls[1];
    expect(triggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/buildWithParameters?delay=0sec",
    );
    expect((triggerCall?.[1] as RequestInit | undefined)?.method).toBe("POST");
    expect((triggerCall?.[1] as RequestInit | undefined)?.body).toBe(
      "BRANCH=main",
    );
    expect(
      readHeader(triggerCall?.[1] as RequestInit | undefined, "Authorization"),
    ).toBe(`Basic ${Buffer.from("user:token").toString("base64")}`);
  });

  test("resolves the queued build from Jenkins' Location header", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/queue/item/17/api/json")) {
        return Response.json({
          id: 17,
          task: { url: "https://jenkins.example.com/job/my-job/" },
          executable: {
            number: 9,
            url: "https://jenkins.example.com/job/my-job/9/",
          },
        });
      }
      return new Response("", {
        status: 201,
        headers: { Location: "/queue/item/17/" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
    });
    const result = await client.triggerBuild(
      "https://jenkins.example.com/job/my-job/",
      {},
    );

    expect(result).toEqual({
      queueUrl: "https://jenkins.example.com/queue/item/17/",
      queueId: 17,
      jobUrl: "https://jenkins.example.com/job/my-job/",
      buildUrl: "https://jenkins.example.com/job/my-job/9/",
      buildNumber: 9,
    });
  });

  test("uses build endpoint when no params are provided", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
      if (
        typeof _input === "string" &&
        _input.includes("crumbIssuer/api/json")
      ) {
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
      useCrumb: true,
    });

    await client.triggerBuild("https://jenkins.example.com/job/my-job", {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const triggerCall = fetchMock.mock.calls[1];
    expect(triggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/build?delay=0sec",
    );
    expect((triggerCall?.[1] as RequestInit | undefined)?.method).toBe("POST");
    expect((triggerCall?.[1] as RequestInit | undefined)?.body).toBeUndefined();
  });

  test("refreshes crumb and retries trigger when first attempt gets 403", async () => {
    let crumbRequestCount = 0;
    let triggerRequestCount = 0;

    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (url.includes("crumbIssuer/api/json")) {
        crumbRequestCount += 1;
        return new Response(
          JSON.stringify({
            crumbRequestField: "Jenkins-Crumb",
            crumb: crumbRequestCount === 1 ? "stale-crumb" : "fresh-crumb",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/build?delay=0sec")) {
        triggerRequestCount += 1;
        return new Response("", {
          status: triggerRequestCount === 1 ? 403 : 201,
        });
      }
      return new Response("", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
      useCrumb: true,
    });

    await client.triggerBuild("https://jenkins.example.com/job/my-job", {});

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstTriggerCall = fetchMock.mock.calls[1];
    const secondTriggerCall = fetchMock.mock.calls[3];
    expect(firstTriggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/build?delay=0sec",
    );
    expect(secondTriggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/build?delay=0sec",
    );
    expect(
      readHeader(
        firstTriggerCall?.[1] as RequestInit | undefined,
        "Jenkins-Crumb",
      ),
    ).toBe("stale-crumb");
    expect(
      readHeader(
        secondTriggerCall?.[1] as RequestInit | undefined,
        "Jenkins-Crumb",
      ),
    ).toBe("fresh-crumb");
  });

  test("keeps crumb disabled by default and posts without crumb lookup", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (url.includes("crumbIssuer/api/json")) {
        return new Response("", { status: 500 });
      }
      return new Response("", { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    await client.triggerBuild("https://jenkins.example.com/job/my-job", {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const triggerCall = fetchMock.mock.calls[0];
    expect(triggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/build?delay=0sec",
    );
    expect(
      readHeader(triggerCall?.[1] as RequestInit | undefined, "Jenkins-Crumb"),
    ).toBeUndefined();
  });
});

describe("JenkinsClient pipeline stage cloning", () => {
  test("clones nested stage links before returning build history", async () => {
    const pipelineData = {
      stages: [
        {
          name: "Deploy",
          status: "FAILED",
          _links: {
            self: {
              href: "/job/my-job/102/execution/node/12/wfapi/describe",
            },
          },
        },
      ],
    };

    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url ===
        "https://jenkins.example.com/job/my-job/api/json?tree=builds[number,url,result,building,timestamp,duration,estimatedDuration,actions[parameters[name,value]]]"
      ) {
        return new Response(
          JSON.stringify({
            builds: [
              {
                number: 102,
                url: "https://jenkins.example.com/job/my-job/102/",
                result: "FAILURE",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://jenkins.example.com/job/my-job/102/wfapi/describe") {
        return {
          ok: true,
          status: 200,
          json: async () => pipelineData,
        } as Response;
      }
      if (
        url ===
        "https://jenkins.example.com/job/my-job/102/execution/node/12/wfapi/describe"
      ) {
        return new Response(
          JSON.stringify({
            name: "Deploy",
            status: "FAILED",
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    const page = await client.listBuildHistory(
      "https://jenkins.example.com/job/my-job/",
      {
        offset: 0,
        limit: 1,
      },
    );

    if (page.builds[0]?.stages?.[0]?._links?.self) {
      page.builds[0].stages[0]._links.self.href = "/mutated";
    }

    expect(pipelineData.stages[0]?._links?.self?.href).toBe(
      "/job/my-job/102/execution/node/12/wfapi/describe",
    );
  });
});

describe("JenkinsClient build transport", () => {
  test("preserves the latest job result", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("tree=lastBuild")) {
        return Response.json({
          lastBuild: {
            number: 9,
            url: "https://jenkins.example.com/job/my-job/9/",
            result: "SUCCESS",
            building: false,
          },
        });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
    });

    expect(
      await client.getJobStatus("https://jenkins.example.com/job/my-job/"),
    ).toMatchObject({
      lastBuildNumber: 9,
      result: "SUCCESS",
      building: false,
    });
  });

  test("requests and returns progressive console logs", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) =>
      Promise.resolve(
        new Response("cli output\n", {
          headers: { "X-Text-Size": "11", "X-More-Data": "false" },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
    });
    const chunk = await client.getConsoleChunk(
      "https://jenkins.example.com/job/my-job/9/",
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://jenkins.example.com/job/my-job/9/logText/progressiveText?start=0",
    );
    expect(chunk).toEqual({
      text: "cli output\n",
      nextStart: 11,
      hasMore: false,
    });
  });

  test("authenticates artifact downloads", async () => {
    const home = mkdtempSync(join(tmpdir(), "jenkins-client-artifact-"));
    const destination = join(home, "artifact.txt");
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) =>
      Promise.resolve(new Response("artifact contents\n")),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const client = new JenkinsClient({
        baseUrl: "https://jenkins.example.com",
        user: "user",
        apiToken: "token",
      });
      await client.downloadArtifact(
        "https://jenkins.example.com/job/my-job/9/",
        "artifact.txt",
        destination,
      );

      expect(
        readHeader(
          fetchMock.mock.calls[0]?.[1] as RequestInit | undefined,
          "Authorization",
        ),
      ).toBe(`Basic ${Buffer.from("user:token").toString("base64")}`);
      expect(await Bun.file(destination).text()).toBe("artifact contents\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("JenkinsClient POST with crumb", () => {
  test("refreshes crumb and retries stopBuild when first attempt gets 403", async () => {
    let crumbRequestCount = 0;
    let stopRequestCount = 0;

    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (url.includes("crumbIssuer/api/json")) {
        crumbRequestCount += 1;
        return new Response(
          JSON.stringify({
            crumbRequestField: "Jenkins-Crumb",
            crumb: crumbRequestCount === 1 ? "stale-crumb" : "fresh-crumb",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/stop")) {
        stopRequestCount += 1;
        return new Response("", {
          status: stopRequestCount === 1 ? 403 : 200,
        });
      }
      return new Response("", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
      useCrumb: true,
    });

    await client.stopBuild("https://jenkins.example.com/job/my-job/123/");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstStopCall = fetchMock.mock.calls[1];
    const secondStopCall = fetchMock.mock.calls[3];
    expect(firstStopCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/123/stop",
    );
    expect(secondStopCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/123/stop",
    );
    expect(
      readHeader(
        firstStopCall?.[1] as RequestInit | undefined,
        "Jenkins-Crumb",
      ),
    ).toBe("stale-crumb");
    expect(
      readHeader(
        secondStopCall?.[1] as RequestInit | undefined,
        "Jenkins-Crumb",
      ),
    ).toBe("fresh-crumb");
  });
});

describe("JenkinsClient listBuildHistory", () => {
  test("returns paginated build history with failed step details", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url ===
        "https://jenkins.example.com/job/my-job/api/json?tree=builds[number,url,result,building,timestamp,duration,estimatedDuration,actions[parameters[name,value]]]"
      ) {
        return new Response(
          JSON.stringify({
            builds: [
              {
                number: 103,
                url: "https://jenkins.example.com/job/my-job/103/",
                result: "SUCCESS",
                timestamp: 1030,
                duration: 10_000,
              },
              {
                number: 102,
                url: "https://jenkins.example.com/job/my-job/102/",
                result: "FAILURE",
                timestamp: 1020,
                duration: 8_000,
                actions: [
                  {
                    parameters: [
                      { name: "BRANCH", value: "main" },
                      { name: "DEPLOY_ENV", value: "staging" },
                    ],
                  },
                ],
              },
              {
                number: 101,
                url: "https://jenkins.example.com/job/my-job/101/",
                result: "SUCCESS",
                timestamp: 1010,
                duration: 6_000,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://jenkins.example.com/job/my-job/102/wfapi/describe") {
        return new Response(
          JSON.stringify({
            stages: [
              {
                name: "Build",
                status: "SUCCESS",
              },
              {
                name: "Deploy",
                status: "FAILED",
                _links: {
                  self: {
                    href: "/job/my-job/102/execution/node/12/wfapi/describe",
                  },
                },
              },
            ],
            queueDurationMillis: 2000,
          }),
          { status: 200 },
        );
      }
      if (url === "https://jenkins.example.com/job/my-job/101/wfapi/describe") {
        return new Response(
          JSON.stringify({
            stages: [
              {
                name: "Deploy",
                status: "SUCCESS",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (
        url ===
        "https://jenkins.example.com/job/my-job/102/execution/node/12/wfapi/describe"
      ) {
        return new Response(
          JSON.stringify({
            name: "Deploy",
            status: "FAILED",
            stageFlowNodes: [
              {
                name: "Deploy to ECS",
                status: "FAILED",
                error: {
                  message: "task definition validation failed",
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    const page = await client.listBuildHistory(
      "https://jenkins.example.com/job/my-job/",
      {
        offset: 1,
        limit: 2,
      },
    );

    expect(page.total).toBe(3);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(2);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrevious).toBe(true);
    expect(page.builds).toHaveLength(2);
    expect(page.builds[0]).toMatchObject({
      buildNumber: 102,
      result: "FAILURE",
      branch: "main",
      failure: {
        stageName: "Deploy",
        stepName: "Deploy to ECS",
        reason: "task definition validation failed",
      },
      stages: [
        {
          name: "Build",
          status: "SUCCESS",
        },
        {
          name: "Deploy",
          status: "FAILED",
        },
      ],
    });
    expect(page.builds[1]).toMatchObject({
      buildNumber: 101,
      result: "SUCCESS",
      stages: [
        {
          name: "Deploy",
          status: "SUCCESS",
        },
      ],
    });
  });
});

describe("JenkinsClient listNodes", () => {
  test("normalizes computers and derives per-node executor usage", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith("https://jenkins.example.com/computer/api/json")) {
        return new Response(
          JSON.stringify({
            busyExecutors: 1,
            totalExecutors: 6,
            computer: [
              {
                displayName: "built-in",
                offline: false,
                temporarilyOffline: false,
                numExecutors: 2,
                assignedLabels: [{ name: "master" }, { name: "built-in" }],
                executors: [
                  {
                    currentExecutable: {
                      url: "https://jenkins.example.com/job/api/42/",
                    },
                  },
                  { currentExecutable: null },
                ],
                oneOffExecutors: [],
              },
              {
                displayName: "agent-2",
                offline: true,
                temporarilyOffline: true,
                offlineCauseReason: "Disconnected by admin",
                numExecutors: 4,
                assignedLabels: [{ name: "linux" }, { name: "docker" }],
                executors: [
                  { currentExecutable: null },
                  { currentExecutable: null },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    const summary = await client.listNodes();

    expect(summary.totalNodes).toBe(2);
    expect(summary.offlineNodes).toBe(1);
    expect(summary.busyExecutors).toBe(1);
    expect(summary.totalExecutors).toBe(6);
    expect(summary.nodes[0]).toMatchObject({
      displayName: "built-in",
      offline: false,
      temporarilyOffline: false,
      numExecutors: 2,
      busyExecutors: 1,
      totalExecutors: 2,
      labels: ["master", "built-in"],
    });
    expect(summary.nodes[1]).toMatchObject({
      displayName: "agent-2",
      offline: true,
      temporarilyOffline: true,
      offlineCauseReason: "Disconnected by admin",
      busyExecutors: 0,
      totalExecutors: 4,
      labels: ["linux", "docker"],
    });
  });
});
