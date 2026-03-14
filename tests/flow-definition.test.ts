import { describe, expect, test } from "bun:test";
import { flows } from "../src/flows/definition";
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

    expect(listOptions.options.map((option) => option.value)).toEqual([
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

    expect(buildOptions.options.map((option) => option.value)).toEqual([
      "rerun",
      "rerun_last",
      "watch",
      "logs",
      "history",
      "cancel",
      "done",
    ]);

    expect(statusOptions.options.map((option) => option.value)).toEqual([
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
});
