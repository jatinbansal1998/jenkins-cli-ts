import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-analytics-home-"));
process.env.HOME = tempHome;

const {
  recordJenkinsApiCall,
  recordJenkinsApiFailure,
  resetAnalyticsForTests,
  runWithAnalytics,
  updateAnalyticsContext,
} = await import("../src/analytics");

const realFetch = globalThis.fetch;
const originalEnv = { ...process.env };
type FetchInput = Parameters<typeof fetch>[0];

beforeEach(() => {
  mock.clearAllMocks();
  resetAnalyticsForTests();
  fs.rmSync(join(tempHome, ".config"), { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv, {
    HOME: tempHome,
    JENKINS_POSTHOG_API_KEY: "phc_test_key",
  });
  delete process.env.JENKINS_POSTHOG_HOST;
  delete process.env.JENKINS_ANALYTICS_DISABLED;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("analytics", () => {
  test("captures privacy-safe command payloads", async () => {
    const fetchMock = mock(async (_input: FetchInput, init?: RequestInit) => {
      return new Response(init?.body ?? "", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runWithAnalytics(
      {
        command: "list",
        interactive: false,
      },
      async () => {
        updateAnalyticsContext({
          used_profile: true,
          used_auth_override: false,
          use_crumb: true,
        });
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://t.jatinbansal.com/batch/");
    const payload = JSON.parse(String(init?.body)) as {
      batch: Array<{ event: string; properties: Record<string, unknown> }>;
    };

    expect(payload.batch.map((event) => event.event)).toEqual([
      "command_started",
      "command_finished",
    ]);

    const finished = payload.batch[1]?.properties ?? {};
    expect(finished.command).toBe("list");
    expect(finished.interactive).toBeFalse();
    expect(finished.tty).toBeDefined();
    expect(finished.cli_version).toBeString();
    expect(finished.used_profile).toBeTrue();
    expect(finished.used_auth_override).toBeFalse();
    expect(finished.use_crumb).toBeTrue();
    expect(finished.jenkins_url).toBeUndefined();
    expect(finished.jenkins_user).toBeUndefined();
    expect(finished.jenkins_api_token).toBeUndefined();
  });

  test("captures API failure summaries separately from command outcome", async () => {
    const fetchMock = mock(async (_input: FetchInput, init?: RequestInit) => {
      return new Response(init?.body ?? "", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runWithAnalytics(
        {
          command: "build",
          interactive: false,
        },
        async () => {
          recordJenkinsApiCall();
          recordJenkinsApiCall();
          recordJenkinsApiFailure({
            operation: "trigger_build",
            errorType: "http_error",
            httpStatus: 500,
            retryAttempted: true,
          });
          throw new Error(
            "Jenkins returned HTTP 500 while trying to trigger build.",
          );
        },
      ),
    ).rejects.toThrow(
      "Jenkins returned HTTP 500 while trying to trigger build.",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://t.jatinbansal.com/batch/");
    const payload = JSON.parse(String(init?.body)) as {
      batch: Array<{ event: string; properties: Record<string, unknown> }>;
    };

    expect(payload.batch.map((event) => event.event)).toEqual([
      "command_started",
      "jenkins_api_failure",
      "command_finished",
      "command_api_summary",
    ]);

    const failure = payload.batch[1]?.properties ?? {};
    expect(failure.operation).toBe("trigger_build");
    expect(failure.error_type).toBe("http_error");
    expect(failure.http_status).toBe(500);
    expect(failure.retry_attempted).toBeTrue();

    const finished = payload.batch[2]?.properties ?? {};
    expect(finished.outcome).toBe("jenkins_api_error");

    const summary = payload.batch[3]?.properties ?? {};
    expect(summary.api_call_count).toBe(2);
    expect(summary.api_failure_count).toBe(1);
  });

  test("supports analytics opt-out", async () => {
    process.env.JENKINS_ANALYTICS_DISABLED = "true";

    const fetchMock = mock(async (_input: FetchInput, init?: RequestInit) => {
      return new Response(init?.body ?? "", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runWithAnalytics(
      {
        command: "list",
        interactive: false,
      },
      async () => {},
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
