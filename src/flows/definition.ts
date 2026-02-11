import type {
  BuildPreContext,
  BuildPostContext,
  FlowDefinition,
  ListInteractiveContext,
  StatusPostContext,
} from "./types";
import {
  BRANCH_CUSTOM_VALUE,
  BRANCH_REMOVE_VALUE,
  BUILD_WITHOUT_PARAMS_VALUE,
  BUILD_WITH_PARAMS_VALUE,
  EXIT_VALUE,
  SEARCH_AGAIN_VALUE,
  SEARCH_ALL_JOBS_VALUE,
} from "./constants";

export const listInteractiveFlow: FlowDefinition<ListInteractiveContext> = {
  id: "listInteractive",
  initialState: "select_job",
  states: {
    /** Root selector for choosing a job, searching again, or exiting. */
    select_job: {
      root: true,
      prompt: {
        kind: "select",
        message: "Select a job to operate on",
        options: (context) => [
          ...context.jobs.map((job) => ({
            value: job.url,
            label: job.fullName || job.name,
          })),
          { value: SEARCH_AGAIN_VALUE, label: "Search again" },
          { value: EXIT_VALUE, label: "Exit" },
        ],
      },
      onSelect: "list.selectJob",
      transitions: {
        esc: "root",
        "select:search_again": "root",
        "select:exit": "exit_command",
        "select:job": "action_menu",
      },
    },
    /** Action picker for the currently selected job. */
    action_menu: {
      prompt: {
        kind: "select",
        message: (context) =>
          `Action for ${context.selectedJob?.fullName || context.selectedJob?.name || "job"}`,
        options: [
          { value: "build", label: "Build" },
          { value: "status", label: "Status" },
          { value: "watch", label: "Watch" },
          { value: "logs", label: "Logs" },
          { value: "cancel", label: "Cancel" },
          { value: "rerun", label: "Rerun last failed" },
          { value: "search", label: "Back to search" },
          { value: "exit", label: "Exit" },
        ],
      },
      onSelect: "list.selectAction",
      transitions: {
        esc: "select_job",
        "select:search": "root",
        "select:exit": "exit_command",
        "select:build": "run_action",
        "select:status": "run_action",
        "select:watch": "run_action",
        "select:logs": "run_action",
        "select:cancel": "run_action",
        "select:rerun": "run_action",
      },
    },
    /** Executes the selected action and routes based on action outcome. */
    run_action: {
      onEnter: "list.runAction",
      transitions: {
        action_ok: "action_menu",
        watch_cancelled: "root",
        action_error: "root",
        root: "root",
        exit: "exit_command",
      },
    },
  },
};

export const buildPreFlow: FlowDefinition<BuildPreContext> = {
  id: "buildPre",
  initialState: "entry",
  states: {
    /** Entry router that decides recent-jobs flow vs direct search flow. */
    entry: {
      onEnter: "buildPre.entry",
      transitions: {
        show_recent: "recent_menu",
        search_direct: "search_direct",
      },
    },
    /** Root menu for picking a recent job or switching to full search. */
    recent_menu: {
      root: true,
      prompt: {
        kind: "select",
        message: "Recent jobs",
        options: (context) => [
          { value: SEARCH_ALL_JOBS_VALUE, label: "Search all jobs" },
          ...context.recentJobs.map((job) => ({
            value: job.url,
            label: job.label,
          })),
        ],
      },
      onSelect: "buildPre.selectRecentJob",
      transitions: {
        esc: "exit_command",
        "select:search_all": "search_from_recent",
        "select:recent": "prepare_branch",
      },
    },
    /** Search prompt reached from the recent-jobs menu. */
    search_from_recent: {
      prompt: {
        kind: "text",
        message: "Job name or description",
        placeholder: "e.g. api prod deploy",
        initialValue: (context) => context.searchQuery,
      },
      onSelect: "buildPre.submitSearch",
      transitions: {
        esc: "recent_menu",
        "search:retry": "search_from_recent",
        "search:candidates": "results_from_recent",
        "search:auto": "prepare_branch",
      },
    },
    /** Root search prompt used when build starts without a preset job. */
    search_direct: {
      root: true,
      prompt: {
        kind: "text",
        message: "Job name or description",
        placeholder: "e.g. api prod deploy",
        initialValue: (context) => context.searchQuery,
      },
      onSelect: "buildPre.submitSearch",
      transitions: {
        esc: "exit_command",
        "search:retry": "search_direct",
        "search:candidates": "results_direct",
        "search:auto": "prepare_branch",
      },
    },
    /** Candidate list after searching from the recent-jobs path. */
    results_from_recent: {
      prompt: {
        kind: "select",
        message: "Select a job (press Esc to search again)",
        options: (context) =>
          context.searchCandidates.map((job) => ({
            value: job.url,
            label: job.fullName || job.name,
          })),
      },
      onSelect: "buildPre.selectSearchCandidate",
      transitions: {
        esc: "search_from_recent",
        "select:search_again": "search_from_recent",
        "select:job": "prepare_branch",
      },
    },
    /** Candidate list after searching from the direct-search path. */
    results_direct: {
      prompt: {
        kind: "select",
        message: "Select a job (press Esc to search again)",
        options: (context) =>
          context.searchCandidates.map((job) => ({
            value: job.url,
            label: job.fullName || job.name,
          })),
      },
      onSelect: "buildPre.selectSearchCandidate",
      transitions: {
        esc: "search_direct",
        "select:search_again": "search_direct",
        "select:job": "prepare_branch",
      },
    },
    /** Selects whether to trigger with branch parameter or without parameters. */
    branch_mode: {
      prompt: {
        kind: "select",
        message: "Build mode",
        options: [
          {
            value: BUILD_WITH_PARAMS_VALUE,
            label: "Build with branch parameter",
          },
          {
            value: BUILD_WITHOUT_PARAMS_VALUE,
            label: "Build without parameters",
          },
        ],
      },
      onSelect: "buildPre.selectBuildMode",
      transitions: {
        esc: "entry",
        "mode:with_params": "prepare_branch",
        "mode:without_params": "complete",
      },
    },
    /** Loads branch metadata and decides if branch input is needed. */
    prepare_branch: {
      onEnter: "buildPre.prepareBranch",
      transitions: {
        "branch:ready": "complete",
        "branch:mode": "branch_mode",
        "branch:select": "branch_select",
        "branch:entry": "branch_entry",
        "branch:error": "entry",
      },
    },
    /** Branch chooser with cached branches and utility actions. */
    branch_select: {
      prompt: {
        kind: "select",
        message: "Branch name (press Esc to choose another job)",
        options: (context) => [
          ...(context.removableBranches.length > 0
            ? [{ value: BRANCH_REMOVE_VALUE, label: "Remove cached branch" }]
            : []),
          ...context.branchChoices.map((branch) => ({
            value: branch,
            label: branch,
          })),
          { value: BRANCH_CUSTOM_VALUE, label: "Type a different branch" },
        ],
      },
      onSelect: "buildPre.selectBranch",
      transitions: {
        esc: "entry",
        "branch:selected": "complete",
        "branch:entry": "branch_entry",
        "branch:remove": "branch_remove",
      },
    },
    /** Menu for selecting which cached branch entry to remove. */
    branch_remove: {
      prompt: {
        kind: "select",
        message: "Remove cached branch",
        options: (context) =>
          context.removableBranches.map((branch) => ({
            value: branch,
            label: branch,
          })),
      },
      onSelect: "buildPre.selectBranchToRemove",
      transitions: {
        esc: "branch_select",
        "remove:selected": "branch_remove_apply",
      },
    },
    /** Applies cached-branch removal, then returns to branch selection. */
    branch_remove_apply: {
      onEnter: "buildPre.removeBranch",
      transitions: {
        "remove:done": "branch_select",
      },
    },
    /** Free-text branch input when the desired branch is not listed. */
    branch_entry: {
      prompt: {
        kind: "text",
        message: "Branch name",
        placeholder: "e.g. main",
      },
      onSelect: "buildPre.submitBranch",
      transitions: {
        esc: "branch_select",
        "branch:retry": "branch_entry",
        "branch:selected": "complete",
      },
    },
  },
};

export const buildPostFlow: FlowDefinition<BuildPostContext> = {
  id: "buildPost",
  initialState: "action_menu",
  states: {
    /** Post-build action menu for follow-up operations on the same job. */
    action_menu: {
      prompt: {
        kind: "select",
        message: (context) => `Next action for ${context.jobLabel}`,
        options: [
          { value: "watch", label: "Watch" },
          { value: "logs", label: "Logs" },
          { value: "cancel", label: "Cancel" },
          { value: "rerun", label: "Rerun same inputs" },
          { value: "done", label: "Done" },
        ],
      },
      onSelect: "build.selectAction",
      transitions: {
        esc: "after_menu",
        done: "after_menu",
        "select:watch": "run_action",
        "select:logs": "run_action",
        "select:cancel": "run_action",
        "select:rerun": "run_action",
      },
    },
    /** Executes the chosen post-build action and handles its result. */
    run_action: {
      onEnter: "build.runAction",
      transitions: {
        action_ok: "action_menu",
        watch_cancelled: "after_root",
        action_error: "after_root",
        root: "after_root",
        exit: "exit_command",
      },
    },
    /** Resolves where to return after leaving the post-build menu. */
    after_menu: {
      onEnter: "build.afterMenu",
      transitions: {
        ask_repeat: "repeat_confirm",
        return_to_caller: "return_to_caller",
      },
    },
    /** Resolves root-return behavior after action-driven interruption. */
    after_root: {
      onEnter: "build.afterRoot",
      transitions: {
        ask_repeat: "repeat_confirm",
        return_to_caller_root: "return_to_caller_root",
      },
    },
    /** Root confirmation prompt to optionally run another build. */
    repeat_confirm: {
      root: true,
      prompt: {
        kind: "confirm",
        message: "Trigger another build?",
        initialValue: false,
      },
      onSelect: "build.repeatConfirm",
      transitions: {
        esc: "exit_command",
        "confirm:yes": "repeat",
        "confirm:no": "exit_command",
      },
    },
  },
};

export const statusPostFlow: FlowDefinition<StatusPostContext> = {
  id: "statusPost",
  initialState: "action_menu",
  states: {
    /** Post-status action menu for follow-up operations on the target. */
    action_menu: {
      prompt: {
        kind: "select",
        message: (context) => `Action for ${context.targetLabel}`,
        options: [
          { value: "watch", label: "Watch" },
          { value: "logs", label: "Logs" },
          { value: "cancel", label: "Cancel running/queued build" },
          { value: "rerun", label: "Rerun last failed build" },
          { value: "build", label: "Build now" },
          { value: "done", label: "Done" },
        ],
      },
      onSelect: "status.selectAction",
      transitions: {
        esc: "again_confirm",
        done: "again_confirm",
        "select:watch": "run_action",
        "select:logs": "run_action",
        "select:cancel": "run_action",
        "select:rerun": "run_action",
        "select:build": "run_action",
      },
    },
    /** Executes status follow-up action and routes on outcome. */
    run_action: {
      onEnter: "status.runAction",
      transitions: {
        action_ok: "action_menu",
        watch_cancelled: "again_confirm",
        action_error: "again_confirm",
        root: "again_confirm",
        exit: "exit_command",
      },
    },
    /** Root confirmation prompt to optionally inspect another job. */
    again_confirm: {
      root: true,
      prompt: {
        kind: "confirm",
        message: "Check another job?",
        initialValue: false,
      },
      onSelect: "status.repeatConfirm",
      transitions: {
        esc: "exit_command",
        "confirm:yes": "repeat",
        "confirm:no": "exit_command",
      },
    },
  },
};

/** Preferred registry with readable camelCase keys for direct imports/usage. */
export const flows = {
  listInteractive: listInteractiveFlow,
  buildPre: buildPreFlow,
  buildPost: buildPostFlow,
  statusPost: statusPostFlow,
};
