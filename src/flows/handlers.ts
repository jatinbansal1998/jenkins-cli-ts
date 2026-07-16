import type {
  ActionEffectResult,
  BuildPreContext,
  BuildPostContext,
  EventId,
  FlowHandlerRegistry,
  ListInteractiveContext,
  StatusPostContext,
} from "./types";
import { printError, printHint } from "../cli";
import {
  loadCachedBranchHistory,
  loadCachedBranches,
  removeCachedBranch,
} from "../branches";
import { getJobDisplayName } from "../jobs";
import {
  BRANCH_CUSTOM_VALUE,
  BRANCH_REMOVE_VALUE,
  BUILD_CONFIGURE_DISCOVERED_VALUE,
  BUILD_WITH_CUSTOM_PARAMS_VALUE,
  BUILD_WITHOUT_PARAMS_VALUE,
  BUILD_WITH_PARAMS_VALUE,
} from "./constants";

const defaultBuildPreFlowDeps = {
  loadCachedBranchHistory,
  loadCachedBranches,
  removeCachedBranch,
  getJobDisplayName,
};

let activeBuildPreFlowDeps = defaultBuildPreFlowDeps;

export function setBuildPreFlowDepsForTesting(
  overrides?: Partial<typeof defaultBuildPreFlowDeps>,
): void {
  activeBuildPreFlowDeps = overrides
    ? { ...defaultBuildPreFlowDeps, ...overrides }
    : defaultBuildPreFlowDeps;
}

function resolveSelectEvent<T extends string>(input: T): `select:${T}` {
  return `select:${input}`;
}

async function pickListJobHandler({
  context,
}: {
  context: ListInteractiveContext;
}): Promise<"selected" | "cancelled"> {
  const result = await context.pickJob({
    env: context.env,
    jobs: context.jobs,
    initialQuery: context.initialQuery,
  });
  if (result.kind === "cancelled") {
    context.initialQuery = result.userInput;
    return "cancelled";
  }
  context.selectedJob = result.job;
  context.initialQuery = undefined;
  return "selected";
}

function selectListActionHandler({
  context,
  input,
}: {
  context: ListInteractiveContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  context.selectedAction = value;
  return resolveSelectEvent(value);
}

async function runListActionHandler({
  context,
}: {
  context: ListInteractiveContext;
}): Promise<ActionEffectResult> {
  if (!context.selectedJob || !context.selectedAction) {
    return "action_error";
  }
  return await context.performAction(
    context.selectedAction,
    context.selectedJob,
  );
}

function selectBuildActionHandler({
  context,
  input,
}: {
  context: BuildPostContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  if (value === "done") {
    return "done";
  }
  context.selectedAction = value;
  return resolveSelectEvent(value);
}

async function runBuildActionHandler({
  context,
}: {
  context: BuildPostContext;
}): Promise<ActionEffectResult> {
  if (!context.selectedAction) {
    return "action_error";
  }
  return await context.performAction(context.selectedAction);
}

function buildAfterMenuHandler({
  context,
}: {
  context: BuildPostContext;
}): EventId {
  return context.returnToCaller ? "return_to_caller" : "ask_repeat";
}

function buildAfterRootHandler({
  context,
}: {
  context: BuildPostContext;
}): EventId {
  return context.returnToCaller ? "return_to_caller_root" : "ask_repeat";
}

function repeatConfirmHandler({ input }: { input?: unknown }): EventId {
  return input ? "confirm:yes" : "confirm:no";
}

async function pickBuildJobHandler({
  context,
}: {
  context: BuildPreContext;
}): Promise<"selected" | "cancelled"> {
  const result = await context.pickJob({
    env: context.env,
    jobs: context.jobs,
    initialQuery: context.initialQuery,
  });
  if (result.kind === "cancelled") {
    context.initialQuery = result.userInput;
    return "cancelled";
  }
  const deps = activeBuildPreFlowDeps;
  context.selectedJobUrl = result.job.url;
  context.selectedJobLabel = deps.getJobDisplayName(result.job);
  context.initialQuery = undefined;
  context.buildModePrompted = false;
  context.parameterMode = undefined;
  context.parameterDefinitions = undefined;
  context.parameterDiscoveryAttempted = false;
  return "selected";
}

function selectBuildModeHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  if (value === BUILD_WITHOUT_PARAMS_VALUE) {
    context.parameterMode = "without";
    context.buildModePrompted = true;
    context.defaultBranch = true;
    context.branch = "";
    context.customParams = {};
    context.pendingCustomParamKey = undefined;
    context.lastAddedCustomParamKey = undefined;
    return "mode:without_params";
  }
  if (value === BUILD_WITH_CUSTOM_PARAMS_VALUE) {
    context.parameterMode = "custom";
    context.buildModePrompted = true;
    context.defaultBranch = false;
    context.branch = "";
    context.customParams = {};
    context.pendingCustomParamKey = undefined;
    context.lastAddedCustomParamKey = undefined;
    return "mode:with_custom";
  }
  if (value === BUILD_WITH_PARAMS_VALUE) {
    context.parameterMode = "branch";
    context.buildModePrompted = true;
    context.defaultBranch = false;
    context.branch = "";
    context.customParams = {};
    context.pendingCustomParamKey = undefined;
    context.lastAddedCustomParamKey = undefined;
    return "mode:with_branch";
  }
  context.parameterMode = "branch";
  context.buildModePrompted = true;
  return "mode:with_branch";
}

function selectDiscoveredModeHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  context.buildModePrompted = true;
  if (value === BUILD_WITHOUT_PARAMS_VALUE) {
    context.parameterMode = "without";
    context.defaultBranch = true;
    context.branch = "";
    context.customParams = {};
    return "mode:without_params";
  }
  if (value === BUILD_CONFIGURE_DISCOVERED_VALUE) {
    context.parameterMode = "discovered";
    context.defaultBranch = false;
    return "mode:configure_discovered";
  }
  return "mode:configure_discovered";
}

function leaveBuildModeHandler({
  context,
}: {
  context: BuildPreContext;
}): EventId {
  return context.jobSelectionLocked ? "build_mode:exit" : "build_mode:entry";
}

async function prepareBranchHandler({
  context,
}: {
  context: BuildPreContext;
}): Promise<EventId> {
  const jobUrl = context.selectedJobUrl?.trim() ?? "";
  if (
    !context.parameterDiscoveryAttempted &&
    jobUrl &&
    context.discoverParameters
  ) {
    context.parameterDiscoveryAttempted = true;
    try {
      context.parameterDefinitions = await context.discoverParameters(jobUrl);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "JENKINS_AUTH_ERROR"
      ) {
        throw error;
      }
      context.parameterDefinitions = undefined;
      printHint(
        "Could not discover job parameters; continuing with manual parameter entry.",
      );
    }
  }

  if (context.parameterDefinitions?.length) {
    const hasExplicitValues =
      Boolean(context.branch?.trim()) ||
      Object.keys(context.customParams).length > 0;
    if (hasExplicitValues || context.parameterMode === "discovered") {
      context.parameterMode = "discovered";
      return "parameters:configure";
    }
    if (context.defaultBranch) return "branch:ready";
    return "parameters:mode";
  }

  const branch = context.branch?.trim() ?? "";
  const hasCustomParams = Object.keys(context.customParams).length > 0;
  context.branch = branch;

  if (context.defaultBranch || branch || hasCustomParams) {
    return "branch:ready";
  }

  if (!context.buildModePrompted) {
    context.buildModePrompted = true;
    return "branch:mode";
  }

  if (context.parameterMode === "custom") {
    return "custom:key";
  }

  if (context.parameterMode !== "branch") {
    return "branch:mode";
  }

  if (!jobUrl) {
    return "branch:error";
  }

  const deps = activeBuildPreFlowDeps;
  const choices = dedupeCaseInsensitive(
    await deps.loadCachedBranches({
      env: context.env,
      jobUrl,
    }),
  );
  const removableBranches = dedupeCaseInsensitive(
    await deps.loadCachedBranchHistory({
      env: context.env,
      jobUrl,
    }),
  );

  context.branchChoices = choices;
  context.removableBranches = removableBranches;

  return choices.length > 0 ? "branch:select" : "branch:entry";
}

async function configureDiscoveredHandler({
  context,
}: {
  context: BuildPreContext;
}): Promise<EventId> {
  const definitions = context.parameterDefinitions ?? [];
  if (!context.configureDiscoveredParameters) return "parameters:cancelled";
  const result = await context.configureDiscoveredParameters(definitions);
  if (result.cancelled) return "parameters:cancelled";
  context.branch = result.branch;
  context.customParams = result.customParams;
  context.sensitiveParameterNames = result.sensitiveNames;
  context.defaultBranch = false;
  return "parameters:ready";
}

function selectBranchHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  if (value === BRANCH_REMOVE_VALUE && context.removableBranches.length > 0) {
    return "branch:remove";
  }
  if (value === BRANCH_CUSTOM_VALUE) {
    return "branch:entry";
  }
  const branch = value.trim();
  if (!branch) {
    printError("Branch is required to trigger a parameterized build.");
    printHint(
      "Enter a branch name (e.g. main), or go back and choose another build mode.",
    );
    return "branch:retry";
  }
  context.parameterMode = "branch";
  context.defaultBranch = false;
  context.branch = branch;
  return "branch:selected";
}

function selectBranchToRemoveHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const branch = String(input).trim();
  if (!branch) {
    return "remove:selected";
  }
  context.pendingBranchRemoval = branch;
  return "remove:selected";
}

async function removeBranchHandler({
  context,
}: {
  context: BuildPreContext;
}): Promise<EventId> {
  const jobUrl = context.selectedJobUrl?.trim() ?? "";
  const branch = context.pendingBranchRemoval?.trim() ?? "";
  context.pendingBranchRemoval = undefined;

  if (!jobUrl || !branch) {
    return "remove:done";
  }

  const removed = await activeBuildPreFlowDeps.removeCachedBranch({
    env: context.env,
    jobUrl,
    branch,
  });
  if (removed) {
    context.removableBranches = removeBranch(context.removableBranches, branch);
    context.branchChoices = removeBranch(context.branchChoices, branch);
  }
  return "remove:done";
}

function submitBranchHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const branch = String(input ?? "").trim();
  if (!branch) {
    printError("Branch is required to trigger a parameterized build.");
    printHint(
      "Enter a branch name (e.g. main), or go back and choose another build mode.",
    );
    return "branch:retry";
  }
  context.parameterMode = "branch";
  context.defaultBranch = false;
  context.branch = branch;
  return "branch:selected";
}

function submitCustomParamKeyHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const key = String(input ?? "").trim();
  if (!key) {
    printError("Parameter name is required.");
    printHint("Enter a parameter name (e.g. DEPLOY_ENV).");
    return "param:key_retry";
  }
  if (Object.prototype.hasOwnProperty.call(context.customParams, key)) {
    printError(`Parameter "${key}" is already set.`);
    printHint("Use unique parameter names when adding custom parameters.");
    return "param:key_retry";
  }
  if (context.branch && key === context.branchParam) {
    printError(`Parameter "${key}" is reserved for --branch.`);
    printHint(
      `Use a different key, or run without --branch to set "${key}" manually.`,
    );
    return "param:key_retry";
  }
  context.pendingCustomParamKey = key;
  return "param:key_ready";
}

function submitCustomParamValueHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const key = context.pendingCustomParamKey?.trim() ?? "";
  if (!key) {
    return "param:value_retry";
  }
  context.customParams[key] = String(input ?? "");
  context.pendingCustomParamKey = undefined;
  context.lastAddedCustomParamKey = key;
  return "param:added";
}

function cancelCustomParamEntryHandler({
  context,
}: {
  context: BuildPreContext;
}): EventId {
  context.pendingCustomParamKey = undefined;
  if (
    context.parameterMode === "custom" &&
    Object.keys(context.customParams).length === 0
  ) {
    context.parameterMode = undefined;
    context.buildModePrompted = false;
    return "custom:mode";
  }
  if (Object.keys(context.customParams).length > 0) {
    return "custom:review";
  }
  return "custom:done";
}

function revisitLastCustomParamHandler({
  context,
}: {
  context: BuildPreContext;
}): EventId {
  const key = context.lastAddedCustomParamKey?.trim() ?? "";
  if (key) {
    context.pendingCustomParamKey = key;
    return "custom:last_value";
  }
  return "custom:key";
}

function selectStatusActionHandler({
  context,
  input,
}: {
  context: StatusPostContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  if (value === "done") {
    return "done";
  }
  context.selectedAction = value;
  return resolveSelectEvent(value);
}

async function runStatusActionHandler({
  context,
}: {
  context: StatusPostContext;
}): Promise<ActionEffectResult> {
  if (!context.selectedAction) {
    return "action_error";
  }
  return await context.performAction(context.selectedAction);
}

export const listFlowHandlers = {
  "list.pickJob": pickListJobHandler,
  "list.selectAction": selectListActionHandler,
  "list.runAction": runListActionHandler,
} satisfies FlowHandlerRegistry<ListInteractiveContext>;

export const buildFlowHandlers = {
  "build.selectAction": selectBuildActionHandler,
  "build.runAction": runBuildActionHandler,
  "build.afterMenu": buildAfterMenuHandler,
  "build.afterRoot": buildAfterRootHandler,
  "build.repeatConfirm": repeatConfirmHandler,
} satisfies FlowHandlerRegistry<BuildPostContext>;

export const buildPreFlowHandlers = {
  "buildPre.pickJob": pickBuildJobHandler,
  "buildPre.selectBuildMode": selectBuildModeHandler,
  "buildPre.selectDiscoveredMode": selectDiscoveredModeHandler,
  "buildPre.leaveBuildMode": leaveBuildModeHandler,
  "buildPre.prepareBranch": prepareBranchHandler,
  "buildPre.configureDiscovered": configureDiscoveredHandler,
  "buildPre.selectBranch": selectBranchHandler,
  "buildPre.selectBranchToRemove": selectBranchToRemoveHandler,
  "buildPre.removeBranch": removeBranchHandler,
  "buildPre.submitBranch": submitBranchHandler,
  "buildPre.submitCustomParamKey": submitCustomParamKeyHandler,
  "buildPre.submitCustomParamValue": submitCustomParamValueHandler,
  "buildPre.cancelCustomParamEntry": cancelCustomParamEntryHandler,
  "buildPre.revisitLastCustomParam": revisitLastCustomParamHandler,
} satisfies FlowHandlerRegistry<BuildPreContext>;

export const statusFlowHandlers = {
  "status.selectAction": selectStatusActionHandler,
  "status.runAction": runStatusActionHandler,
  "status.repeatConfirm": repeatConfirmHandler,
} satisfies FlowHandlerRegistry<StatusPostContext>;

function dedupeCaseInsensitive(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const key = entry.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function removeBranch(entries: string[], target: string): string[] {
  const key = target.toLowerCase();
  return entries.filter((entry) => entry.toLowerCase() !== key);
}
