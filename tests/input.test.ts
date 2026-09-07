import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { CliError } from "../src/cli";
import {
  runInputAbort,
  runInputApprove,
  runInputList,
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
const JENKINS_URL = "https://jenkins.example.com";
const JOB_URL = `${JENKINS_URL}/job/deploy`;
const BUILD_URL = `${JOB_URL}/128/`;
const PROCEED_URL = `${BUILD_URL}wfapi/inputSubmit?inputId=Release`;
const ABORT_URL = `${BUILD_URL}input/Release/abort`;

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
  proceedUrl: PROCEED_URL,
  abortUrl: ABORT_URL,
  approvalUrl: `${BUILD_URL}input/`,
};

const parameterizedAction: PendingInputAction = {
  id: "Pick",
  message: "Choose a tag",
  parameters: [{ name: "TAG", type: "StringParameterDefinition" }],
  proceedUrl: `${BUILD_URL}wfapi/inputSubmit?inputId=Pick`,
  abortUrl: `${BUILD_URL}input/Pick/abort`,
};

type FakeClient = {
  getBuildStatus: ReturnType<typeof mock>;
  getJobStatus: ReturnType<typeof mock>;
  listPendingInputActions: ReturnType<typeof mock>;
  submitPendingInput: ReturnType<typeof mock>;
};

/**
 * `pending` is consumed one page per `listPendingInputActions` call; the last
 * page repeats, so tests can model "settled between refresh and submit".
 */
function fakeClient(options: {
  pending: PendingInputAction[][];
  submission?: PendingInputSubmission;
  building?: boolean;
}): FakeClient {
  const pages = [...options.pending];
  return {
    getBuildStatus: mock(async (buildUrl: string) => ({
      buildUrl,
      buildNumber: 128,
      building: options.building ?? true,
      result: options.building === false ? "SUCCESS" : null,
    })),
    getJobStatus: mock(async () => ({
      buildUrl: BUILD_URL,
      buildNumber: 128,
      building: true,
      result: null,
    })),
    listPendingInputActions: mock(async () => {
      const page = pages.length > 1 ? pages.shift() : pages[0];
      return page ?? [];
    }),
    submitPendingInput: mock(
      async () => options.submission ?? { outcome: "accepted" },
    ),
  };
}

function asClient(client: FakeClient): JenkinsClient {
  return client as unknown as JenkinsClient;
}

function sink() {
  const chunks: string[] = [];
  return {
    write: (text: string) => {
      chunks.push(text);
    },
    document: () => {
      const lines = chunks.join("").split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0] as string) as {
        ok: boolean;
        command?: string;
        data?: Record<string, unknown>;
        error?: { code: string; message: string };
      };
    },
  };
}

async function captureError(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to throw.");
}

function setDeps(overrides: Partial<typeof inputDeps>): void {
  setInputDepsForTesting({ ...inputDeps, ...overrides });
}

function createLogSpy() {
  return spyOn(console, "log").mockImplementation(() => undefined);
}

let logSpy: ReturnType<typeof createLogSpy>;

beforeEach(() => {
  process.exitCode = 0;
  logSpy = createLogSpy();
});

afterEach(() => {
  logSpy.mockRestore();
  setInputDepsForTesting();
  process.exitCode = 0;
});

function logged(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("input list", () => {
  test("emits build identity and normalized actions as one JSON document", async () => {
    const client = fakeClient({
      pending: [[releaseAction, parameterizedAction]],
    });
    const output = sink();

    await runInputList({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      json: true,
      write: output.write,
    });

    expect(output.document()).toEqual({
      ok: true,
      command: "input list",
      data: {
        build: {
          jobUrl: JOB_URL,
          url: BUILD_URL,
          number: 128,
          building: true,
          result: null,
        },
        actions: [
          {
            id: "Release",
            message: "Deploy to production?",
            proceedText: "Ship it",
            requiresParameters: false,
            parameters: [],
            proceedUrl: PROCEED_URL,
            abortUrl: ABORT_URL,
            approvalUrl: `${BUILD_URL}input/`,
          },
          {
            id: "Pick",
            message: "Choose a tag",
            requiresParameters: true,
            parameters: [{ name: "TAG", type: "StringParameterDefinition" }],
            proceedUrl: `${BUILD_URL}wfapi/inputSubmit?inputId=Pick`,
            abortUrl: `${BUILD_URL}input/Pick/abort`,
          },
        ],
      },
    });
    expect(client.submitPendingInput).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  test("returns a successful empty list when nothing is pending", async () => {
    const client = fakeClient({ pending: [[]], building: false });
    const output = sink();

    await runInputList({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      json: true,
      write: output.write,
    });

    const document = output.document();
    expect(document.ok).toBeTrue();
    expect(document.data?.actions).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("reports unknown parameter metadata as null in JSON", async () => {
    const client = fakeClient({
      pending: [[{ ...releaseAction, parameters: null }]],
    });
    const output = sink();

    await runInputList({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      json: true,
      write: output.write,
    });

    const actions = output.document().data?.actions as
      Array<Record<string, unknown>> | undefined;
    expect(actions?.[0]?.requiresParameters).toBeNull();
    expect(actions?.[0]?.parameters).toBeNull();
  });

  test("propagates capability errors as an error document with a non-zero exit", async () => {
    const client = fakeClient({ pending: [[]] });
    client.listPendingInputActions.mockImplementation(async () => {
      throw new CliError(
        "Jenkins returned HTTP 404 while trying to fetch pending input actions; this build does not expose Pipeline input actions.",
        [],
        "PIPELINE_INPUT_UNSUPPORTED",
      );
    });
    const output = sink();

    await runInputList({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      json: true,
      write: output.write,
    });

    expect(output.document().error?.code).toBe("PIPELINE_INPUT_UNSUPPORTED");
    expect(process.exitCode).toBe(1);
  });

  test("targets the job's latest build when no exact selector is given", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    setDeps({
      resolveJobTarget: mock(async () => ({
        jobUrl: JOB_URL,
        jobLabel: "deploy",
      })),
    });

    await runInputList({
      client: asClient(client),
      env,
      job: "deploy",
      nonInteractive: true,
    });

    expect(client.getJobStatus).toHaveBeenCalledWith(JOB_URL);
    expect(client.listPendingInputActions).toHaveBeenCalledWith(BUILD_URL);
    expect(logged()).toContain("OK: Build: deploy #128 (RUNNING)");
    expect(logged()).toContain("Release: Deploy to production?");
    expect(logged()).toContain("parameters: none | actions: approve, abort");
  });

  test("fails with NO_BUILDS when the job never built", async () => {
    const client = fakeClient({ pending: [[]] });
    client.getJobStatus.mockImplementation(async () => ({}));
    setDeps({
      resolveJobTarget: mock(async () => ({
        jobUrl: JOB_URL,
        jobLabel: "deploy",
      })),
    });

    const error = await captureError(() =>
      runInputList({
        client: asClient(client),
        env,
        job: "deploy",
        nonInteractive: true,
      }),
    );
    expect(error.code).toBe("NO_BUILDS");
    expect(client.listPendingInputActions).not.toHaveBeenCalled();
  });

  test("sanitizes terminal control sequences in messages", async () => {
    const client = fakeClient({
      pending: [
        [
          {
            ...releaseAction,
            message: "[31mDanger[0m\r\nline two ]0;x",
          },
        ],
      ],
    });

    await runInputList({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
    });

    expect(logged()).toContain("Release: Danger line two");
    expect(logged()).not.toContain("\u001b");
  });

  test("sanitizes terminal control sequences in action ids for display only", async () => {
    const client = fakeClient({
      pending: [[{ ...releaseAction, id: "Rel\u001b[31mease\u0007" }]],
    });

    await runInputList({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
    });
    expect(logged()).toContain("  - Release: Deploy to production?");
    expect(logged()).not.toContain("\u001b");

    const output = sink();
    await runInputList({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: true,
      json: true,
      write: output.write,
    });
    const actions = output.document().data?.actions as
      Array<{ id: string }> | undefined;
    expect(actions?.[0]?.id).toBe("Rel\u001b[31mease\u0007");
  });
});

describe("non-interactive safety matrix", () => {
  const cases: Array<{
    label: string;
    options: { nonInteractive: boolean; json?: boolean; yes?: boolean };
    mutates: boolean;
  }> = [
    {
      label: "--non-interactive alone",
      options: { nonInteractive: true },
      mutates: false,
    },
    {
      label: "--json alone",
      options: { nonInteractive: false, json: true },
      mutates: false,
    },
    {
      label: "--json --non-interactive",
      options: { nonInteractive: true, json: true },
      mutates: false,
    },
    {
      label: "--non-interactive --yes",
      options: { nonInteractive: true, yes: true },
      mutates: true,
    },
    {
      label: "--json --yes",
      options: { nonInteractive: false, json: true, yes: true },
      mutates: true,
    },
  ];

  for (const operation of ["approve", "abort"] as const) {
    const run = operation === "approve" ? runInputApprove : runInputAbort;
    for (const entry of cases) {
      test(`${operation} with ${entry.label} ${entry.mutates ? "submits" : "never submits"}`, async () => {
        const client = fakeClient({ pending: [[releaseAction]] });
        const output = sink();

        if (entry.mutates) {
          await run({
            client: asClient(client),
            env,
            buildUrl: BUILD_URL,
            ...entry.options,
            write: output.write,
          });
          expect(client.submitPendingInput).toHaveBeenCalledTimes(1);
          expect(client.submitPendingInput).toHaveBeenCalledWith({
            url: operation === "approve" ? PROCEED_URL : ABORT_URL,
            operation,
          });
          if (entry.options.json) {
            expect(output.document()).toEqual({
              ok: true,
              command: `input ${operation}`,
              data: {
                operation,
                disposition: operation === "approve" ? "approved" : "aborted",
                build: {
                  jobUrl: JOB_URL,
                  url: BUILD_URL,
                  number: 128,
                  building: true,
                  result: null,
                },
                action: { id: "Release", message: "Deploy to production?" },
              },
            });
          }
          return;
        }

        // Refused up front like a protected profile; the CLI wrapper turns the
        // thrown error into the JSON error envelope.
        const error = await captureError(() =>
          run({
            client: asClient(client),
            env,
            buildUrl: BUILD_URL,
            ...entry.options,
            write: output.write,
          }),
        );
        expect(error.code).toBe("INPUT_CONFIRMATION_REQUIRED");
        expect(client.submitPendingInput).not.toHaveBeenCalled();
        // Refused before touching Jenkins at all.
        expect(client.listPendingInputActions).not.toHaveBeenCalled();
        expect(client.getBuildStatus).not.toHaveBeenCalled();
      });
    }
  }
});

describe("input approve/abort outcomes", () => {
  const scripted = {
    nonInteractive: true,
    yes: true,
    buildUrl: BUILD_URL,
  };

  test("refreshes the action before submitting and uses the refreshed URL", async () => {
    const movedUrl = `${BUILD_URL}wfapi/inputSubmit?inputId=Release&fresh=1`;
    const client = fakeClient({
      pending: [[releaseAction], [{ ...releaseAction, proceedUrl: movedUrl }]],
    });

    await runInputApprove({ client: asClient(client), env, ...scripted });

    expect(client.listPendingInputActions).toHaveBeenCalledTimes(2);
    expect(client.submitPendingInput).toHaveBeenCalledWith({
      url: movedUrl,
      operation: "approve",
    });
    expect(logged()).toContain('OK: Approved input "Release" on');
  });

  test("selects by --id and rejects unknown ids without submitting", async () => {
    const client = fakeClient({
      pending: [[releaseAction, parameterizedAction]],
    });

    await runInputAbort({
      client: asClient(client),
      env,
      ...scripted,
      id: "Pick",
    });
    expect(client.submitPendingInput).toHaveBeenCalledWith({
      url: parameterizedAction.abortUrl,
      operation: "abort",
    });

    const missing = fakeClient({ pending: [[releaseAction]] });
    const error = await captureError(() =>
      runInputAbort({
        client: asClient(missing),
        env,
        ...scripted,
        id: "Nope",
      }),
    );
    expect(error.code).toBe("INPUT_ACTION_NOT_FOUND");
    expect(error.hints.join(" ")).toContain("Release");
    expect(missing.submitPendingInput).not.toHaveBeenCalled();
  });

  test("requires --id when several actions are pending non-interactively", async () => {
    const client = fakeClient({
      pending: [[releaseAction, parameterizedAction]],
    });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_ACTION_AMBIGUOUS");
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("reports INPUT_NOT_PENDING when the build has no pending actions", async () => {
    const client = fakeClient({ pending: [[]], building: false });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_NOT_PENDING");
    expect(error.hints[0]).toContain("finished");
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("refuses parameterized approval but still allows abort", async () => {
    const approveClient = fakeClient({ pending: [[parameterizedAction]] });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(approveClient), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_PARAMETERS_UNSUPPORTED");
    expect(error.message).toContain("TAG");
    expect(approveClient.submitPendingInput).not.toHaveBeenCalled();

    const abortClient = fakeClient({ pending: [[parameterizedAction]] });
    await runInputAbort({ client: asClient(abortClient), env, ...scripted });
    expect(abortClient.submitPendingInput).toHaveBeenCalledWith({
      url: parameterizedAction.abortUrl,
      operation: "abort",
    });
  });

  test("refuses approval when parameter metadata is missing", async () => {
    const client = fakeClient({
      pending: [[{ ...releaseAction, parameters: null }]],
    });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_PARAMETERS_UNKNOWN");
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("refuses approval when the refreshed action gained parameters", async () => {
    const client = fakeClient({
      pending: [
        [releaseAction],
        [{ ...releaseAction, parameters: [{ name: "X" }] }],
      ],
    });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_PARAMETERS_UNSUPPORTED");
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("reports a stale action when it settles before the POST", async () => {
    const client = fakeClient({ pending: [[releaseAction], []] });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_ACTION_STALE");
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("refuses to submit when Jenkins returned no usable URL for the operation", async () => {
    const client = fakeClient({
      pending: [[{ ...releaseAction, proceedUrl: undefined }]],
    });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_ACTION_URL_INVALID");
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("classifies a permission rejection from Jenkins' own message", async () => {
    const client = fakeClient({
      pending: [[releaseAction]],
      submission: {
        outcome: "rejected",
        httpStatus: 400,
        kind: "http_error",
        detail: "You need to have Job/Build permissions to submit this.",
      },
    });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_PERMISSION_DENIED");
    expect(error.hints[0]).toContain("still be allowed to abort");

    const abortClient = fakeClient({
      pending: [[releaseAction]],
      submission: {
        outcome: "rejected",
        httpStatus: 400,
        kind: "http_error",
        detail: "You need to have Job/Cancel permissions to cancel this.",
      },
    });
    const abortError = await captureError(() =>
      runInputAbort({ client: asClient(abortClient), env, ...scripted }),
    );
    expect(abortError.code).toBe("INPUT_PERMISSION_DENIED");
    expect(abortError.hints[0]).toContain("Job/Cancel");
  });

  test("classifies a crumb rejection only when Jenkins names the crumb", async () => {
    const client = fakeClient({
      pending: [[releaseAction]],
      submission: {
        outcome: "rejected",
        httpStatus: 403,
        kind: "http_error",
        detail: "No valid crumb was included in the request",
      },
    });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("JENKINS_CRUMB_REJECTED");
  });

  test("keeps an ambiguous 403 as a generic rejection", async () => {
    const client = fakeClient({
      pending: [[releaseAction]],
      submission: { outcome: "rejected", httpStatus: 403, kind: "http_error" },
    });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_SUBMISSION_REJECTED");
    expect(error.message).toContain("HTTP 403");
    expect(error.hints[0]).toContain("permission or CSRF");
  });

  test("reports a login redirect on submit as not submitted", async () => {
    const client = fakeClient({
      pending: [[releaseAction]],
      submission: {
        outcome: "rejected",
        httpStatus: 200,
        kind: "redirect",
        detail: "redirected to https://jenkins.example.com/login",
      },
    });
    const error = await captureError(() =>
      runInputAbort({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("JENKINS_LOGIN_REDIRECT");
  });

  test("an HTML success page is never a receipt", async () => {
    for (const run of [runInputApprove, runInputAbort]) {
      const client = fakeClient({
        pending: [[releaseAction]],
        submission: {
          outcome: "rejected",
          httpStatus: 200,
          kind: "html_page",
          detail: "received an HTML page instead of a Jenkins response",
        },
      });
      const output = sink();

      await run({
        client: asClient(client),
        env,
        buildUrl: BUILD_URL,
        json: true,
        yes: true,
        nonInteractive: false,
        write: output.write,
      });

      const document = output.document();
      expect(document.ok).toBeFalse();
      expect(document.error?.code).toBe("PIPELINE_INPUT_INVALID_RESPONSE");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    }
  });

  test("a server error followed by disappearance is unknown, not stale", async () => {
    const client = fakeClient({
      pending: [[releaseAction], [releaseAction], []],
      submission: { outcome: "rejected", httpStatus: 500, kind: "http_error" },
    });
    const error = await captureError(() =>
      runInputApprove({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_OUTCOME_UNKNOWN");
    expect(error.message).not.toContain("was not applied");
    expect(error.message).toContain("HTTP 500");
    expect(client.submitPendingInput).toHaveBeenCalledTimes(1);
  });

  test("treats a client-side rejection followed by disappearance as settled by someone else", async () => {
    const client = fakeClient({
      pending: [[releaseAction], [releaseAction], []],
      submission: { outcome: "rejected", httpStatus: 400, kind: "http_error" },
    });
    const output = sink();

    await runInputApprove({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      json: true,
      yes: true,
      nonInteractive: false,
      write: output.write,
    });

    const document = output.document();
    expect(document.ok).toBeFalse();
    expect(document.error?.code).toBe("INPUT_ACTION_STALE");
    expect(document.error?.message).toContain("was not applied");
    expect(process.exitCode).toBe(1);
  });

  test("a lost response is unknown even when the action is gone afterwards", async () => {
    const client = fakeClient({
      pending: [[releaseAction], [releaseAction], []],
      submission: {
        outcome: "unconfirmed",
        reason: "Request timed out while trying to approve pending input.",
      },
    });
    const output = sink();

    await runInputApprove({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      json: true,
      yes: true,
      nonInteractive: false,
      write: output.write,
    });

    const document = output.document();
    expect(document.ok).toBeFalse();
    expect(document.error?.code).toBe("INPUT_OUTCOME_UNKNOWN");
    expect(document.error?.message).not.toContain("Approved");
    expect(process.exitCode).toBe(1);
    expect(client.submitPendingInput).toHaveBeenCalledTimes(1);
  });

  test("a lost response with the action still pending is also unknown", async () => {
    const client = fakeClient({
      pending: [[releaseAction]],
      submission: {
        outcome: "unconfirmed",
        reason: "Network error while trying to abort pending input.",
      },
    });
    const error = await captureError(() =>
      runInputAbort({ client: asClient(client), env, ...scripted }),
    );
    expect(error.code).toBe("INPUT_OUTCOME_UNKNOWN");
    expect(error.hints[0]).toContain("still pending");
    expect(client.submitPendingInput).toHaveBeenCalledTimes(1);
  });
});

describe("interactive confirmation", () => {
  test("declining keeps the input untouched", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    setDeps({ confirm: mock(async () => false) });

    await runInputApprove({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: false,
    });

    expect(client.submitPendingInput).not.toHaveBeenCalled();
    expect(logged()).toContain("OK: Approval skipped.");
  });

  test("--yes skips the prompt even in an interactive terminal", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    const confirm = mock(async (_options: unknown) => false);
    setDeps({ confirm });

    await runInputApprove({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: false,
      yes: true,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(client.submitPendingInput).toHaveBeenCalledTimes(1);
  });

  test("Esc during confirmation cancels without submitting", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    setDeps({
      confirm: mock(async () => CANCEL),
      isCancel: (value: unknown) => value === CANCEL,
    });

    await expect(
      runInputAbort({
        client: asClient(client),
        env,
        buildUrl: BUILD_URL,
        nonInteractive: false,
      }),
    ).rejects.toThrow("Operation cancelled.");
    expect(client.submitPendingInput).not.toHaveBeenCalled();
  });

  test("confirming shows build identity and message, then submits", async () => {
    const client = fakeClient({ pending: [[releaseAction]] });
    const confirm = mock(async (_options: unknown) => true);
    setDeps({ confirm });

    await runInputApprove({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: false,
    });

    const prompt = confirm.mock.calls[0]?.[0] as
      { message: string; initialValue?: boolean } | undefined;
    expect(prompt?.message).toBe(`Approve input "Release" on ${JOB_URL} #128?`);
    expect(prompt?.initialValue).toBeFalse();
    expect(logged()).toContain("OK: Input: Release: Deploy to production?");
    expect(client.submitPendingInput).toHaveBeenCalledTimes(1);
  });

  test("lets the user pick one of several pending actions", async () => {
    const client = fakeClient({
      pending: [[releaseAction, parameterizedAction]],
    });
    const select = mock(async (_options: unknown) => "Pick");
    setDeps({
      select,
      confirm: mock(async () => true),
    });

    await runInputAbort({
      client: asClient(client),
      env,
      buildUrl: BUILD_URL,
      nonInteractive: false,
    });

    const prompt = select.mock.calls[0]?.[0] as
      { options: Array<{ value: string; label: string }> } | undefined;
    expect(prompt?.options.map((option) => option.value)).toEqual([
      "Release",
      "Pick",
    ]);
    expect(client.submitPendingInput).toHaveBeenCalledWith({
      url: parameterizedAction.abortUrl,
      operation: "abort",
    });
  });
});
