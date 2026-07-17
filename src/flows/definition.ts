import type {
  BuildPreContext,
  BuildPostContext,
  FlowDefinition,
  ListInteractiveContext,
  PromptOption,
  StatusPostContext,
} from "./types";
import {
  BRANCH_REMOVE_VALUE,
  BUILD_CONFIGURE_DISCOVERED_VALUE,
  BUILD_WITH_CUSTOM_PARAMS_VALUE,
  BUILD_WITHOUT_PARAMS_VALUE,
  BUILD_WITH_PARAMS_VALUE,
  CUSTOM_MORE_ADD_VALUE,
  CUSTOM_MORE_BUILD_VALUE,
  CUSTOM_MORE_CANCEL_VALUE,
} from "./constants";
import { withPromptTarget } from "../tui-target";

const ACTION_MENU_ORDER = [
  "build",
  "rerun_last",
  "rerun",
  "view_params",
  "status",
  "watch",
  "logs",
  "history",
  "cancel",
  "search",
  "exit",
  "done",
] as const;

function orderActionOptions(options: PromptOption[]): PromptOption[] {
  const optionsByValue = new Map(
    options.map((option) => [option.value, option]),
  );
  const orderedOptions = ACTION_MENU_ORDER.flatMap((value) => {
    const option = optionsByValue.get(value);

    if (!option) {
      return [];
    }

    optionsByValue.delete(value);
    return [option];
  });

  return [...orderedOptions, ...optionsByValue.values()];
}

export const listInteractiveFlow: FlowDefinition<ListInteractiveContext> = {
  id: "listInteractive",
  initialState: "select_job",
  states: {
    /** Root entry state delegated to the shared Jenkins job picker. */
    select_job: {
      root: true,
      onEnter: "list.pickJob",
      transitions: {
        cancelled: "exit_command",
        selected: "action_menu",
      },
    },
    /** Action picker for the currently selected job. */
    action_menu: {
      prompt: {
        kind: "select",
        message: (context) =>
          withPromptTarget(
            `Action for ${context.selectedJob?.fullName || context.selectedJob?.name || "job"}`,
            context.env,
          ),
        options: orderActionOptions([
          { value: "build", label: "Build" },
          { value: "rerun_last", label: "Rerun last build" },
          { value: "rerun", label: "Rerun last failed" },
          { value: "view_params", label: "View parameters" },
          { value: "status", label: "Status" },
          { value: "watch", label: "Watch" },
          { value: "logs", label: "Logs" },
          { value: "history", label: "Build history" },
          { value: "cancel", label: "Cancel" },
          { value: "search", label: "Back to search" },
          { value: "exit", label: "Exit" },
        ]),
      },
      onSelect: "list.selectAction",
      transitions: {
        esc: "select_job",
        "select:search": "select_job",
        "select:exit": "exit_command",
        "select:build": "run_action",
        "select:view_params": "run_action",
        "select:status": "run_action",
        "select:history": "run_action",
        "select:watch": "run_action",
        "select:logs": "run_action",
        "select:cancel": "run_action",
        "select:rerun_last": "run_action",
        "select:rerun": "run_action",
      },
    },
    /** Executes the selected action and routes based on action outcome. */
    run_action: {
      onEnter: "list.runAction",
      transitions: {
        action_ok: "action_menu",
        watch_cancelled: "select_job",
        action_error: "select_job",
        root: "select_job",
        exit: "exit_command",
      },
    },
  },
};

export const buildPreFlow: FlowDefinition<BuildPreContext> = {
  id: "buildPre",
  initialState: "entry",
  states: {
    /** Root entry state delegated to the shared Jenkins job picker. */
    entry: {
      root: true,
      onEnter: "buildPre.pickJob",
      transitions: {
        cancelled: "exit_command",
        selected: "prepare_branch",
      },
    },
    /** Selects whether to configure discovered parameters or use Jenkins defaults. */
    discovered_mode: {
      prompt: {
        kind: "select",
        message: (context) => withPromptTarget("Build parameters", context.env),
        options: [
          {
            value: BUILD_CONFIGURE_DISCOVERED_VALUE,
            label: "Configure parameters",
          },
          {
            value: BUILD_WITHOUT_PARAMS_VALUE,
            label: "Run with default parameters",
          },
        ],
      },
      onSelect: "buildPre.selectDiscoveredMode",
      transitions: {
        esc: "build_mode_back",
        "mode:configure_discovered": "configure_discovered",
        "mode:without_params": "complete",
      },
    },
    /** Prompts for normalized Jenkins parameter definitions. */
    configure_discovered: {
      onEnter: "buildPre.configureDiscovered",
      transitions: {
        "parameters:ready": "complete",
        "parameters:cancelled": "exit_command",
      },
    },
    /** Selects whether to trigger with branch/custom parameters or without parameters. */
    branch_mode: {
      prompt: {
        kind: "select",
        message: (context) => withPromptTarget("Build mode", context.env),
        options: [
          {
            value: BUILD_WITH_PARAMS_VALUE,
            label: "Select a branch",
          },
          {
            value: BUILD_WITH_CUSTOM_PARAMS_VALUE,
            label: "Enter custom parameters",
          },
          {
            value: BUILD_WITHOUT_PARAMS_VALUE,
            label: "Run with default parameters",
          },
        ],
      },
      onSelect: "buildPre.selectBuildMode",
      transitions: {
        esc: "build_mode_back",
        "mode:with_branch": "prepare_branch",
        "mode:with_custom": "custom_key",
        "mode:without_params": "complete",
      },
    },
    /** Resolves whether Esc from build mode should exit or reopen job selection. */
    build_mode_back: {
      onEnter: "buildPre.leaveBuildMode",
      transitions: {
        "build_mode:entry": "entry",
        "build_mode:exit": "exit_command",
      },
    },
    /** Loads branch metadata and decides if branch/custom input is needed. */
    prepare_branch: {
      onEnter: "buildPre.prepareBranch",
      transitions: {
        "branch:ready": "complete",
        "parameters:mode": "discovered_mode",
        "parameters:configure": "configure_discovered",
        "branch:mode": "branch_mode",
        "branch:select": "branch_select",
        "branch:entry": "branch_entry",
        "custom:key": "custom_key",
        "branch:error": "entry",
      },
    },
    /** Combined branch chooser: cached branches plus inline custom input. */
    branch_select: {
      prompt: {
        kind: "branchPicker",
        message: (context) =>
          withPromptTarget(
            "Branch name (press Esc for build mode)",
            context.env,
          ),
        options: (context) => [
          ...context.branchChoices.map((branch) => ({
            value: branch,
            label: branch,
          })),
          ...(context.removableBranches.length > 0
            ? [{ value: BRANCH_REMOVE_VALUE, label: "Remove cached branch" }]
            : []),
        ],
        placeholder: "e.g. main",
      },
      onSelect: "buildPre.selectBranch",
      transitions: {
        esc: "branch_mode",
        "branch:selected": "custom_confirm",
        "branch:remove": "branch_remove",
        "branch:retry": "branch_select",
      },
    },
    /** Menu for selecting which cached branch entry to remove. */
    branch_remove: {
      prompt: {
        kind: "select",
        message: (context) =>
          withPromptTarget("Remove cached branch", context.env),
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
        message: (context) => withPromptTarget("Branch name", context.env),
        placeholder: "e.g. main",
      },
      onSelect: "buildPre.submitBranch",
      transitions: {
        esc: "branch_mode",
        "branch:retry": "branch_entry",
        "branch:selected": "custom_confirm",
      },
    },
    /** Optional branch follow-up for adding extra custom parameters. */
    custom_confirm: {
      prompt: {
        kind: "confirm",
        message: (context) =>
          withPromptTarget("Add custom parameters?", context.env),
        initialValue: false,
      },
      transitions: {
        esc: "complete",
        "confirm:yes": "custom_key",
        "confirm:no": "complete",
      },
    },
    /** Custom parameter key entry point. */
    custom_key: {
      prompt: {
        kind: "text",
        message: (context) => withPromptTarget("Parameter name", context.env),
        placeholder: "e.g. DEPLOY_ENV",
      },
      onSelect: "buildPre.submitCustomParamKey",
      transitions: {
        esc: "custom_cancel",
        "param:key_retry": "custom_key",
        "param:key_ready": "custom_value",
      },
    },
    /** Custom parameter value prompt for the currently pending key. */
    custom_value: {
      prompt: {
        kind: "text",
        message: (context) =>
          withPromptTarget(
            context.pendingCustomParamKey
              ? `Value for ${context.pendingCustomParamKey}`
              : "Parameter value",
            context.env,
          ),
        initialValue: (context) => {
          const key = context.pendingCustomParamKey?.trim() ?? "";
          return key ? (context.customParams[key] ?? "") : "";
        },
      },
      onSelect: "buildPre.submitCustomParamValue",
      transitions: {
        esc: "custom_key",
        "param:value_retry": "custom_key",
        "param:added": "custom_more",
      },
    },
    /** Next-step menu after adding a custom parameter. */
    custom_more: {
      prompt: {
        kind: "select",
        message: (context) =>
          withPromptTarget("Custom parameter options", context.env),
        options: [
          {
            value: CUSTOM_MORE_ADD_VALUE,
            label: "Add another parameter",
          },
          {
            value: CUSTOM_MORE_BUILD_VALUE,
            label: "Start build",
          },
          {
            value: CUSTOM_MORE_CANCEL_VALUE,
            label: "Cancel build",
          },
        ],
      },
      transitions: {
        esc: "custom_more_back",
        [`select:${CUSTOM_MORE_ADD_VALUE}`]: "custom_key",
        [`select:${CUSTOM_MORE_BUILD_VALUE}`]: "complete",
        [`select:${CUSTOM_MORE_CANCEL_VALUE}`]: "exit_command",
      },
    },
    /** Restores the last parameter value prompt when backing out of the menu. */
    custom_more_back: {
      onEnter: "buildPre.revisitLastCustomParam",
      transitions: {
        "custom:last_value": "custom_value",
        "custom:key": "custom_key",
      },
    },
    /** Handles Esc behavior for custom-parameter entry states. */
    custom_cancel: {
      onEnter: "buildPre.cancelCustomParamEntry",
      transitions: {
        "custom:mode": "branch_mode",
        "custom:review": "custom_more",
        "custom:done": "complete",
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
        message: (context) =>
          withPromptTarget(`Next action for ${context.jobLabel}`, context.env),
        options: orderActionOptions([
          { value: "rerun", label: "Rerun same inputs" },
          { value: "rerun_last", label: "Rerun last build" },
          { value: "watch", label: "Watch" },
          { value: "logs", label: "Logs" },
          { value: "history", label: "Build history" },
          { value: "cancel", label: "Cancel" },
          { value: "done", label: "Done" },
        ]),
      },
      onSelect: "build.selectAction",
      transitions: {
        esc: "after_menu",
        done: "after_menu",
        "select:watch": "run_action",
        "select:history": "run_action",
        "select:logs": "run_action",
        "select:cancel": "run_action",
        "select:rerun": "run_action",
        "select:rerun_last": "run_action",
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
        message: (context) =>
          withPromptTarget("Trigger another build?", context.env),
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
        message: (context) =>
          withPromptTarget(`Action for ${context.targetLabel}`, context.env),
        options: orderActionOptions([
          { value: "build", label: "Build now" },
          { value: "rerun_last", label: "Rerun last build" },
          { value: "rerun", label: "Rerun last failed build" },
          { value: "watch", label: "Watch" },
          { value: "logs", label: "Logs" },
          { value: "history", label: "Build history" },
          { value: "cancel", label: "Cancel running/queued build" },
          { value: "done", label: "Done" },
        ]),
      },
      onSelect: "status.selectAction",
      transitions: {
        esc: "again_confirm",
        done: "again_confirm",
        "select:watch": "run_action",
        "select:history": "run_action",
        "select:logs": "run_action",
        "select:cancel": "run_action",
        "select:rerun_last": "run_action",
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
        message: (context) =>
          withPromptTarget("Check another job?", context.env),
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
