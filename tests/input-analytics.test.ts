import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";

const tempHome = fs.mkdtempSync(join(tmpdir(), "jenkins-cli-input-analytics-"));
process.env.HOME = tempHome;

const { resetAnalyticsForTests, runWithAnalytics } =
  await import("../src/analytics");
const { runInputApprove, runInputList } = await import("../src/commands/input");

const realFetch = globalThis.fetch;
const originalEnv = { ...process.env };
type FetchInput = Parameters<typeof fetch>[0];

const JENKINS_URL = "https://jenkins.example.com";
const BUILD_URL = `${JENKINS_URL}/job/deploy/128/`;
const SECRET_MESSAGE = "Deploy customer-acme hotfix to production?";
const SECRET_ID = "AcmeHotfixApproval";

const env: EnvConfig = {
  jenkinsUrl: JENKINS_URL,
  jenkinsUser: "ci-user",
  jenkinsApiToken: "token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

beforeEach(() => {
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

function client(submissionOutcome: "accepted" | "rejected"): JenkinsClient {
  return {
    getBuildStatus: mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 128,
      building: true,
      result: null,
    })),
    listPendingInputActions: mock(async () => [
      {
        id: SECRET_ID,
        message: SECRET_MESSAGE,
        parameters: [],
        proceedUrl: `${BUILD_URL}wfapi/inputSubmit?inputId=${SECRET_ID}`,
        abortUrl: `${BUILD_URL}input/${SECRET_ID}/abort`,
      },
    ]),
    submitPendingInput: mock(async () =>
      submissionOutcome === "accepted"
        ? { outcome: "accepted" }
        : {
            outcome: "rejected",
            httpStatus: 400,
            kind: "http_error",
            detail: "You need to have Job/Build permissions to submit this.",
          },
    ),
  } as unknown as JenkinsClient;
}

async function captureAnalyticsBody(
  command: string,
  action: () => Promise<void>,
): Promise<string> {
  const fetchMock = mock(async (_input: FetchInput, init?: RequestInit) => {
    return new Response(init?.body ?? "", { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await runWithAnalytics({ command, interactive: false }, action).catch(
    () => undefined,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return String(fetchMock.mock.calls[0]?.[1]?.body);
}

test("input commands record only a coarse outcome, never input details", async () => {
  const body = await captureAnalyticsBody("input:approve", async () => {
    await runInputApprove({
      client: client("accepted"),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      yes: true,
      json: true,
      write: () => undefined,
    });
  });

  const payload = JSON.parse(body) as {
    batch: Array<{ event: string; properties: Record<string, unknown> }>;
  };
  const finished = payload.batch.find(
    (event) => event.event === "command_finished",
  );
  expect(finished?.properties.input_outcome).toBe("approved");
  expect(finished?.properties.outcome).toBe("success");
  expect(body).not.toContain(SECRET_MESSAGE);
  expect(body).not.toContain(SECRET_ID);
  expect(body).not.toContain("jenkins.example.com");
  expect(body).not.toContain("ci-user");
});

test("a permission rejection is recorded as permission_denied without the message", async () => {
  const body = await captureAnalyticsBody("input:approve", async () => {
    await runInputApprove({
      client: client("rejected"),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      yes: true,
    });
  });

  expect(body).toContain('"input_outcome":"permission_denied"');
  expect(body).not.toContain(SECRET_MESSAGE);
  expect(body).not.toContain(SECRET_ID);
  expect(body).not.toContain("jenkins.example.com");
  expect(body).not.toContain("Job/Build");
});

test("listing records listed", async () => {
  const body = await captureAnalyticsBody("input:list", async () => {
    await runInputList({
      client: client("accepted"),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      json: true,
      write: () => undefined,
    });
  });
  expect(body).toContain('"input_outcome":"listed"');
  expect(body).not.toContain(SECRET_ID);
});
