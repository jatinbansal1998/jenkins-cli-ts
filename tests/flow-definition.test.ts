import { describe, expect, test } from "bun:test";
import {
  BRANCH_CUSTOM_VALUE,
  BRANCH_REMOVE_VALUE,
} from "../src/flows/constants";
import { flows } from "../src/flows/definition";
import type { BuildPreContext } from "../src/flows/types";
import { validateFlowDefinition } from "../src/flows/validate";

describe("flow definitions", () => {
  test("all flow definitions pass validation", () => {
    expect(() => validateFlowDefinition(flows.listInteractive)).not.toThrow();
    expect(() => validateFlowDefinition(flows.buildPost)).not.toThrow();
    expect(() => validateFlowDefinition(flows.buildPre)).not.toThrow();
    expect(() => validateFlowDefinition(flows.statusPost)).not.toThrow();
  });

  test("validator rejects transitions to unknown states", () => {
    expect(() =>
      validateFlowDefinition({
        id: "listInteractive",
        initialState: "start",
        states: {
          start: {
            transitions: {
              next: "missing_state",
            },
          },
        },
      }),
    ).toThrow();
  });

  test("interactive action menus expose rerun last build options", () => {
    const listActionMenu = flows.listInteractive.states.action_menu;
    const buildActionMenu = flows.buildPost.states.action_menu;
    const statusActionMenu = flows.statusPost.states.action_menu;

    expect(listActionMenu).toBeDefined();
    expect(buildActionMenu).toBeDefined();
    expect(statusActionMenu).toBeDefined();

    if (!listActionMenu || !buildActionMenu || !statusActionMenu) {
      throw new Error("Expected action menu states.");
    }

    const listOptions = listActionMenu.prompt;
    const buildOptions = buildActionMenu.prompt;
    const statusOptions = statusActionMenu.prompt;

    expect(listOptions).toBeDefined();
    expect(buildOptions).toBeDefined();
    expect(statusOptions).toBeDefined();

    if (
      !listOptions ||
      listOptions.kind !== "select" ||
      !buildOptions ||
      buildOptions.kind !== "select" ||
      !statusOptions ||
      statusOptions.kind !== "select"
    ) {
      throw new Error("Expected select prompts for action menus.");
    }

    expect(listOptions.options).toContainEqual({
      value: "rerun_last",
      label: "Rerun last build",
    });
    expect(buildOptions.options).toContainEqual({
      value: "rerun_last",
      label: "Rerun last build",
    });
    expect(statusOptions.options).toContainEqual({
      value: "rerun_last",
      label: "Rerun last build",
    });
  });

  test("list action menu keeps rerun last build next to build", () => {
    const listActionMenu = flows.listInteractive.states.action_menu;

    expect(listActionMenu).toBeDefined();

    if (!listActionMenu) {
      throw new Error("Expected action menu state.");
    }

    const listOptions = listActionMenu.prompt;

    if (!listOptions || listOptions.kind !== "select") {
      throw new Error("Expected select prompt for list action menu.");
    }

    const options =
      typeof listOptions.options === "function"
        ? listOptions.options({
            env: {} as never,
            jobs: [],
            preferredJobs: [],
            searchQuery: "",
            performAction: async () => "action_ok",
          })
        : listOptions.options;

    expect(options.map((option) => option.value)).toEqual([
      "build",
      "rerun_last",
      "rerun",
      "status",
      "watch",
      "logs",
      "history",
      "cancel",
      "search",
      "exit",
    ]);
  });

  test("post-action menus follow the shared action ordering", () => {
    const buildActionMenu = flows.buildPost.states.action_menu;
    const statusActionMenu = flows.statusPost.states.action_menu;

    expect(buildActionMenu).toBeDefined();
    expect(statusActionMenu).toBeDefined();

    if (!buildActionMenu || !statusActionMenu) {
      throw new Error("Expected post-action menu states.");
    }

    const buildOptions = buildActionMenu.prompt;
    const statusOptions = statusActionMenu.prompt;

    if (
      !buildOptions ||
      buildOptions.kind !== "select" ||
      !statusOptions ||
      statusOptions.kind !== "select"
    ) {
      throw new Error("Expected select prompts for post-action menus.");
    }

    const buildMenuOptions =
      typeof buildOptions.options === "function"
        ? buildOptions.options({
            env: {} as never,
            jobLabel: "job",
            returnToCaller: false,
            performAction: async () => "action_ok",
          })
        : buildOptions.options;
    const statusMenuOptions =
      typeof statusOptions.options === "function"
        ? statusOptions.options({
            env: {} as never,
            targetLabel: "job",
            performAction: async () => "action_ok",
          })
        : statusOptions.options;

    expect(buildMenuOptions.map((option) => option.value)).toEqual([
      "rerun_last",
      "rerun",
      "watch",
      "logs",
      "history",
      "cancel",
      "done",
    ]);

    expect(statusMenuOptions.map((option) => option.value)).toEqual([
      "build",
      "rerun_last",
      "rerun",
      "watch",
      "logs",
      "history",
      "cancel",
      "done",
    ]);
  });

  test("branch selection keeps destructive actions at the bottom", () => {
    const branchSelect = flows.buildPre.states.branch_select;

    expect(branchSelect).toBeDefined();

    if (!branchSelect) {
      throw new Error("Expected branch selection state.");
    }

    const prompt = branchSelect.prompt;

    if (
      !prompt ||
      prompt.kind !== "select" ||
      typeof prompt.options !== "function"
    ) {
      throw new Error("Expected select prompt with dynamic options.");
    }

    const options = prompt.options({
      jobs: [],
      recentJobs: [],
      jobSelectionLocked: false,
      searchQuery: "",
      selectedJobUrl: undefined,
      selectedJobLabel: undefined,
      branchParam: "BRANCH",
      branch: undefined,
      customParams: {},
      defaultBranch: false,
      parameterMode: undefined,
      buildModePrompted: false,
      branchChoices: ["feature/payments", "development", "master"],
      removableBranches: ["feature/payments"],
      env: {} as never,
      pendingBranchRemoval: undefined,
      pendingCustomParamKey: undefined,
      lastAddedCustomParamKey: undefined,
    } satisfies BuildPreContext);

    expect(options.map((option) => option.value)).toEqual([
      "feature/payments",
      "development",
      "master",
      BRANCH_CUSTOM_VALUE,
      BRANCH_REMOVE_VALUE,
    ]);
  });
});
