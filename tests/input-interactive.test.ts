import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  runPendingInputsMenu,
  setInputDepsForTesting,
} from "../src/commands/input";
import { inputDeps } from "../src/commands/input-deps";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type {
  PendingInputAction,
  PendingInputSubmission,
} from "../src/types/jenkins";

const CANCEL = Symbol("cancel");
const BACK = "__jenkins_cli_input_back__";
const JENKINS_URL = "https://jenkins.example.com";
const JOB_URL = `${JENKINS_URL}/job/deploy`;
const BUILD_URL = `${JOB_URL}/128/`;

const env: EnvConfig = {
  jenkinsUrl: JENKINS_URL,
  jenkinsUser: "ci",
  jenkinsApiToken: "token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

const releaseAction: PendingInputAction = {
  id: "Release",
  message: "Deploy to production?",
  proceedText: "Ship it",
  parameters: [],
  proceedUrl: `${BUILD_URL}wfapi/inputSubmit?inputId=Release`,
  abortUrl: `${BUILD_URL}input/Release/abort`,
  approvalUrl: `${BUILD_URL}input/`,
};

const secondAction: PendingInputAction = {
  id: "Smoke",
  message: "Run smoke tests?",
  parameters: [],
  proceedUrl: `${BUILD_URL}wfapi/inputSubmit?inputId=Smoke`,
  abortUrl: `${BUILD_URL}input/Smoke/abort`,
};

function fakeClient(options: {
  pending: PendingInputAction[][];
  submission?: PendingInputSubmission;
}) {
  const pages = [...options.pending];
  return {
    getBuildStatus: mock(async (buildUrl: string) => ({
      buildUrl,
      buildNumber: 128,
      building: true,
      result: null,
    })),
    getJobStatus: mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 128,
      building: true,
      result: null,
    })),
    getQueueBuild: mock(
      async (
        _queueUrl: string,
      ): Promise<{ buildUrl?: string; buildNumber?: number }> => ({}),
    ),
    listPendingInputActions: mock(async (_buildUrl: string) => {
      const page = pages.length > 1 ? pages.shift() : pages[0];
      return page ?? [];
    }),
    submitPendingInput: mock(
      async () => options.submission ?? { outcome: "accepted" },
    ),
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

function asClient(client: FakeClient): JenkinsClient {
  return client as unknown as JenkinsClient;
}

/** Feeds scripted answers to `select` and `confirm` in call order. */
function scriptPrompts(answers: unknown[]) {
  let cursor = 0;
  const select = mock(async (_options: unknown) => answers[cursor++]);
  const confirm = mock(async (_options: unknown) => answers[cursor++]);
  setInputDepsForTesting({
    ...inputDeps,
    select,
    confirm,
    isCancel: (value: unknown) => value === CANCEL,
  });
  return { select, confirm };
}

function createConsoleSpy(method: "log" | "error") {
  return spyOn(console, method).mockImplementation(() => undefined);
}

let logSpy: ReturnType<typeof createConsoleSpy>;
let errorSpy: ReturnType<typeof createConsoleSpy>;

beforeEach(() => {
  logSpy = createConsoleSpy("log");
  errorSpy = createConsoleSpy("error");
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  setInputDepsForTesting();
});

function logged(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

function errors(): string {
  return errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("runPendingInputsMenu", () => {
  test("resolves the job's latest build and returns when nothing is pending", async () => {
    const client = fakeClient({ pending: [[]] });
    const { select } = scriptPrompts([]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      jobUrl: JOB_URL,
      jobLabel: "deploy",
    });

    expect(client.getJobStatus).toHaveBeenCalledWith(JOB_URL);
    expect(client.listPendingInputActions).toHaveBeenCalledWith(BUILD_URL);
    expect(select).not.toHaveBeenCalled();
    expect(logged()).toContain("OK: No pending input actions for deploy #128.");
  });

  test("retains the exact build handed in by the caller", async () => {
    const client = fakeClient({ pending: [[]] });
    scriptPrompts([]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: `${JOB_URL}/127/`,
      jobLabel: "deploy",
    });

    expect(client.getJobStatus).not.toHaveBeenCalled();
    expect(client.getBuildStatus).toHaveBeenCalledWith(`${JOB_URL}/127/`);
    expect(client.listPendingInputActions).toHaveBeenCalledWith(
      `${JOB_URL}/127/`,
    );
  });

  test("resolves a queued trigger to its build instead of the job's latest build", async () => {
    const client = fakeClient({ pending: [[]] });
    const queueUrl = `${JENKINS_URL}/queue/item/9/`;
    client.getQueueBuild.mockImplementation(async () => ({
      buildUrl: `${JOB_URL}/129/`,
      buildNumber: 129,
    }));
    scriptPrompts([]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      queueUrl,
      jobUrl: JOB_URL,
      jobLabel: "deploy",
    });

    expect(client.getQueueBuild).toHaveBeenCalledWith(queueUrl);
    expect(client.getJobStatus).not.toHaveBeenCalled();
    expect(client.getBuildStatus).toHaveBeenCalledWith(`${JOB_URL}/129/`);
  });

  test("a still-queued trigger returns without touching any build", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    scriptPrompts([]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      queueUrl: `${JENKINS_URL}/queue/item/9/`,
      jobUrl: JOB_URL,
      jobLabel: "deploy",
    });

    expect(client.getJobStatus).not.toHaveBeenCalled();
    expect(client.getBuildStatus).not.toHaveBeenCalled();
    expect(client.listPendingInputActions).not.toHaveBeenCalled();
    expect(logged()).toContain("deploy is still queued");
  });

  test("only offers operations Jenkins returned a usable link for", async () => {
    const abortOnly: PendingInputAction = {
      ...releaseAction,
      id: "AbortOnly",
      proceedUrl: undefined,
    };
    const client = fakeClient({ pending: [[abortOnly]] });
    const { select } = scriptPrompts(["AbortOnly", BACK, BACK]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    const operationPrompt = select.mock.calls[1]?.[0] as {
      options: Array<{ value: string }>;
    };
    expect(operationPrompt.options.map((option) => option.value)).toEqual([
      "abort",
      BACK,
    ]);
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("listing and selecting never submit; Back returns to the caller", async () => {
    const client = fakeClient({ pending: [[releaseAction, secondAction]] });
    const { select } = scriptPrompts(["Smoke", BACK, BACK]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    const firstPrompt = select.mock.calls[0]?.[0] as {
      message: string;
      options: Array<{ value: string; label: string }>;
    };
    expect(firstPrompt.message).toBe("Pending inputs for deploy #128");
    expect(firstPrompt.options.map((option) => option.label)).toEqual([
      "Release: Deploy to production?",
      "Smoke: Run smoke tests?",
      "Back",
    ]);
    const operationPrompt = select.mock.calls[1]?.[0] as {
      options: Array<{ value: string }>;
    };
    expect(operationPrompt.options.map((option) => option.value)).toEqual([
      "approve",
      "abort",
      BACK,
    ]);
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("Esc on the action list returns without submitting", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    scriptPrompts([CANCEL]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("cancelling the confirmation stays on the input menu", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    const { select, confirm } = scriptPrompts([
      "Release",
      "approve",
      CANCEL,
      BACK,
    ]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(3);
    expect(client.submitPendingInput).not.toHaveBeenCalled();
    expect(logged()).toContain("OK: Operation cancelled.");
  });

  test("declining the confirmation stays on the input menu", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    scriptPrompts(["Release", "abort", false, BACK]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    expect(client.submitPendingInput).not.toHaveBeenCalled();
    expect(logged()).toContain("OK: Abort skipped.");
  });

  test("approves after confirmation, refreshes, and exits once nothing is pending", async () => {
    const client = fakeClient({
      pending: [[releaseAction], [releaseAction], []],
    });
    const { confirm } = scriptPrompts(["Release", "approve", true]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      message: 'Approve input "Release" on deploy #128?',
      initialValue: false,
    });
    expect(client.submitPendingInput).toHaveBeenCalledTimes(1);
    expect(client.submitPendingInput).toHaveBeenCalledWith({
      url: releaseAction.proceedUrl,
      operation: "approve",
    });
    expect(logged()).toContain('OK: Approved input "Release" on deploy #128.');
    expect(logged()).toContain("OK: No pending input actions for deploy #128.");
  });

  test("a stale action is reported and the menu keeps the same build", async () => {
    const client = fakeClient({
      // list → [Release]; refresh → []; re-list → [] (menu exits).
      pending: [[releaseAction], [], []],
    });
    const { confirm } = scriptPrompts(["Release", "abort", true]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(client.submitPendingInput).not.toHaveBeenCalled();
    expect(errors()).toContain(
      'ERROR: Input "Release" on deploy #128 is no longer pending',
    );
    expect(
      client.listPendingInputActions.mock.calls.every(
        ([url]) => url === BUILD_URL,
      ),
    ).toBeTrue();
  });

  test("a protected profile blocks before confirmation and stays on the menu", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    const { confirm } = scriptPrompts(["Release", "approve", BACK]);

    await runPendingInputsMenu({
      client: asClient(client),
      env: { ...env, protectedProfileName: "release" },
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(client.submitPendingInput).not.toHaveBeenCalled();
    expect(errors()).toContain('ERROR: Profile "release" is read-only.');
    // Listing stayed available: the menu re-listed and offered Back.
    expect(client.listPendingInputActions).toHaveBeenCalledTimes(2);
  });

  test("--confirm-protected lets the menu approve on a protected profile", async () => {
    const client = fakeClient({
      pending: [[releaseAction], [releaseAction], []],
    });
    scriptPrompts(["Release", "approve", true]);

    await runPendingInputsMenu({
      client: asClient(client),
      env: { ...env, protectedProfileName: "release", confirmProtected: true },
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    expect(client.submitPendingInput).toHaveBeenCalledTimes(1);
  });

  test("a rejected submission is printed and the menu continues", async () => {
    const client = fakeClient({
      pending: [[releaseAction]],
      submission: {
        outcome: "rejected",
        httpStatus: 400,
        kind: "http_error",
        detail: "You need to have Job/Cancel permissions to cancel this.",
      },
    });
    const { select } = scriptPrompts(["Release", "abort", true, BACK]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    expect(errors()).toContain("ERROR: Jenkins denied the abort");
    expect(select).toHaveBeenCalledTimes(3);
    expect(logged()).not.toContain("Aborted input");
  });

  test("parameterized approval is refused from the menu with guidance", async () => {
    const parameterized: PendingInputAction = {
      ...releaseAction,
      id: "Pick",
      parameters: [{ name: "TAG" }],
    };
    const client = fakeClient({ pending: [[parameterized]] });
    const { select, confirm } = scriptPrompts(["Pick", "approve", BACK]);

    await runPendingInputsMenu({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      jobLabel: "deploy",
    });

    const operationPrompt = select.mock.calls[1]?.[0] as {
      options: Array<{ label: string }>;
    };
    expect(operationPrompt.options[0]?.label).toBe(
      "Approve (requires 1 parameter, unsupported)",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(client.submitPendingInput).not.toHaveBeenCalled();
    expect(errors()).toContain("parameterized approval is not supported");
  });
});
