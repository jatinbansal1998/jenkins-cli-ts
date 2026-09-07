/**
 * Pending Pipeline `input` actions: list, approve, abort.
 *
 * Shared by the explicit `jenkins-cli input ...` commands and the interactive
 * menus. Every mutation goes through `settlePendingInput`, which re-reads the
 * action right before the POST and only reports success on an accepted
 * response. A lost response is reconciled by re-reading pending actions, but
 * an action that merely disappeared is reported as `unknown`: another user, a
 * timeout, or a build cancellation could have settled it.
 */
import { updateAnalyticsContext } from "../analytics";
import { resolveBuildSelector } from "../build-selector";
import { CliError, printOk } from "../cli";
import { assertProtectedMutationAllowed, type EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import {
  type JsonPendingInputBuild,
  type JsonPendingInputList,
  type JsonPendingInputReceipt,
  type JsonWrite,
  jsonPendingInputAction,
  runJsonCommand,
} from "../json-output";
import { normalizeJobUrl } from "../job-url";
import { sanitizeInputText } from "../pipeline-inputs";
import type {
  PendingInputAction,
  PendingInputSubmission,
} from "../types/jenkins";
import { inputDeps } from "./input-deps";
import { printMenuActionError } from "./menu-action";

type InputOperation = "approve" | "abort";

type InputTargetOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  build?: number;
  buildUrl?: string;
  nonInteractive: boolean;
};

type InputListOptions = InputTargetOptions & {
  json?: boolean;
  write?: JsonWrite;
};

type InputMutationOptions = InputListOptions & {
  id?: string;
  /** Required for any non-interactive mutation, including `--json`. */
  yes?: boolean;
};

type ResolvedInputBuild = {
  jobUrl: string;
  jobLabel: string;
  buildUrl: string;
  buildNumber?: number;
  building: boolean;
  result: string | null;
};

type ConfirmAnswer = "yes" | "no" | "cancelled";

type SettleResult =
  | { kind: "settled"; receipt: JsonPendingInputReceipt }
  | { kind: "declined" }
  | { kind: "cancelled" };

/** Coarse, privacy-safe outcome recorded on the analytics session. */
type InputOutcome =
  | "listed"
  | "approved"
  | "aborted"
  | "declined"
  | "cancelled"
  | "confirmation_required"
  | "not_pending"
  | "stale"
  | "unsupported_parameters"
  | "parameters_unknown"
  | "permission_denied"
  | "crumb_rejected"
  | "login_redirect"
  | "rejected"
  | "unknown";

const BACK_VALUE = "__jenkins_cli_input_back__";

let activeInputDeps = inputDeps;

export function setInputDepsForTesting(overrides?: typeof inputDeps): void {
  activeInputDeps = overrides ?? inputDeps;
}

export async function runInputList(options: InputListOptions): Promise<void> {
  if (options.json) {
    await runJsonCommand(
      "input list",
      async (): Promise<JsonPendingInputList> => {
        const target = await resolveInputBuild({
          ...options,
          nonInteractive: true,
        });
        const actions = await options.client.listPendingInputActions(
          target.buildUrl,
        );
        recordInputOutcome("listed");
        return {
          build: jsonPendingInputBuild(target),
          actions: actions.map(jsonPendingInputAction),
        };
      },
      { write: options.write },
    );
    return;
  }

  const target = await resolveInputBuild(options);
  const actions = await options.client.listPendingInputActions(target.buildUrl);
  recordInputOutcome("listed");
  printPendingInputs(target, actions);
}

export async function runInputApprove(
  options: InputMutationOptions,
): Promise<void> {
  await runInputMutation("approve", options);
}

export async function runInputAbort(
  options: InputMutationOptions,
): Promise<void> {
  await runInputMutation("abort", options);
}

async function runInputMutation(
  operation: InputOperation,
  options: InputMutationOptions,
): Promise<void> {
  assertProtectedMutationAllowed(options.env);
  const nonInteractive = options.nonInteractive || Boolean(options.json);
  if (nonInteractive && !options.yes) {
    recordInputOutcome("confirmation_required");
    throw new CliError(
      `Refusing to ${operation} a pending input without confirmation.`,
      [
        `Pass --yes to ${operation} non-interactively (--json and --non-interactive alone never submit).`,
      ],
      "INPUT_CONFIRMATION_REQUIRED",
    );
  }

  if (options.json) {
    await runJsonCommand(
      `input ${operation}`,
      async (): Promise<JsonPendingInputReceipt> => {
        const target = await resolveInputBuild({
          ...options,
          nonInteractive: true,
        });
        const action = await selectPendingInput({
          client: options.client,
          target,
          id: options.id,
          nonInteractive: true,
        });
        const result = await settlePendingInput({
          client: options.client,
          operation,
          target,
          action,
        });
        if (result.kind !== "settled") {
          throw new CliError("Operation cancelled.");
        }
        return result.receipt;
      },
      { write: options.write },
    );
    return;
  }

  const target = await resolveInputBuild({ ...options, nonInteractive });
  const action = await selectPendingInput({
    client: options.client,
    target,
    id: options.id,
    nonInteractive,
  });
  const result = await settlePendingInput({
    client: options.client,
    operation,
    target,
    action,
    confirm: nonInteractive || options.yes ? undefined : promptConfirmation,
  });
  if (result.kind === "cancelled") {
    throw new CliError("Operation cancelled.");
  }
  printSettleResult(operation, result, target);
}

/**
 * Interactive sub-menu used by the list/build/status/history menus. Lists the
 * build's pending inputs, lets the user pick one and an operation, confirms,
 * and returns to the caller's menu on Back, Esc, decline, or any error.
 * Listing and selecting never submit anything.
 */
export async function runPendingInputsMenu(options: {
  client: JenkinsClient;
  env: EnvConfig;
  /** The job the menu was opened from; every build acted on must belong to it. */
  jobUrl: string;
  jobLabel?: string;
  buildUrl?: string;
  /** A build the caller triggered that may not have left the queue yet. */
  queueUrl?: string;
}): Promise<void> {
  const deps = activeInputDeps;
  let buildUrl = options.buildUrl;
  if (!buildUrl && options.queueUrl) {
    // Never fall back to the job's latest build for a queued trigger: that
    // could be the previous run. Wait for the queue item to become a build.
    const queued = await options.client.getQueueBuild(options.queueUrl);
    if (!queued?.buildUrl) {
      printOk(
        `${options.jobLabel ?? options.queueUrl} is still queued; pending inputs appear once the build starts.`,
      );
      return;
    }
    buildUrl = queued.buildUrl;
  }
  const target = await resolveInputBuild({
    client: options.client,
    env: options.env,
    jobUrl: buildUrl ? undefined : options.jobUrl,
    buildUrl: buildUrl
      ? assertBuildBelongsToJob(buildUrl, options.jobUrl, options.jobLabel)
      : undefined,
    nonInteractive: true,
  });
  if (options.jobLabel) {
    target.jobLabel = options.jobLabel;
  }

  while (true) {
    const actions = await options.client.listPendingInputActions(
      target.buildUrl,
    );
    recordInputOutcome("listed");
    if (actions.length === 0) {
      printOk(`No pending input actions for ${buildLabel(target)}.`);
      return;
    }

    const selectedId = await deps.select({
      message: `Pending inputs for ${buildLabel(target)}`,
      options: [
        ...actions.map((action) => ({
          value: action.id,
          label: `${displayId(action)}: ${displayMessage(action)}`,
        })),
        { value: BACK_VALUE, label: "Back" },
      ],
    });
    if (deps.isCancel(selectedId) || selectedId === BACK_VALUE) {
      return;
    }
    const action = actions.find((candidate) => candidate.id === selectedId);
    if (!action) {
      continue;
    }

    // Only offer what Jenkins returned a usable link for. A parameterized
    // approval stays visible (labelled unsupported) so the user gets the
    // stable error and the Jenkins link instead of a silently missing option.
    const operation = await deps.select({
      message: `Input "${displayId(action)}" on ${buildLabel(target)}: ${displayMessage(action)}`,
      options: [
        ...(action.proceedUrl
          ? [{ value: "approve", label: approveLabel(action) }]
          : []),
        ...(action.abortUrl ? [{ value: "abort", label: "Abort" }] : []),
        { value: BACK_VALUE, label: "Back" },
      ],
    });
    if (
      deps.isCancel(operation) ||
      (operation !== "approve" && operation !== "abort")
    ) {
      continue;
    }

    try {
      assertProtectedMutationAllowed(options.env);
      const result = await settlePendingInput({
        client: options.client,
        operation,
        target,
        action,
        confirm: promptConfirmation,
      });
      if (result.kind === "cancelled") {
        printOk("Operation cancelled.");
        continue;
      }
      printSettleResult(operation, result, target);
    } catch (error) {
      // Stay on this build's input menu so the user can retry or pick another
      // action; only CliErrors are printed, anything else propagates.
      printMenuActionError(error);
    }
  }
}

/**
 * Menus hand over build URLs that came from Jenkins (queue items, history
 * entries, status). Only a numeric build directly under the originating job
 * is accepted, so a stray URL can never move the action to another job.
 */
function assertBuildBelongsToJob(
  buildUrl: string,
  jobUrl: string,
  jobLabel?: string,
): string {
  const jobPrefix = `${normalizeJobUrl(jobUrl)}/`;
  const normalized = buildUrl.trim().replace(/\/+$/, "");
  const rest = normalized.startsWith(jobPrefix)
    ? normalized.slice(jobPrefix.length)
    : undefined;
  if (rest === undefined || !/^\d+$/.test(rest)) {
    throw new CliError(
      `Build URL ${sanitizeInputText(buildUrl)} does not belong to ${jobLabel ?? jobUrl}.`,
      ["Pending inputs are only acted on for builds of the selected job."],
      "PIPELINE_INPUT_INVALID_RESPONSE",
    );
  }
  return `${jobPrefix}${rest}/`;
}

async function resolveInputBuild(
  options: InputTargetOptions,
): Promise<ResolvedInputBuild> {
  const target = await resolveBuildSelector({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    build: options.build,
    buildUrl: options.buildUrl,
    nonInteractive: options.nonInteractive,
    resolveJob: activeInputDeps.resolveJobTarget,
  });
  if (target.kind === "queue") {
    throw new CliError("Queue items cannot have pending inputs.", [
      "Wait for the build to start, then target it with --build or --build-url.",
    ]);
  }
  if (target.kind === "build") {
    // The selector already validated this URL against the active controller.
    // Jenkins' own `url` field is display data and must never replace it,
    // otherwise every later request would trust whatever the server said.
    const status = await options.client.getBuildStatus(target.buildUrl);
    return {
      jobUrl: target.jobUrl,
      jobLabel: target.jobLabel,
      buildUrl: target.buildUrl,
      buildNumber: target.buildNumber,
      building: status.building ?? false,
      result: status.result ?? null,
    };
  }
  const status = await options.client.getJobStatus(target.jobUrl);
  if (!status.buildUrl || status.buildNumber === undefined) {
    throw new CliError(
      `No builds found for ${target.jobLabel}.`,
      ["Pending inputs only exist on a running Pipeline build."],
      "NO_BUILDS",
    );
  }
  // Only the build number is taken from Jenkins; the URL is rebuilt under the
  // validated job URL so a hostile or misconfigured response cannot redirect
  // authenticated requests elsewhere.
  if (!Number.isSafeInteger(status.buildNumber) || status.buildNumber <= 0) {
    throw new CliError(
      `Unexpected Jenkins response while trying to resolve the latest build of ${target.jobLabel}: invalid build number.`,
      ["Retry with an explicit --build or --build-url."],
      "PIPELINE_INPUT_INVALID_RESPONSE",
    );
  }
  return {
    jobUrl: target.jobUrl,
    jobLabel: target.jobLabel,
    buildUrl: `${normalizeJobUrl(target.jobUrl)}/${status.buildNumber}/`,
    buildNumber: status.buildNumber,
    building: status.building ?? false,
    result: status.result ?? null,
  };
}

async function selectPendingInput(options: {
  client: JenkinsClient;
  target: ResolvedInputBuild;
  id?: string;
  nonInteractive: boolean;
}): Promise<PendingInputAction> {
  const actions = await options.client.listPendingInputActions(
    options.target.buildUrl,
  );
  const label = buildLabel(options.target);
  if (actions.length === 0) {
    recordInputOutcome("not_pending");
    throw new CliError(
      `No pending input actions for ${label}.`,
      [
        options.target.building
          ? "The build is running but not paused at an input step right now."
          : "The build has finished, so any input it had is already settled.",
      ],
      "INPUT_NOT_PENDING",
    );
  }

  const requestedId = options.id?.trim();
  if (requestedId) {
    const match = actions.find((action) => action.id === requestedId);
    if (!match) {
      recordInputOutcome("not_pending");
      throw new CliError(
        `No pending input action with id "${sanitizeInputText(requestedId)}" on ${label}.`,
        [`Pending ids: ${actions.map(displayId).join(", ")}.`],
        "INPUT_ACTION_NOT_FOUND",
      );
    }
    return match;
  }

  const [single] = actions;
  if (single && actions.length === 1) {
    return single;
  }
  if (options.nonInteractive) {
    throw new CliError(
      `${label} has ${actions.length} pending input actions; pass --id to choose one.`,
      [`Pending ids: ${actions.map(displayId).join(", ")}.`],
      "INPUT_ACTION_AMBIGUOUS",
    );
  }

  const deps = activeInputDeps;
  const selected = await deps.select({
    message: `Select a pending input on ${label}`,
    options: actions.map((action) => ({
      value: action.id,
      label: `${displayId(action)}: ${displayMessage(action)}`,
    })),
  });
  if (deps.isCancel(selected)) {
    throw new CliError("Operation cancelled.");
  }
  const match = actions.find((action) => action.id === selected);
  if (!match) {
    throw new CliError("Operation cancelled.");
  }
  return match;
}

/**
 * Confirms (when asked to), refreshes the action, submits through the Jenkins
 * provided URL, and turns the response into a receipt or a stable error.
 */
async function settlePendingInput(options: {
  client: JenkinsClient;
  operation: InputOperation;
  target: ResolvedInputBuild;
  action: PendingInputAction;
  confirm?: (options: {
    operation: InputOperation;
    target: ResolvedInputBuild;
    action: PendingInputAction;
  }) => Promise<ConfirmAnswer>;
}): Promise<SettleResult> {
  const { client, operation, target } = options;
  if (operation === "approve") {
    assertParameterlessApproval(options.action);
  }

  if (options.confirm) {
    const answer = await options.confirm({
      operation,
      target,
      action: options.action,
    });
    if (answer === "cancelled") {
      recordInputOutcome("cancelled");
      return { kind: "cancelled" };
    }
    if (answer === "no") {
      recordInputOutcome("declined");
      return { kind: "declined" };
    }
  }

  // Re-read right before submitting so a settled action, or one that gained
  // parameters, is caught while the user's confirmation is still fresh.
  const refreshed = await client.listPendingInputActions(target.buildUrl);
  const action = refreshed.find(
    (candidate) => candidate.id === options.action.id,
  );
  if (!action) {
    throw staleActionError(options.action.id, target, operation);
  }
  if (operation === "approve") {
    assertParameterlessApproval(action);
  }
  const url = operation === "approve" ? action.proceedUrl : action.abortUrl;
  if (!url) {
    throw new CliError(
      `Jenkins did not return a usable ${operation} URL for input "${displayId(action)}".`,
      [
        "The link was missing or pointed outside this build on the active controller, so nothing was submitted.",
        ...inspectInJenkinsHint(action, target),
      ],
      "INPUT_ACTION_URL_INVALID",
    );
  }

  const submission = await client.submitPendingInput({ url, operation });
  if (submission.outcome === "accepted") {
    recordInputOutcome(operation === "approve" ? "approved" : "aborted");
    return {
      kind: "settled",
      receipt: {
        operation,
        disposition: operation === "approve" ? "approved" : "aborted",
        build: jsonPendingInputBuild(target),
        action: { id: action.id, message: action.message },
      },
    };
  }

  const stillPending = await isStillPending(client, target.buildUrl, action.id);
  if (submission.outcome === "unconfirmed") {
    throw unknownOutcomeError(
      operation,
      action,
      target,
      submission.reason,
      stillPending,
    );
  }

  if (stillPending === false) {
    // Only a Jenkins-authored 4xx proves the request was refused before
    // anything committed. A server error, a redirect, or an HTML page could
    // all have been produced after Jenkins accepted the POST, so an action
    // that is gone afterwards has no authoritative disposition.
    if (submission.kind !== "http_error" || submission.httpStatus >= 500) {
      throw unknownOutcomeError(
        operation,
        action,
        target,
        `${describeRejection(submission)} and the action is no longer pending`,
        stillPending,
      );
    }
    throw staleActionError(action.id, target, operation, submission);
  }
  throw rejectionError(operation, action, target, submission);
}

function describeRejection(
  submission: Extract<PendingInputSubmission, { outcome: "rejected" }>,
): string {
  const detail = submission.detail ? ` (${submission.detail})` : "";
  switch (submission.kind) {
    case "redirect":
      return `Jenkins redirected the request with HTTP ${submission.httpStatus}${detail}`;
    case "html_page":
      return `Jenkins answered HTTP ${submission.httpStatus} with an HTML page${detail}`;
    default:
      return `Jenkins returned HTTP ${submission.httpStatus}${detail}`;
  }
}

function unknownOutcomeError(
  operation: InputOperation,
  action: PendingInputAction,
  target: ResolvedInputBuild,
  reason: string,
  stillPending: boolean | undefined,
): CliError {
  recordInputOutcome("unknown");
  return new CliError(
    `The ${operation} request for input "${displayId(action)}" on ${buildLabel(target)} could not be confirmed: ${reason}`,
    [
      stillPending === true
        ? "The input was still pending when re-read, but the request may still be processed. Inspect the build in Jenkins before retrying."
        : stillPending === false
          ? "The input is no longer pending, but that alone does not prove this request settled it. Inspect the build in Jenkins before taking further action."
          : "Pending inputs could not be re-read afterwards. Inspect the build in Jenkins before taking further action.",
      ...inspectInJenkinsHint(action, target),
    ],
    "INPUT_OUTCOME_UNKNOWN",
  );
}

function assertParameterlessApproval(action: PendingInputAction): void {
  if (action.parameters === null) {
    recordInputOutcome("parameters_unknown");
    throw new CliError(
      `Jenkins did not report whether input "${displayId(action)}" requires parameters, so it cannot be approved from the CLI.`,
      [
        "Approve it in Jenkins instead; aborting from the CLI is still supported.",
      ],
      "INPUT_PARAMETERS_UNKNOWN",
    );
  }
  if (action.parameters.length > 0) {
    recordInputOutcome("unsupported_parameters");
    throw new CliError(
      `Input "${displayId(action)}" requires ${action.parameters.length} parameter${action.parameters.length === 1 ? "" : "s"} (${action.parameters.map((parameter) => parameter.name).join(", ")}); parameterized approval is not supported by the CLI.`,
      [
        "Approve it in Jenkins to supply the values; aborting from the CLI is still supported.",
        ...(action.approvalUrl ? [`Open ${action.approvalUrl}`] : []),
      ],
      "INPUT_PARAMETERS_UNSUPPORTED",
    );
  }
}

async function isStillPending(
  client: JenkinsClient,
  buildUrl: string,
  id: string,
): Promise<boolean | undefined> {
  try {
    const actions = await client.listPendingInputActions(buildUrl);
    return actions.some((action) => action.id === id);
  } catch {
    return undefined;
  }
}

function staleActionError(
  id: string,
  target: ResolvedInputBuild,
  operation: InputOperation,
  submission?: Extract<PendingInputSubmission, { outcome: "rejected" }>,
): CliError {
  recordInputOutcome("stale");
  const rejection = submission
    ? ` Jenkins rejected this ${operation} with HTTP ${submission.httpStatus}${submission.detail ? ` (${submission.detail})` : ""}.`
    : "";
  return new CliError(
    `Input "${sanitizeInputText(id)}" on ${buildLabel(target)} is no longer pending; another user, a timeout, or a build cancellation settled it, so this ${operation} was not applied.${rejection}`,
    ["Run `input list` to see the build's current pending inputs."],
    "INPUT_ACTION_STALE",
  );
}

function rejectionError(
  operation: InputOperation,
  action: PendingInputAction,
  target: ResolvedInputBuild,
  submission: Extract<PendingInputSubmission, { outcome: "rejected" }>,
): CliError {
  const detail = submission.detail ?? "";
  const where = `input "${displayId(action)}" on ${buildLabel(target)}`;
  const inspect = inspectInJenkinsHint(action, target);
  if (submission.kind === "redirect") {
    recordInputOutcome("login_redirect");
    return new CliError(
      `The Jenkins API request was redirected to another page while trying to ${operation} ${where}; nothing was submitted.`,
      [
        "Jenkins or a proxy in front of it probably sent the request to a login page. Check credentials with `auth status`.",
      ],
      "JENKINS_LOGIN_REDIRECT",
    );
  }
  if (submission.kind === "html_page") {
    recordInputOutcome("login_redirect");
    return new CliError(
      `Unexpected Jenkins response while trying to ${operation} ${where}: received an HTML page instead of a Jenkins response, so the input was not settled by this command.`,
      [
        "A login page or proxy intercepted the request. Check the controller URL and credentials with `auth status`.",
        ...inspect,
      ],
      "PIPELINE_INPUT_INVALID_RESPONSE",
    );
  }
  if (/crumb/i.test(detail)) {
    recordInputOutcome("crumb_rejected");
    return new CliError(
      `Jenkins rejected the ${operation} for ${where} with HTTP ${submission.httpStatus} because the CSRF crumb was missing or invalid.`,
      [
        'Enable crumb usage with JENKINS_USE_CRUMB=true (or "useCrumb": true in the profile) and retry.',
      ],
      "JENKINS_CRUMB_REJECTED",
    );
  }
  if (/you need to (be|have)/i.test(detail)) {
    recordInputOutcome("permission_denied");
    return new CliError(
      `Jenkins denied the ${operation} for ${where}: ${detail}`,
      [
        operation === "approve"
          ? "Approving needs Job/Build permission or membership in the input's submitter list; you may still be allowed to abort."
          : "Aborting needs Job/Cancel permission or membership in the input's submitter list.",
        ...inspect,
      ],
      "INPUT_PERMISSION_DENIED",
    );
  }
  if (/already been given|does not have an Input with an ID/i.test(detail)) {
    return staleActionError(action.id, target, operation, submission);
  }
  recordInputOutcome("rejected");
  return new CliError(
    `Jenkins returned HTTP ${submission.httpStatus} while trying to ${operation} ${where}${detail ? `: ${detail}` : "."}`,
    [
      submission.httpStatus === 401 || submission.httpStatus === 403
        ? "Jenkins did not say whether this was a permission or CSRF rejection. Check credentials with `auth status` and crumb settings, and confirm you may settle this input."
        : `Jenkins rejected the request, so the input was not ${operation === "approve" ? "approved" : "aborted"} by this command. Check that you may settle it, then retry.`,
      ...inspect,
    ],
    "INPUT_SUBMISSION_REJECTED",
  );
}

function inspectInJenkinsHint(
  action: PendingInputAction,
  target: ResolvedInputBuild,
): string[] {
  return [
    `Inspect the build in Jenkins: ${action.approvalUrl ?? target.buildUrl}`,
  ];
}

async function promptConfirmation(options: {
  operation: InputOperation;
  target: ResolvedInputBuild;
  action: PendingInputAction;
}): Promise<ConfirmAnswer> {
  const deps = activeInputDeps;
  const verb = options.operation === "approve" ? "Approve" : "Abort";
  printOk(`Build: ${buildLabel(options.target)} (${options.target.buildUrl})`);
  printOk(
    `Input: ${displayId(options.action)}: ${displayMessage(options.action)}`,
  );
  const response = await deps.confirm({
    message: `${verb} input "${displayId(options.action)}" on ${buildLabel(options.target)}?`,
    initialValue: false,
  });
  if (deps.isCancel(response)) {
    return "cancelled";
  }
  return response === true ? "yes" : "no";
}

function printSettleResult(
  operation: InputOperation,
  result: Exclude<SettleResult, { kind: "cancelled" }>,
  target: ResolvedInputBuild,
): void {
  if (result.kind === "declined") {
    printOk(`${operation === "approve" ? "Approval" : "Abort"} skipped.`);
    return;
  }
  const { receipt } = result;
  printOk(
    `${receipt.disposition === "approved" ? "Approved" : "Aborted"} input "${sanitizeInputText(receipt.action.id)}" on ${buildLabel(target)}.`,
  );
  printOk(`Build URL: ${target.buildUrl}`);
}

function printPendingInputs(
  target: ResolvedInputBuild,
  actions: PendingInputAction[],
): void {
  const state = target.building ? "RUNNING" : target.result || "UNKNOWN";
  printOk(`Build: ${buildLabel(target)} (${state}) ${target.buildUrl}`);
  if (actions.length === 0) {
    printOk("No pending input actions.");
    return;
  }
  printOk(
    `${actions.length} pending input action${actions.length === 1 ? "" : "s"}:`,
  );
  for (const action of actions) {
    console.log(`  - ${displayId(action)}: ${displayMessage(action)}`);
    const parameters =
      action.parameters === null
        ? "unknown"
        : action.parameters.length === 0
          ? "none"
          : action.parameters
              .map((parameter) => sanitizeInputText(parameter.name))
              .join(", ");
    const operations = [
      ...(action.proceedUrl ? ["approve"] : []),
      ...(action.abortUrl ? ["abort"] : []),
    ];
    console.log(
      `    proceed: ${action.proceedText ? sanitizeInputText(action.proceedText) : "Proceed"} | parameters: ${parameters} | actions: ${operations.length > 0 ? operations.join(", ") : "none"}`,
    );
  }
}

function approveLabel(action: PendingInputAction): string {
  if (action.parameters === null) {
    return "Approve (parameter metadata unavailable)";
  }
  if (action.parameters.length > 0) {
    return `Approve (requires ${action.parameters.length} parameter${action.parameters.length === 1 ? "" : "s"}, unsupported)`;
  }
  return action.proceedText
    ? `Approve (${sanitizeInputText(action.proceedText)})`
    : "Approve";
}

/** Terminal-safe copy of the id; the raw id stays authoritative for matching and URLs. */
function displayId(action: PendingInputAction): string {
  return sanitizeInputText(action.id) || "(unprintable id)";
}

function displayMessage(action: PendingInputAction): string {
  const message = sanitizeInputText(action.message);
  return message || "(no message)";
}

function buildLabel(target: ResolvedInputBuild): string {
  return target.buildNumber === undefined
    ? target.buildUrl
    : `${target.jobLabel} #${target.buildNumber}`;
}

function jsonPendingInputBuild(
  target: ResolvedInputBuild,
): JsonPendingInputBuild {
  return {
    jobUrl: target.jobUrl,
    url: target.buildUrl,
    number: target.buildNumber,
    building: target.building,
    result: target.result,
  };
}

function recordInputOutcome(outcome: InputOutcome): void {
  updateAnalyticsContext({ input_outcome: outcome });
}
