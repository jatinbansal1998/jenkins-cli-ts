import type {
  ActionEffectResult,
  BuildPreContext,
  BuildPostContext,
  EventId,
  FlowHandlerRegistry,
  ListInteractiveContext,
  StatusPostContext,
} from "./types";
import { CliError, printError, printHint } from "../cli";
import {
  loadCachedBranchHistory,
  loadCachedBranches,
  removeCachedBranch,
} from "../branches";
import { getJobDisplayName, resolveJobCandidates } from "../jobs";
import {
  BRANCH_CUSTOM_VALUE,
  BRANCH_REMOVE_VALUE,
  BUILD_WITH_CUSTOM_PARAMS_VALUE,
  BUILD_WITHOUT_PARAMS_VALUE,
  BUILD_WITH_PARAMS_VALUE,
  EXIT_VALUE,
  SEARCH_AGAIN_VALUE,
  SEARCH_ALL_JOBS_VALUE,
} from "./constants";

type SelectEvent = `select:${string}`;

function resolveSelectEvent<T extends string>(input: T): `select:${T}` {
  return `select:${input}`;
}

function selectJobHandler({
  context,
  input,
}: {
  context: ListInteractiveContext;
  input?: unknown;
}): SelectEvent {
  const value = String(input);
  if (value === SEARCH_AGAIN_VALUE) {
    return "select:search_again";
  }
  if (value === EXIT_VALUE) {
    return "select:exit";
  }
  const selectedJob = context.jobs.find((job) => job.url === value);
  if (!selectedJob) {
    return "select:search_again";
  }
  context.selectedJob = selectedJob;
  return "select:job";
}

function selectListActionHandler({
  context,
  input,
}: {
  context: ListInteractiveContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  if (value === "done") {
    return "done";
  }
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

function buildPreEntryHandler({
  context,
}: {
  context: BuildPreContext;
}): EventId {
  return context.recentJobs.length > 0 ? "show_recent" : "search_direct";
}

function selectRecentJobHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  if (value === SEARCH_ALL_JOBS_VALUE) {
    return "select:search_all";
  }
  const recent = context.recentJobs.find((entry) => entry.url === value);
  if (!recent) {
    return "select:search_all";
  }
  const matchingJob = context.jobs.find((job) => job.url === recent.url);
  context.selectedJobUrl = recent.url;
  context.selectedJobLabel = matchingJob
    ? getJobDisplayName(matchingJob)
    : recent.label;
  context.searchQuery = "";
  context.searchCandidates = [];
  context.buildModePrompted = false;
  return "select:recent";
}

function submitSearchHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const query = String(input ?? "").trim();
  context.searchQuery = query;
  if (!query) {
    printError("Job name is required.");
    printHint("Type part of the job name or description to continue.");
    return "search:retry";
  }

  try {
    const candidates = resolveJobCandidates(query, context.jobs);
    if (candidates.length === 1 && candidates[0]) {
      context.selectedJobUrl = candidates[0].url;
      context.selectedJobLabel = getJobDisplayName(candidates[0]);
      context.searchCandidates = [];
      context.buildModePrompted = false;
      return "search:auto";
    }
    context.searchCandidates = candidates;
    return "search:candidates";
  } catch (error) {
    if (error instanceof CliError && shouldRetryJobSearch(error)) {
      printError(error.message);
      for (const hint of error.hints) {
        printHint(hint);
      }
      return "search:retry";
    }
    throw error;
  }
}

function selectSearchCandidateHandler({
  context,
  input,
}: {
  context: BuildPreContext;
  input?: unknown;
}): EventId {
  const value = String(input);
  const selected = context.searchCandidates.find((job) => job.url === value);
  if (!selected) {
    return "select:search_again";
  }
  context.selectedJobUrl = selected.url;
  context.selectedJobLabel = getJobDisplayName(selected);
  context.searchCandidates = [];
  context.buildModePrompted = false;
  return "select:job";
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
    return "mode:without_params";
  }
  if (value === BUILD_WITH_CUSTOM_PARAMS_VALUE) {
    context.parameterMode = "custom";
    context.buildModePrompted = true;
    context.defaultBranch = false;
    context.branch = "";
    context.customParams = {};
    context.pendingCustomParamKey = undefined;
    return "mode:with_custom";
  }
  if (value === BUILD_WITH_PARAMS_VALUE) {
    context.parameterMode = "branch";
    context.buildModePrompted = true;
    context.defaultBranch = false;
    context.branch = "";
    context.customParams = {};
    context.pendingCustomParamKey = undefined;
    return "mode:with_branch";
  }
  context.parameterMode = "branch";
  context.buildModePrompted = true;
  return "mode:with_branch";
}

async function prepareBranchHandler({
  context,
}: {
  context: BuildPreContext;
}): Promise<EventId> {
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

  const jobUrl = context.selectedJobUrl?.trim() ?? "";
  if (!jobUrl) {
    return "branch:error";
  }

  const choices = dedupeCaseInsensitive(
    await loadCachedBranches({
      env: context.env,
      jobUrl,
    }),
  );
  const removableBranches = dedupeCaseInsensitive(
    await loadCachedBranchHistory({
      env: context.env,
      jobUrl,
    }),
  );

  context.branchChoices = choices;
  context.removableBranches = removableBranches;

  return choices.length > 0 ? "branch:select" : "branch:entry";
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

  const removed = await removeCachedBranch({
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
  return "custom:done";
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
  "list.selectJob": selectJobHandler,
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
  "buildPre.entry": buildPreEntryHandler,
  "buildPre.selectRecentJob": selectRecentJobHandler,
  "buildPre.submitSearch": submitSearchHandler,
  "buildPre.selectSearchCandidate": selectSearchCandidateHandler,
  "buildPre.selectBuildMode": selectBuildModeHandler,
  "buildPre.prepareBranch": prepareBranchHandler,
  "buildPre.selectBranch": selectBranchHandler,
  "buildPre.selectBranchToRemove": selectBranchToRemoveHandler,
  "buildPre.removeBranch": removeBranchHandler,
  "buildPre.submitBranch": submitBranchHandler,
  "buildPre.submitCustomParamKey": submitCustomParamKeyHandler,
  "buildPre.submitCustomParamValue": submitCustomParamValueHandler,
  "buildPre.cancelCustomParamEntry": cancelCustomParamEntryHandler,
} satisfies FlowHandlerRegistry<BuildPreContext>;

export const statusFlowHandlers = {
  "status.selectAction": selectStatusActionHandler,
  "status.runAction": runStatusActionHandler,
  "status.repeatConfirm": repeatConfirmHandler,
} satisfies FlowHandlerRegistry<StatusPostContext>;

function shouldRetryJobSearch(error: CliError): boolean {
  if (error.message === "Job name is required.") {
    return true;
  }
  return error.message.startsWith("No jobs match ");
}

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
