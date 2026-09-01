import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli";
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
  const objectHeaders = headers;
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
    expect(triggerCall?.[1]?.method).toBe("POST");
    expect(triggerCall?.[1]?.body).toBe("BRANCH=main");
    expect(readHeader(triggerCall?.[1], "Authorization")).toBe(
      `Basic ${Buffer.from("user:token").toString("base64")}`,
    );
  });

  test("never retries the trigger POST after a transport failure", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
      throw new Error("socket closed");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    await expect(
      client.triggerBuild("https://jenkins.example.com/job/my-job", {}),
    ).rejects.toThrow(CliError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(triggerCall?.[1]?.method).toBe("POST");
    expect(triggerCall?.[1]?.body).toBeUndefined();
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
    expect(readHeader(firstTriggerCall?.[1], "Jenkins-Crumb")).toBe(
      "stale-crumb",
    );
    expect(readHeader(secondTriggerCall?.[1], "Jenkins-Crumb")).toBe(
      "fresh-crumb",
    );
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
    expect(readHeader(triggerCall?.[1], "Jenkins-Crumb")).toBeUndefined();
  });

  test("surfaces Jenkins' x-error without adding a mapped hint", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("<html>generic error page</html>", {
        status: 400,
        headers: {
          "x-error":
            "Parameter BRANCH_TAG provided value 'no-such-branch' is invalid",
        },
      });
    }) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.triggerBuild("https://jenkins.example.com/job/my-job/", {
        BRANCH_TAG: "no-such-branch",
      }),
    );

    expect(error.message).toBe(
      "Jenkins returned HTTP 400 while trying to trigger build: Parameter BRANCH_TAG provided value 'no-such-branch' is invalid",
    );
    expect(error.hints).toEqual([]);
  });

  test("surfaces Jenkins' disabled-job detail from the 409 body", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        "<html><body>HTTP ERROR 409 URI: /job/demo-app-deploy STATUS: 409 MESSAGE: demo-app-deploy is not buildable SERVLET: Stapler</body></html>",
        { status: 409, headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.triggerBuild("https://jenkins.example.com/job/my-job/", {
        BRANCH_TAG: "main",
      }),
    );

    expect(error.message).toBe(
      "Jenkins returned HTTP 409 while trying to trigger build: demo-app-deploy is not buildable",
    );
    expect(error.hints).toEqual([]);
  });

  test("surfaces a plain-text controller response without mapping it", async () => {
    globalThis.fetch = mock(
      async () => new Response("Conflict", { status: 409 }),
    ) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.triggerBuild("https://jenkins.example.com/job/my-job/", {}),
    );

    expect(error.message).toBe(
      "Jenkins returned HTTP 409 while trying to trigger build: Conflict",
    );
    expect(error.hints).toEqual([]);
  });

  test("surfaces readable HTML from an unknown-job response", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          "<html><style>private-css</style><body><h1>Not Found</h1><p>This page may not exist, or you may not have permission.</p><script>private-script</script></body></html>",
          { status: 404, headers: { "content-type": "text/html" } },
        ),
    ) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.triggerBuild("https://jenkins.example.com/job/no-such-job/", {}),
    );

    expect(error.message).toBe(
      "Jenkins returned HTTP 404 while trying to trigger build: Not Found This page may not exist, or you may not have permission.",
    );
    expect(error.hints).toEqual([]);
  });

  test("surfaces compact JSON controller errors", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            message: "Build rejected",
            errors: [{ field: "BRANCH", reason: "unknown" }],
          }),
          {
            status: 422,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.triggerBuild("https://jenkins.example.com/job/my-job/", {}),
    );

    expect(error.message).toBe(
      'Jenkins returned HTTP 422 while trying to trigger build: {"message":"Build rejected","errors":[{"field":"BRANCH","reason":"unknown"}]}',
    );
    expect(error.hints).toEqual([]);
  });

  test("keeps the status-only fallback when Jenkins returns no detail", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 503 }),
    ) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.triggerBuild("https://jenkins.example.com/job/my-job/", {}),
    );

    expect(error.message).toBe(
      "Jenkins returned HTTP 503 while trying to trigger build.",
    );
    expect(error.hints).toEqual([]);
  });

  test("bounds controller detail and removes terminal control sequences", async () => {
    const detail = `rejected\u001b[31m${"x".repeat(2_100)}`;
    globalThis.fetch = mock(
      async () =>
        new Response("", {
          status: 400,
          headers: { "x-error": detail },
        }),
    ) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.triggerBuild("https://jenkins.example.com/job/my-job/", {}),
    );
    const renderedDetail = error.message.split(": ").at(-1) ?? "";

    expect(renderedDetail).toHaveLength(2_000);
    expect(renderedDetail).toStartWith("rejected");
    expect(renderedDetail).not.toContain("\u001b");
    expect(renderedDetail).toEndWith("…");
  });

  test("retains the auth error code while exposing Jenkins' response", async () => {
    globalThis.fetch = mock(
      async () => new Response("Forbidden by project policy", { status: 403 }),
    ) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.triggerBuild("https://jenkins.example.com/job/my-job/", {}),
    );

    expect(error.message).toBe(
      "Jenkins returned HTTP 403 while trying to trigger build: Forbidden by project policy",
    );
    expect(error.hints).toEqual([]);
    expect(error.code).toBe("JENKINS_AUTH_ERROR");
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
        "https://jenkins.example.com/job/my-job/api/json?tree=builds[number,url,result,building,timestamp,duration,estimatedDuration,actions[parameters[name,value],_class,lastBuiltRevision[SHA1,branch[name]],remoteUrls,causes[shortDescription,userId,userName]]]{0,2},lastBuild[number]"
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
  test("preserves the latest job result and disabled state", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("tree=disabled,lastBuild")) {
        return Response.json({
          disabled: true,
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

    const status = await client.getJobStatus(
      "https://jenkins.example.com/job/my-job/",
    );
    expect(status).toMatchObject({
      disabled: true,
      buildNumber: 9,
      result: "SUCCESS",
      building: false,
    });
    // The details fetch failed, so checkout evidence is unknown, not "none".
    expect(status.revisions).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "tree=disabled,lastBuild",
    );
  });

  test("returns disabled state for a job with no builds", async () => {
    const fetchMock = mock(async () =>
      Response.json({ disabled: true, lastBuild: null }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
    });

    expect(
      await client.getJobStatus("https://jenkins.example.com/job/my-job/"),
    ).toEqual({ disabled: true });
  });

  test("assigns a stable code when an exact build does not exist", async () => {
    globalThis.fetch = mock(
      async () => new Response("Not Found", { status: 404 }),
    ) as unknown as typeof fetch;
    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
    });

    const error = await captureCliError(
      client.getBuildStatus("https://jenkins.example.com/job/my-job/999/"),
    );

    expect(error.code).toBe("BUILD_NOT_FOUND");
  });

  test("extracts the trigger from the build's cause action", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/api/json?tree=")) {
        return Response.json({
          number: 156,
          url: "https://jenkins.example.com/job/my-job/156/",
          result: "SUCCESS",
          actions: [
            {},
            {
              _class: "hudson.model.CauseAction",
              causes: [
                {
                  shortDescription: "Started by user Jatin Bansal",
                  userId: "jatin",
                  userName: "Jatin Bansal",
                },
              ],
            },
          ],
        });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = createClient();

    const status = await client.getBuildStatus(
      "https://jenkins.example.com/job/my-job/156/",
    );

    expect(status.triggeredBy).toBe("Jatin Bansal");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "causes[shortDescription,userId,userName]",
    );
  });

  test("falls back to the cause description for non-user triggers", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/api/json?tree=")) {
        return Response.json({
          number: 157,
          url: "https://jenkins.example.com/job/my-job/157/",
          result: "SUCCESS",
          actions: [
            {
              _class: "hudson.model.CauseAction",
              causes: [
                {
                  shortDescription: "Started by timer",
                },
              ],
            },
          ],
        });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = createClient();

    const status = await client.getBuildStatus(
      "https://jenkins.example.com/job/my-job/157/",
    );

    expect(status.triggeredBy).toBe("timer");
  });

  test("merges git-plugin revisions by commit SHA", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/api/json?tree=")) {
        return Response.json({
          number: 42,
          url: "https://jenkins.example.com/job/my-job/42/",
          result: "SUCCESS",
          actions: [
            {},
            {
              _class: "example.OtherScmAction",
              lastBuiltRevision: { SHA1: "ignored" },
              remoteUrls: ["https://example.com/ignored.git"],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: { SHA1: "a1b2c3d4" },
              remoteUrls: ["https://github.com/acme/backend-api.git"],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: {
                SHA1: "a1b2c3d4",
                branch: [{ name: "refs/remotes/origin/feature/test" }],
              },
              remoteUrls: [
                "https://github.com/acme/backend-api.git",
                "https://mirror.example.com/acme/backend-api.git",
              ],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: { SHA1: "a1b2c3d4" },
              remoteUrls: ["https://github.com/tools/replica.git"],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: {
                SHA1: "d4c3b2a1",
                branch: [{ name: "origin/main" }],
              },
              remoteUrls: ["https://github.com/acme/pipeline-definitions.git/"],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: { SHA1: "missing-remote" },
              remoteUrls: [],
            },
          ],
        });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = createClient();

    const status = await client.getBuildStatus(
      "https://jenkins.example.com/job/my-job/42/",
    );

    expect(status.revisions).toEqual([
      {
        // Merged with the later, richer BuildData for the same SHA: remote
        // URLs are unioned and its branch fills the gap.
        repo: "backend-api",
        remoteUrl: "https://github.com/acme/backend-api.git",
        remoteUrls: [
          "https://github.com/acme/backend-api.git",
          "https://mirror.example.com/acme/backend-api.git",
        ],
        branch: "refs/remotes/origin/feature/test",
        sha: "a1b2c3d4",
      },
      {
        // A distinct remote checked out at the same SHA stays separate.
        repo: "replica",
        remoteUrl: "https://github.com/tools/replica.git",
        remoteUrls: ["https://github.com/tools/replica.git"],
        branch: undefined,
        sha: "a1b2c3d4",
      },
      {
        // repo strips the trailing slash and ".git" from the remote URL.
        repo: "pipeline-definitions",
        remoteUrl: "https://github.com/acme/pipeline-definitions.git/",
        remoteUrls: ["https://github.com/acme/pipeline-definitions.git/"],
        branch: "origin/main",
        sha: "d4c3b2a1",
      },
      {
        // Checkout evidence without remote URLs keeps its SHA; repo,
        // remoteUrl, and branch are omitted.
        repo: undefined,
        remoteUrl: undefined,
        remoteUrls: [],
        branch: undefined,
        sha: "missing-remote",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "actions[parameters[name,value],_class,lastBuiltRevision[SHA1,branch[name]],remoteUrls,causes[shortDescription,userId,userName]]",
    );
  });

  test("bridges overlapping revision groups, redacts credentials, and handles SCP remotes", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/api/json?tree=")) {
        return Response.json({
          number: 7,
          url: "https://jenkins.example.com/job/my-job/7/",
          result: "SUCCESS",
          actions: [
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: {
                SHA1: "feedbeef",
                branch: [{ name: "origin/main" }],
              },
              remoteUrls: [
                "https://ci-user:secret-token@git.example.com/acme/api.git",
              ],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: { SHA1: "cafe1234" },
              remoteUrls: ["git@git.example.com:tooling.git"],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: { SHA1: "bridge99" },
              remoteUrls: ["https://a.example.com/x.git"],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: { SHA1: "bridge99" },
              remoteUrls: ["https://b.example.com/x-mirror.git"],
            },
            {
              _class: "hudson.plugins.git.util.BuildData",
              lastBuiltRevision: { SHA1: "bridge99" },
              remoteUrls: [
                "https://a.example.com/x.git",
                "https://b.example.com/x-mirror.git",
              ],
            },
          ],
        });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = createClient();

    const status = await client.getBuildStatus(
      "https://jenkins.example.com/job/my-job/7/",
    );

    expect(JSON.stringify(status)).not.toContain("secret-token");
    expect(status.revisions).toEqual([
      {
        repo: "api",
        remoteUrl: "https://git.example.com/acme/api.git",
        remoteUrls: ["https://git.example.com/acme/api.git"],
        branch: "origin/main",
        sha: "feedbeef",
      },
      {
        repo: "tooling",
        remoteUrl: "git@git.example.com:tooling.git",
        remoteUrls: ["git@git.example.com:tooling.git"],
        branch: undefined,
        sha: "cafe1234",
      },
      {
        // The third action bridges the first two disjoint groups.
        repo: "x",
        remoteUrl: "https://a.example.com/x.git",
        remoteUrls: [
          "https://a.example.com/x.git",
          "https://b.example.com/x-mirror.git",
        ],
        branch: undefined,
        sha: "bridge99",
      },
    ]);
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

  test("follows the raw Pipeline node console URL with byte offsets", async () => {
    const fetchMock = mock(async (_input: FetchInput) =>
      Promise.resolve(new Response("🚀\n", { headers: {} })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
    });

    const chunk = await client.getPipelineNodeConsoleChunk(
      "/job/my-job/9/execution/node/12/log",
      4,
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://jenkins.example.com/job/my-job/9/execution/node/12/log/logText/progressiveText?start=4",
    );
    expect(chunk.nextStart).toBe(4 + Buffer.byteLength("🚀\n"));
  });

  test("requests bounded timestamped raw log lines from Timestamper", async () => {
    const fetchMock = mock(async (_input: FetchInput) =>
      Promise.resolve(
        new Response("2026-08-01T12:00:00.000Z  output\n", { status: 200 }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
    });

    await client.getConsoleTimestamps(
      "https://jenkins.example.com/job/my-job/9/",
      { endLine: 17, appendLog: true },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://jenkins.example.com/job/my-job/9/timestamps/?time=yyyy-MM-dd%27T%27HH%3Amm%3Ass.SSSXXX&timeZone=UTC&endLine=17&appendLog=true",
    );
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

      expect(readHeader(fetchMock.mock.calls[0]?.[1], "Authorization")).toBe(
        `Basic ${Buffer.from("user:token").toString("base64")}`,
      );
      expect(await Bun.file(destination).text()).toBe("artifact contents\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("JenkinsClient POST with crumb", () => {
  test("uses the same x-error extraction for other POST operations", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("", {
        status: 400,
        headers: { "x-error": "Build cannot be stopped in its current state" },
      });
    }) as unknown as typeof fetch;
    const client = createClient();

    const error = await captureCliError(
      client.stopBuild("https://jenkins.example.com/job/my-job/123/"),
    );

    expect(error.message).toBe(
      "Jenkins returned HTTP 400 while trying to stop build: Build cannot be stopped in its current state",
    );
    expect(error.hints).toEqual([]);
  });

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
    expect(readHeader(firstStopCall?.[1], "Jenkins-Crumb")).toBe("stale-crumb");
    expect(readHeader(secondStopCall?.[1], "Jenkins-Crumb")).toBe(
      "fresh-crumb",
    );
  });
});

function createClient(): JenkinsClient {
  return new JenkinsClient({
    baseUrl: "https://jenkins.example.com",
    user: "user",
    apiToken: "token",
    timeoutMs: 1_000,
  });
}

async function captureCliError(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("Expected the Jenkins request to fail.");
}

describe("JenkinsClient listBuildHistory", () => {
  test("keeps hasNext when the lookahead entry is malformed", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("{0,3}")) {
        return Response.json({
          builds: [
            { number: 5, url: "https://jenkins.example.com/job/my-job/5/" },
            { number: 4, url: "https://jenkins.example.com/job/my-job/4/" },
            { number: 3 },
          ],
        });
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
      { offset: 0, limit: 2 },
    );
    expect(page.hasNext).toBe(true);
    expect(page.builds.map((build) => build.buildNumber)).toEqual([5, 4]);
  });

  test("never promotes the lookahead build into the current page", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("{0,3}")) {
        return Response.json({
          builds: [
            { number: 5, url: "https://jenkins.example.com/job/my-job/5/" },
            { number: 4 },
            { number: 3, url: "https://jenkins.example.com/job/my-job/3/" },
          ],
        });
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
      { offset: 0, limit: 2 },
    );
    expect(page.hasNext).toBe(true);
    expect(page.builds.map((build) => build.buildNumber)).toEqual([5]);
  });

  test("windows client-side when the controller ignores the range spec", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("{5,11}")) {
        return Response.json({
          builds: Array.from({ length: 12 }, (_, index) => ({
            number: 12 - index,
            url: `https://jenkins.example.com/job/my-job/${12 - index}/`,
          })),
        });
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
      { offset: 5, limit: 5 },
    );
    expect(page.hasNext).toBe(true);
    expect(page.builds.map((build) => build.buildNumber)).toEqual([
      7, 6, 5, 4, 3,
    ]);
  });

  test("windows client-side even when the ignored-range response is short", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("{5,11}")) {
        return Response.json({
          builds: Array.from({ length: 6 }, (_, index) => ({
            number: 6 - index,
            url: `https://jenkins.example.com/job/my-job/${6 - index}/`,
          })),
          lastBuild: { number: 6 },
        });
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
      { offset: 5, limit: 5 },
    );
    expect(page.hasNext).toBe(false);
    expect(page.builds.map((build) => build.buildNumber)).toEqual([1]);
  });

  test("keeps an honoured range window that happens to start mid-history", async () => {
    const fetchMock = mock(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("{5,11}")) {
        return Response.json({
          builds: Array.from({ length: 6 }, (_, index) => ({
            number: 15 - index,
            url: `https://jenkins.example.com/job/my-job/${15 - index}/`,
          })),
          lastBuild: { number: 20 },
        });
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
      { offset: 5, limit: 5 },
    );
    expect(page.hasNext).toBe(true);
    expect(page.builds.map((build) => build.buildNumber)).toEqual([
      15, 14, 13, 12, 11,
    ]);
  });

  test("returns paginated build history with failed step details", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url ===
        "https://jenkins.example.com/job/my-job/api/json?tree=builds[number,url,result,building,timestamp,duration,estimatedDuration,actions[parameters[name,value],_class,lastBuiltRevision[SHA1,branch[name]],remoteUrls,causes[shortDescription,userId,userName]]]{1,4},lastBuild[number]"
      ) {
        return new Response(
          JSON.stringify({
            builds: [
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
                  {},
                  {
                    _class: "hudson.plugins.git.util.BuildData",
                    lastBuiltRevision: {
                      SHA1: "a1b2c3d4",
                      branch: [{ name: "origin/main" }],
                    },
                    remoteUrls: ["https://github.com/acme/backend-api.git"],
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
              {
                number: 100,
                url: "https://jenkins.example.com/job/my-job/100/",
                result: "SUCCESS",
                timestamp: 1000,
                duration: 5_000,
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

    expect(page.offset).toBe(1);
    expect(page.limit).toBe(2);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrevious).toBe(true);
    expect(page.builds).toHaveLength(2);
    expect(page.builds[0]).toMatchObject({
      buildNumber: 102,
      result: "FAILURE",
      branch: "main",
      revisions: [
        {
          repo: "backend-api",
          remoteUrl: "https://github.com/acme/backend-api.git",
          remoteUrls: ["https://github.com/acme/backend-api.git"],
          branch: "origin/main",
          sha: "a1b2c3d4",
        },
      ],
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
      revisions: [],
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

describe("JenkinsClient getJobConfigXml", () => {
  test("fetches config.xml from the job URL with basic auth", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
      return new Response("<project/>", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    const xml = await client.getJobConfigXml(
      "https://jenkins.example.com/job/team/job/api",
    );

    expect(xml).toBe("<project/>");
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://jenkins.example.com/job/team/job/api/config.xml",
    );
    expect(readHeader(call?.[1], "Authorization")).toBe(
      `Basic ${Buffer.from("user:token").toString("base64")}`,
    );
  });

  test("raises a CliError on HTTP errors", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJobConfigXml("https://jenkins.example.com/job/missing"),
    ).rejects.toThrow(CliError);
  });
});

describe("JenkinsClient createItem", () => {
  test("posts config XML with an application/xml content type", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
      return new Response("", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    const url = await client.createItem({
      name: "new job",
      configXml: "<project/>",
    });

    expect(url).toBe("https://jenkins.example.com/job/new%20job/");
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://jenkins.example.com/createItem?name=new+job",
    );
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.body).toBe("<project/>");
    expect(readHeader(call?.[1], "Content-Type")).toBe("application/xml");
  });

  test("copies an existing item with mode=copy and no body", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
      return new Response("", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    const url = await client.createItem({
      name: "copy-job",
      copyFrom: "/team/api",
      parentUrl: "https://jenkins.example.com/job/team",
    });

    expect(url).toBe("https://jenkins.example.com/job/team/job/copy-job/");
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(
      "https://jenkins.example.com/job/team/createItem?name=copy-job&mode=copy&from=%2Fteam%2Fapi",
    );
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.body).toBeUndefined();
    expect(readHeader(call?.[1], "Content-Type")).toBeUndefined();
  });

  test("never retries the create POST after a transport failure", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
      throw new Error("socket closed");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    await expect(
      client.createItem({ name: "once", configXml: "<project/>" }),
    ).rejects.toThrow(CliError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries with a fresh crumb on 403, then surfaces HTTP errors", async () => {
    let createAttempts = 0;
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      if (typeof input === "string" && input.includes("crumbIssuer")) {
        return new Response(
          JSON.stringify({ crumbRequestField: "Jenkins-Crumb", crumb: "c1" }),
          { status: 200 },
        );
      }
      createAttempts += 1;
      return new Response("", { status: createAttempts === 1 ? 403 : 400 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
      useCrumb: true,
    });

    await expect(
      client.createItem({ name: "bad", configXml: "<project/>" }),
    ).rejects.toThrow(CliError);
    expect(createAttempts).toBe(2);
  });
});
