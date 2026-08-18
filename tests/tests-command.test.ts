import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import { runTests } from "../src/commands/tests";
import type { EnvConfig } from "../src/env";
import { JenkinsClient } from "../src/jenkins/client";
import type { BuildTestReport } from "../src/types/jenkins";

const TEST_ENV: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "tester",
  jenkinsApiToken: "token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 1,
};
const BUILD_URL = "https://jenkins.example.com/job/api/5/";
const REPORT_URL = `${BUILD_URL}testReport/`;

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

const REPORT: BuildTestReport = {
  buildNumber: 5,
  buildUrl: BUILD_URL,
  buildResult: "UNSTABLE",
  total: 3,
  passed: 1,
  failed: 1,
  skipped: 1,
  durationMs: 1_500,
  reportUrl: REPORT_URL,
  failures: [
    {
      suite: "checkout",
      className: "CartTest",
      name: "rejects expired card",
      durationMs: 120,
      message: "expected true\nbut got false",
      stackTrace: "line one\nline two",
    },
  ],
};

describe("JenkinsClient.getTestReport", () => {
  test("fetches counts only for summary mode", async () => {
    const fetchMock = installResponse({
      failCount: 1,
      skipCount: 1,
      totalCount: 4,
      duration: 1.25,
    });

    const report = await client().getTestReport(BUILD_URL, {
      buildNumber: 5,
      buildResult: "UNSTABLE",
    });

    expect(report).toEqual({
      buildNumber: 5,
      buildUrl: BUILD_URL,
      buildResult: "UNSTABLE",
      total: 4,
      passed: 2,
      failed: 1,
      skipped: 1,
      durationMs: 1_250,
      reportUrl: REPORT_URL,
    });
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain(
      "failCount%2CpassCount%2CskipCount%2CtotalCount%2Cduration",
    );
    expect(requestUrl).not.toContain("suites");
  });

  test("normalizes only failing cases when requested", async () => {
    const fetchMock = installResponse({
      failCount: 2,
      skipCount: 1,
      totalCount: 4,
      duration: 2.345,
      suites: [
        {
          name: "checkout",
          cases: [
            { name: "passes", status: "PASSED", duration: 0.1 },
            {
              className: "CartTest",
              name: "rejects expired card",
              status: "FAILED",
              duration: 0.12,
              errorDetails: "expected true\nbut got false",
              errorStackTrace: "line one\nline two",
            },
            {
              className: "CartTest",
              name: "rejects duplicate card",
              status: "REGRESSION",
              duration: 0.2,
            },
          ],
        },
      ],
    });

    const report = await client().getTestReport(BUILD_URL, {
      includeFailures: true,
    });

    expect(report.failures).toEqual([
      {
        suite: "checkout",
        className: "CartTest",
        name: "rejects expired card",
        durationMs: 120,
        message: "expected true\nbut got false",
        stackTrace: "line one\nline two",
      },
      {
        suite: "checkout",
        className: "CartTest",
        name: "rejects duplicate card",
        durationMs: 200,
        message: undefined,
        stackTrace: undefined,
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("suites%5B");
  });

  test("collects failing cases from matrix child reports", async () => {
    const fetchMock = installResponse({
      failCount: 1,
      skipCount: 0,
      totalCount: 2,
      duration: 1.5,
      childReports: [
        {
          result: {
            suites: [
              {
                name: "linux",
                cases: [
                  { name: "passes", status: "PASSED", duration: 0.1 },
                  {
                    className: "CartTest",
                    name: "rejects expired card",
                    status: "FAILED",
                    duration: 0.12,
                    errorDetails: "expected true",
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    const report = await client().getTestReport(BUILD_URL, {
      includeFailures: true,
    });

    expect(report.failures).toEqual([
      {
        suite: "linux",
        className: "CartTest",
        name: "rejects expired card",
        durationMs: 120,
        message: "expected true",
        stackTrace: undefined,
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("childReports%5B");
  });

  test.each([
    [404, "TEST_REPORT_NOT_FOUND"],
    [403, "TEST_REPORT_PERMISSION_DENIED"],
    [501, "TEST_REPORT_UNAVAILABLE"],
  ])("maps HTTP %i to %s", async (status, code) => {
    installResponse({}, status);

    expect(client().getTestReport(BUILD_URL)).rejects.toMatchObject({ code });
  });

  test("distinguishes a missing JUnit capability from an absent build report", async () => {
    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      return url.includes("pluginManager/api/json")
        ? Response.json({ plugins: [] })
        : Response.json({}, { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(client().getTestReport(BUILD_URL)).rejects.toMatchObject({
      code: "TEST_REPORT_UNAVAILABLE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("rejects incomplete counts and missing failed cases", async () => {
    installResponse({ failCount: 2, skipCount: 0, totalCount: 1 });
    expect(client().getTestReport(BUILD_URL)).rejects.toMatchObject({
      code: "TEST_REPORT_MALFORMED",
    });

    installResponse({
      failCount: 1,
      skipCount: 0,
      totalCount: 1,
      suites: [],
    });
    expect(
      client().getTestReport(BUILD_URL, { includeFailures: true }),
    ).rejects.toMatchObject({ code: "TEST_REPORT_MALFORMED" });
  });
});

describe("runTests", () => {
  test("renders summary and preserves multiline failure text", async () => {
    let output = "";
    await runTests({
      client: createClient({
        getBuildStatus: mock(async () => ({
          buildNumber: 5,
          buildUrl: BUILD_URL,
          result: "UNSTABLE",
          building: false,
        })),
        getTestReport: mock(async () => REPORT),
      }),
      env: TEST_ENV,
      buildUrl: BUILD_URL,
      failed: true,
      nonInteractive: true,
      write: (text) => {
        output += text;
      },
    });

    expect(output).toContain("Build: #5 (UNSTABLE)");
    expect(output).toContain("3 total | 1 passed | 1 failed | 1 skipped");
    expect(output).toContain("checkout > CartTest > rejects expired card");
    expect(output).toContain("expected true\nbut got false");
    expect(output).toContain("line one\nline two");
  });

  test("emits one JSON document and omits failures unless requested", async () => {
    let output = "";
    const report = { ...REPORT, failures: undefined };
    await runTests({
      client: createClient({
        getBuildStatus: mock(async () => ({
          buildNumber: 5,
          buildUrl: BUILD_URL,
          result: "SUCCESS",
          building: false,
        })),
        getTestReport: mock(async () => report),
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
      command: "tests",
      data: {
        build: { number: 5, url: BUILD_URL, result: "UNSTABLE" },
        summary: {
          total: 3,
          passed: 1,
          failed: 1,
          skipped: 1,
          durationMs: 1_500,
        },
        reportUrl: REPORT_URL,
      },
    });
  });

  test("uses the latest completed build when no exact build is selected", async () => {
    const getLastCompletedBuild = mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 5,
    }));
    const getTestReport = mock(async () => ({
      ...REPORT,
      failures: undefined,
    }));
    await runTests({
      client: createClient({
        getLastCompletedBuild,
        getBuildStatus: mock(async () => ({
          buildNumber: 5,
          result: "SUCCESS",
        })),
        getTestReport,
      }),
      env: TEST_ENV,
      jobUrl: "https://jenkins.example.com/job/api/",
      nonInteractive: true,
      write: () => {},
    });

    expect(getLastCompletedBuild).toHaveBeenCalledWith(
      "https://jenkins.example.com/job/api",
    );
    expect(getTestReport).toHaveBeenCalledWith(
      BUILD_URL,
      expect.objectContaining({ includeFailures: false }),
    );
  });

  test("keeps stable client errors in JSON", async () => {
    let output = "";
    const previousExitCode = process.exitCode;
    try {
      await runTests({
        client: createClient({
          getBuildStatus: mock(async () => ({ buildNumber: 5 })),
          getTestReport: mock(async () => {
            throw new CliError("No test report.", [], "TEST_REPORT_NOT_FOUND");
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
        error: { message: "No test report.", code: "TEST_REPORT_NOT_FOUND" },
      });
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
  });
});
