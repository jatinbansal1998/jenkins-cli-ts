import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import { runChanges } from "../src/commands/changes";
import type { EnvConfig } from "../src/env";
import { JenkinsClient } from "../src/jenkins/client";
import type { BuildChangesReport } from "../src/types/jenkins";

const TEST_ENV: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "tester",
  jenkinsApiToken: "token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 1,
};
const BUILD_URL = "https://jenkins.example.com/job/api/5/";

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(): JenkinsClient {
  return new JenkinsClient({
    baseUrl: TEST_ENV.jenkinsUrl,
    user: TEST_ENV.jenkinsUser,
    apiToken: TEST_ENV.jenkinsApiToken,
    timeoutMs: 50,
  });
}

function installResponse(body: unknown, status = 200): ReturnType<typeof mock> {
  const fetchMock = mock(async () => Response.json(body, { status }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

const REPORT: BuildChangesReport = {
  buildNumber: 5,
  buildUrl: BUILD_URL,
  causes: [{ type: "user", summary: "Started by user Jane", userId: "jane" }],
  changeSets: [
    {
      sourceType: "git",
      revision: {
        repo: "backend-api",
        remoteUrl: "https://github.com/acme/backend-api.git",
        remoteUrls: ["https://github.com/acme/backend-api.git"],
        branch: "origin/main",
        sha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
      },
      changes: [
        {
          id: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
          author: "Jane Doe",
          timestampMs: 1_700_000_000_000,
          message: "Fix login\n\nLonger body.",
        },
      ],
    },
  ],
  limit: 20,
  returned: 1,
  total: 1,
  truncated: false,
};

describe("JenkinsClient.getBuildChanges", () => {
  test("requests bounded causes and change sets without paths by default", async () => {
    const fetchMock = installResponse({ number: 5, url: BUILD_URL });

    await client().getBuildChanges(BUILD_URL, { limit: 10 });

    const requestUrl = decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl).toContain(
      "causes[_class,shortDescription,userId,userName,upstreamProject,upstreamBuild]",
    );
    expect(requestUrl).toContain("{0,11}");
    expect(requestUrl).toContain("changeSet[");
    expect(requestUrl).toContain("changeSets[");
    expect(requestUrl).toContain(
      "lastBuiltRevision[SHA1,branch[name]],remoteUrls",
    );
    expect(requestUrl).not.toContain("affectedPaths");
  });

  test("requests affected paths only when asked", async () => {
    const fetchMock = installResponse({ number: 5, url: BUILD_URL });

    await client().getBuildChanges(BUILD_URL, {
      limit: 10,
      includePaths: true,
    });

    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain(
      "affectedPaths",
    );
  });

  test("normalizes Pipeline change sets, causes, and id fallbacks", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      actions: [
        {
          causes: [
            {
              _class: "hudson.model.Cause$UserIdCause",
              shortDescription: "Started by user Jane",
              userId: "jane",
              userName: "Jane Doe",
            },
            {
              _class: "hudson.model.Cause$UpstreamCause",
              shortDescription: 'Started by upstream project "api" build 12',
              upstreamProject: "api",
              upstreamBuild: 12,
            },
            {
              _class: "org.acme.CustomCause",
              shortDescription: "Started by a custom plugin",
            },
          ],
        },
      ],
      changeSets: [
        {
          kind: "git",
          items: [
            {
              commitId: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
              author: { fullName: "Jane Doe" },
              timestamp: 1_700_000_000_000,
              msg: "Fix login",
              comment: "Fix login\n\nLonger body.\n",
            },
            {
              id: 42,
              timestamp: -1,
              msg: "No author or commitId",
            },
          ],
        },
        {
          items: [{ revision: 1204, msg: "svn-style entry" }],
        },
      ],
    });

    const report = await client().getBuildChanges(BUILD_URL, { limit: 20 });

    expect(report.causes).toEqual([
      {
        type: "user",
        summary: "Started by user Jane",
        userId: "jane",
        userName: "Jane Doe",
        upstreamJob: undefined,
        upstreamBuild: undefined,
      },
      {
        type: "upstream",
        summary: 'Started by upstream project "api" build 12',
        userId: undefined,
        userName: undefined,
        upstreamJob: "api",
        upstreamBuild: 12,
      },
      {
        type: "other",
        summary: "Started by a custom plugin",
        userId: undefined,
        userName: undefined,
        upstreamJob: undefined,
        upstreamBuild: undefined,
      },
    ]);
    expect(report.changeSets).toEqual([
      {
        sourceType: "git",
        changes: [
          {
            id: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
            author: "Jane Doe",
            timestampMs: 1_700_000_000_000,
            message: "Fix login\n\nLonger body.",
          },
          {
            id: "42",
            author: undefined,
            timestampMs: undefined,
            message: "No author or commitId",
          },
        ],
      },
      {
        sourceType: "unknown",
        changes: [
          {
            id: "1204",
            author: undefined,
            timestampMs: undefined,
            message: "svn-style entry",
          },
        ],
      },
    ]);
    expect(report).toMatchObject({
      buildNumber: 5,
      buildUrl: BUILD_URL,
      limit: 20,
      returned: 3,
      total: 3,
      truncated: false,
    });
  });

  test("normalizes the freestyle single change set and keeps paths when requested", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      changeSet: {
        kind: "git",
        items: [
          {
            commitId: "deadbeef",
            msg: "Touch files",
            affectedPaths: ["src/a.ts", "src/b.ts"],
          },
        ],
      },
    });

    const report = await client().getBuildChanges(BUILD_URL, {
      limit: 20,
      includePaths: true,
    });

    expect(report.changeSets).toEqual([
      {
        sourceType: "git",
        changes: [
          {
            id: "deadbeef",
            author: undefined,
            timestampMs: undefined,
            message: "Touch files",
            paths: ["src/a.ts", "src/b.ts"],
          },
        ],
      },
    ]);
  });

  test("degrades non-string scalar fields to undefined instead of crashing", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      actions: [
        {
          causes: [
            { _class: 7, shortDescription: 9, userId: 1, userName: true },
          ],
        },
      ],
      changeSet: {
        kind: 3,
        items: [
          {
            commitId: 123,
            author: "not-an-object",
            comment: 42,
            msg: 42,
          },
        ],
      },
    });

    const report = await client().getBuildChanges(BUILD_URL, { limit: 20 });

    expect(report.causes).toEqual([
      {
        type: "other",
        summary: undefined,
        userId: undefined,
        userName: undefined,
        upstreamJob: undefined,
        upstreamBuild: undefined,
      },
    ]);
    expect(report.changeSets).toEqual([
      {
        sourceType: "unknown",
        changes: [
          {
            id: "123",
            author: undefined,
            timestampMs: undefined,
            message: undefined,
          },
        ],
      },
    ]);
  });

  test("treats a build without SCM data as a successful empty result", async () => {
    installResponse({ number: 5, url: BUILD_URL });

    const report = await client().getBuildChanges(BUILD_URL, { limit: 20 });

    expect(report).toEqual({
      buildNumber: 5,
      buildUrl: BUILD_URL,
      causes: [],
      changeSets: [],
      limit: 20,
      returned: 0,
      total: 0,
      truncated: false,
    });
  });

  test("merges interleaved multi-SCM sets chronologically before limiting", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      changeSets: [
        {
          kind: "git",
          items: [
            { commitId: "c300", timestamp: 300 },
            { commitId: "c400", timestamp: 400 },
          ],
        },
        {
          kind: "git",
          items: [{ commitId: "c100", timestamp: 100 }, { commitId: "c-late" }],
        },
      ],
    });

    const report = await client().getBuildChanges(BUILD_URL, { limit: 2 });

    // The oldest commits win the limited window regardless of which change
    // set carried them; entries without a timestamp sort last.
    expect(
      report.changeSets.flatMap((changeSet) =>
        changeSet.changes.map((change) => change.id),
      ),
    ).toEqual(["c300", "c100"]);
    expect(report.truncated).toBe(true);
  });

  test("preserves SCM groups and attaches each checkout revision", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      actions: [
        {
          _class: "hudson.plugins.git.util.BuildData",
          lastBuiltRevision: {
            SHA1: "c400",
            branch: [{ name: "origin/main" }],
          },
          remoteUrls: ["https://github.com/acme/backend-api.git"],
        },
        {
          _class: "hudson.plugins.git.util.BuildData",
          lastBuiltRevision: {
            SHA1: "c200",
            branch: [{ name: "origin/main" }],
          },
          remoteUrls: ["https://github.com/acme/pipeline-definitions.git"],
        },
      ],
      changeSets: [
        {
          kind: "git",
          items: [
            { commitId: "c300", timestamp: 300 },
            { commitId: "c400", timestamp: 400 },
          ],
        },
        {
          kind: "git",
          items: [
            { commitId: "c100", timestamp: 100 },
            { commitId: "c200", timestamp: 200 },
          ],
        },
      ],
    });

    const report = await client().getBuildChanges(BUILD_URL, { limit: 3 });

    expect(
      report.changeSets.map((changeSet) => ({
        repo: changeSet.revision?.repo,
        sha: changeSet.revision?.sha,
        changes: changeSet.changes.map((change) => change.id),
      })),
    ).toEqual([
      { repo: "backend-api", sha: "c400", changes: ["c300"] },
      {
        repo: "pipeline-definitions",
        sha: "c200",
        changes: ["c100", "c200"],
      },
    ]);
  });

  test("does not guess repositories when Git checkouts share a revision", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      actions: [
        {
          _class: "hudson.plugins.git.util.BuildData",
          lastBuiltRevision: { SHA1: "shared" },
          remoteUrls: ["https://github.com/acme/backend-api.git"],
        },
        {
          _class: "hudson.plugins.git.util.BuildData",
          lastBuiltRevision: { SHA1: "shared" },
          remoteUrls: ["https://github.com/acme/pipeline-definitions.git"],
        },
      ],
      changeSets: [
        { kind: "git", items: [{ commitId: "shared" }] },
        { kind: "git", items: [{ commitId: "shared" }] },
      ],
    });

    const report = await client().getBuildChanges(BUILD_URL, { limit: 20 });

    expect(report.changeSets).toHaveLength(2);
    expect(
      report.changeSets.every((changeSet) => changeSet.revision === undefined),
    ).toBe(true);
  });

  test("caps affected paths per change and flags the truncation", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      changeSet: {
        kind: "git",
        items: [
          {
            commitId: "big",
            affectedPaths: Array.from({ length: 101 }, (_, i) => `f/${i}.ts`),
          },
          { commitId: "small", affectedPaths: ["one.ts"] },
        ],
      },
    });

    const report = await client().getBuildChanges(BUILD_URL, {
      limit: 20,
      includePaths: true,
    });

    expect(report.changeSets[0]?.changes[0]?.paths).toHaveLength(100);
    expect(report.changeSets[0]?.changes[0]?.pathsTruncated).toBe(true);
    expect(report.changeSets[0]?.changes[1]?.paths).toEqual(["one.ts"]);
    expect(report.changeSets[0]?.changes[1]?.pathsTruncated).toBeUndefined();
  });

  test("truncates across change sets and drops the unknowable total", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      changeSets: [
        { kind: "git", items: [{ commitId: "c1" }, { commitId: "c2" }] },
        { kind: "git", items: [{ commitId: "c3" }] },
      ],
    });

    const report = await client().getBuildChanges(BUILD_URL, { limit: 2 });

    expect(
      report.changeSets.flatMap((changeSet) =>
        changeSet.changes.map((change) => change.id),
      ),
    ).toEqual(["c1", "c2"]);
    expect(report).toMatchObject({
      limit: 2,
      returned: 2,
      total: undefined,
      truncated: true,
    });
  });

  test("keeps the total when the build has exactly --limit changes", async () => {
    installResponse({
      number: 5,
      url: BUILD_URL,
      changeSets: [
        { kind: "git", items: [{ commitId: "c1" }, { commitId: "c2" }] },
      ],
    });

    const report = await client().getBuildChanges(BUILD_URL, { limit: 2 });

    expect(report).toMatchObject({
      returned: 2,
      total: 2,
      truncated: false,
    });
  });

  test.each([
    [{ number: 5, changeSets: "garbage" }],
    [{ number: 5, changeSets: [{ kind: "git", items: "garbage" }] }],
    [{ number: 5, changeSet: { items: ["garbage"] } }],
  ])("rejects malformed change payloads", async (body) => {
    installResponse(body);

    expect(
      client().getBuildChanges(BUILD_URL, { limit: 20 }),
    ).rejects.toMatchObject({ code: "CHANGES_MALFORMED" });
  });

  test.each([
    [404, "BUILD_NOT_FOUND"],
    [403, "JENKINS_AUTH_ERROR"],
  ])("maps HTTP %i to %s", async (status, code) => {
    installResponse({}, status);

    expect(
      client().getBuildChanges(BUILD_URL, { limit: 20 }),
    ).rejects.toMatchObject({ code });
  });
});

describe("runChanges", () => {
  test("renders causes and an SCM-grouped change table", async () => {
    let output = "";
    await runChanges({
      client: createClient({
        getBuildChanges: mock(async () => REPORT),
      }),
      env: TEST_ENV,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      write: (text) => {
        output += text;
      },
    });

    expect(output).toContain(`Build: #5 (${BUILD_URL})`);
    expect(output).toContain("user: Started by user Jane");
    expect(output).toContain("Changes (1):");
    expect(output).toContain("SCM: backend-api (git)");
    expect(output).toContain("a1b2c3d4e5f6");
    expect(output).toContain("Jane Doe");
    expect(output).toContain("Fix login");
    expect(output).not.toContain("Longer body");
    expect(output).not.toContain("More changes exist");
  });

  test("renders affected paths when the report carries them", async () => {
    let output = "";
    await runChanges({
      client: createClient({
        getBuildChanges: mock(async () => ({
          ...REPORT,
          changeSets: [
            {
              ...REPORT.changeSets[0]!,
              changes: [
                {
                  ...REPORT.changeSets[0]!.changes[0]!,
                  paths: ["src/login.ts", "docs/auth.md"],
                },
              ],
            },
          ],
        })),
      }),
      env: TEST_ENV,
      buildUrl: BUILD_URL,
      paths: true,
      nonInteractive: true,
      write: (text) => {
        output += text;
      },
    });

    expect(output).toContain("Affected paths:");
    expect(output).toContain("  a1b2c3d4e5f6:");
    expect(output).toContain("    src/login.ts");
    expect(output).toContain("    docs/auth.md");
  });

  test("reports an empty build and flags truncation", async () => {
    let output = "";
    await runChanges({
      client: createClient({
        getBuildChanges: mock(async () => ({
          ...REPORT,
          causes: [],
          changeSets: [],
          returned: 0,
          total: 0,
        })),
      }),
      env: TEST_ENV,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      write: (text) => {
        output += text;
      },
    });
    expect(output).toContain("Caused by: unknown");
    expect(output).toContain("No changes in this build.");

    output = "";
    await runChanges({
      client: createClient({
        getBuildChanges: mock(async () => ({
          ...REPORT,
          limit: 1,
          total: undefined,
          truncated: true,
        })),
      }),
      env: TEST_ENV,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      write: (text) => {
        output += text;
      },
    });
    expect(output).toContain("Changes (first 1):");
    expect(output).toContain("More changes exist; showing the first 1.");
  });

  test("emits one JSON document preserving multiline messages", async () => {
    let output = "";
    await runChanges({
      client: createClient({
        getBuildChanges: mock(async () => REPORT),
      }),
      env: TEST_ENV,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      json: true,
      write: (text) => {
        output += text;
      },
    });

    expect(output.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output)).toEqual({
      ok: true,
      command: "changes",
      data: {
        build: { number: 5, url: BUILD_URL },
        causes: [
          { type: "user", summary: "Started by user Jane", userId: "jane" },
        ],
        changeSets: [
          {
            sourceType: "git",
            revision: {
              repo: "backend-api",
              remoteUrl: "https://github.com/acme/backend-api.git",
              remoteUrls: ["https://github.com/acme/backend-api.git"],
              branch: "origin/main",
              sha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
            },
            changes: [
              {
                id: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
                author: "Jane Doe",
                timestampMs: 1_700_000_000_000,
                message: "Fix login\n\nLonger body.",
              },
            ],
          },
        ],
        pagination: { limit: 20, returned: 1, total: 1, truncated: false },
      },
    });
  });

  test("uses the job's latest build when no exact build is selected", async () => {
    const getLastBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 5,
    }));
    const getBuildChanges = mock(async () => REPORT);
    await runChanges({
      client: createClient({ getLastBuild, getBuildChanges }),
      env: TEST_ENV,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
      write: () => {},
    });

    expect(getLastBuild).toHaveBeenCalledWith(
      "https://jenkins.example.com/job/api",
    );
    expect(getBuildChanges).toHaveBeenCalledWith(BUILD_URL, {
      limit: 20,
      includePaths: false,
    });
  });

  test("fails with a stable code when the job has no builds", async () => {
    expect(
      runChanges({
        client: createClient({ getLastBuild: mock(async () => null) }),
        env: TEST_ENV,
        jobUrl: "https://jenkins.example.com/job/api/",
        nonInteractive: true,
        write: () => {},
      }),
    ).rejects.toMatchObject({ code: "NO_BUILDS" });
  });

  test("rejects invalid limits before contacting Jenkins", async () => {
    for (const limit of [0, -1, 1.5, 1_001]) {
      expect(
        runChanges({
          client: createClient({}),
          env: TEST_ENV,
          buildUrl: BUILD_URL,
          limit,
          nonInteractive: true,
          write: () => {},
        }),
      ).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    }
  });

  test("keeps stable client errors in JSON", async () => {
    let output = "";
    const previousExitCode = process.exitCode;
    try {
      await runChanges({
        client: createClient({
          getBuildChanges: mock(async () => {
            throw new CliError("Malformed changes.", [], "CHANGES_MALFORMED");
          }),
        }),
        env: TEST_ENV,
        buildUrl: BUILD_URL,
        nonInteractive: true,
        json: true,
        write: (text) => {
          output += text;
        },
      });

      expect(JSON.parse(output)).toEqual({
        ok: false,
        error: { message: "Malformed changes.", code: "CHANGES_MALFORMED" },
      });
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
  });
});
