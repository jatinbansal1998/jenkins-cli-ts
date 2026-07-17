import { describe, expect, test } from "bun:test";
import { flows } from "../src/flows/definition";
import {
  buildFlowHandlers,
  buildPreFlowHandlers,
  listFlowHandlers,
} from "../src/flows/handlers";
import { resetValidatedFlowsForTesting, runFlow } from "../src/flows/runner";
import type {
  AutocompletePromptValue,
  AutocompletePromptResult,
  BuildPreContext,
  BuildPostContext,
  FlowPromptValue,
  ListInteractiveContext,
  PromptAdapter,
} from "../src/flows/types";
import type { EnvConfig } from "../src/env";

const CANCEL = Symbol("cancel");
const TEST_ENV: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "test-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

function createPromptAdapter(
  responses: Array<AutocompletePromptResult | typeof CANCEL | unknown>,
) {
  let cursor = 0;
  return {
    autocomplete: async () => responses[cursor++] as AutocompletePromptResult,
    select: async () => responses[cursor++],
    confirm: async () => responses[cursor++],
    text: async () => responses[cursor++],
    isCancel: (value: unknown) => value === CANCEL,
  };
}

describe("flow runner", () => {
  test("root esc exits command", async () => {
    const context: BuildPostContext = {
      env: TEST_ENV,
      jobLabel: "api-staging",
      returnToCaller: false,
      performAction: async () => "action_ok",
    };

    const result = await runFlow({
      definition: flows.buildPost,
      handlers: buildFlowHandlers,
      prompts: createPromptAdapter([CANCEL]),
      context,
      startStateId: "repeat_confirm",
    });

    expect(result.terminal).toBe("exit_command");
  });

  test("menu esc goes back one level before root handling", async () => {
    const context: BuildPostContext = {
      env: TEST_ENV,
      jobLabel: "api-staging",
      returnToCaller: false,
      performAction: async () => "action_ok",
    };

    const result = await runFlow({
      definition: flows.buildPost,
      handlers: buildFlowHandlers,
      prompts: createPromptAdapter([CANCEL, false]),
      context,
    });

    expect(result.terminal).toBe("exit_command");
  });

  test("watch cancellation returns to job search", async () => {
    let pickCount = 0;
    const context: ListInteractiveContext = {
      env: TEST_ENV,
      jobs: [{ name: "api", url: "https://jenkins.example.com/job/api/" }],
      pickJob: async () =>
        pickCount++ === 0
          ? {
              kind: "selected",
              job: {
                name: "api",
                url: "https://jenkins.example.com/job/api/",
              },
            }
          : { kind: "cancelled", userInput: "" },
      performAction: async () => "watch_cancelled",
    };

    const result = await runFlow({
      definition: flows.listInteractive,
      handlers: listFlowHandlers,
      prompts: createPromptAdapter(["watch"]),
      context,
    });

    expect(result.terminal).toBe("exit_command");
  });

  test("action error returns to job search", async () => {
    let pickCount = 0;
    const context: ListInteractiveContext = {
      env: TEST_ENV,
      jobs: [{ name: "api", url: "https://jenkins.example.com/job/api/" }],
      pickJob: async () =>
        pickCount++ === 0
          ? {
              kind: "selected",
              job: {
                name: "api",
                url: "https://jenkins.example.com/job/api/",
              },
            }
          : { kind: "cancelled", userInput: "" },
      performAction: async () => "action_error",
    };

    const result = await runFlow({
      definition: flows.listInteractive,
      handlers: listFlowHandlers,
      prompts: createPromptAdapter(["logs"]),
      context,
    });

    expect(result.terminal).toBe("exit_command");
  });

  test("explicit done and confirm yes returns repeat", async () => {
    const context: BuildPostContext = {
      env: TEST_ENV,
      jobLabel: "api-staging",
      returnToCaller: false,
      performAction: async () => "action_ok",
    };

    const result = await runFlow({
      definition: flows.buildPost,
      handlers: buildFlowHandlers,
      prompts: createPromptAdapter(["done", true]),
      context,
    });

    expect(result.terminal).toBe("repeat");
  });

  test("build pre flow exits when the shared picker is cancelled", async () => {
    const context: BuildPreContext = {
      env: TEST_ENV,
      jobs: [{ name: "api", url: "https://jenkins.example.com/job/api/" }],
      jobSelectionLocked: false,
      pickJob: async () => ({ kind: "cancelled", userInput: "api" }),
      branchParam: "BRANCH",
      customParams: {},
      defaultBranch: false,
      branchChoices: [],
      removableBranches: [],
    };

    const result = await runFlow({
      definition: flows.buildPre,
      handlers: buildPreFlowHandlers,
      prompts: createPromptAdapter([]),
      context,
    });

    expect(result.terminal).toBe("exit_command");
  });

  test("branch picker prompts resolve select events from the adapter value", async () => {
    resetValidatedFlowsForTesting();
    const prompts: PromptAdapter = {
      autocomplete: async () => "",
      branchPicker: async (options) => {
        expect(options.message).toBe("Branch name");
        expect(options.options).toEqual([
          { value: "development", label: "development" },
        ]);
        expect(options.placeholder).toBe("e.g. main");
        return "feature/checkout";
      },
      select: async () => "",
      confirm: async () => false,
      text: async () => "",
      isCancel: () => false,
    };

    const result = await runFlow({
      definition: {
        id: "buildPre",
        initialState: "branch",
        states: {
          branch: {
            prompt: {
              kind: "branchPicker",
              message: "Branch name",
              options: [{ value: "development", label: "development" }],
              placeholder: "e.g. main",
            },
            transitions: {
              "select:feature/checkout": "complete",
            },
          },
        },
      },
      handlers: {},
      prompts,
      context: {},
    });

    expect(result.terminal).toBe("complete");
  });

  test("branch picker cancellation maps to the esc event", async () => {
    resetValidatedFlowsForTesting();
    const prompts: PromptAdapter = {
      autocomplete: async () => "",
      branchPicker: async () => CANCEL as unknown as symbol,
      select: async () => "",
      confirm: async () => false,
      text: async () => "",
      isCancel: (value: unknown) => value === CANCEL,
    };

    const result = await runFlow({
      definition: {
        id: "buildPre",
        initialState: "branch",
        states: {
          branch: {
            prompt: {
              kind: "branchPicker",
              message: "Branch name",
              options: [{ value: "development", label: "development" }],
            },
            transitions: {
              esc: "exit_command",
              "select:development": "complete",
            },
          },
        },
      },
      handlers: {},
      prompts,
      context: {},
    });

    expect(result.terminal).toBe("exit_command");
  });

  test("branch picker prompts fail fast without adapter support", async () => {
    resetValidatedFlowsForTesting();
    const prompts: PromptAdapter = {
      autocomplete: async () => "",
      select: async () => "",
      confirm: async () => false,
      text: async () => "",
      isCancel: () => false,
    };

    await expect(
      runFlow({
        definition: {
          id: "buildPre",
          initialState: "branch",
          states: {
            branch: {
              prompt: {
                kind: "branchPicker",
                message: "Branch name",
                options: [{ value: "development", label: "development" }],
              },
              transitions: {
                "select:development": "complete",
              },
            },
          },
        },
        handlers: {},
        prompts,
        context: {},
      }),
    ).rejects.toThrow(
      "Prompt adapter is missing branchPicker support for a branchPicker prompt.",
    );
  });

  test("dynamic autocomplete prompts bypass clack's default text filter", async () => {
    resetValidatedFlowsForTesting();
    const prompts: PromptAdapter = {
      autocomplete: async (options) => {
        const option = {
          value:
            "https://jenkins.example.com/job/crypto-order-matching-engine/",
          label: "crypto-order-matching-engine",
        };

        expect(options.filter?.("matching engine", option)).toBeTrue();
        const resolvedOptions =
          typeof options.options === "function"
            ? options.options.call({ userInput: "matching engine" })
            : options.options;

        expect(resolvedOptions).toContainEqual(option);
        return option.value;
      },
      select: async () => "",
      confirm: async () => false,
      text: async () => "",
      isCancel: () => false,
    };

    const result = await runFlow({
      definition: {
        id: "listInteractive",
        initialState: "search",
        states: {
          search: {
            prompt: {
              kind: "autocomplete",
              message: "Search",
              options: (_context, search) =>
                search === "matching engine"
                  ? [
                      {
                        value:
                          "https://jenkins.example.com/job/crypto-order-matching-engine/",
                        label: "crypto-order-matching-engine",
                      },
                    ]
                  : [],
            },
            transitions: {
              "select:https://jenkins.example.com/job/crypto-order-matching-engine/":
                "complete",
            },
          },
        },
      },
      handlers: {},
      prompts,
      context: {},
    });

    expect(result.terminal).toBe("complete");
  });

  test("static autocomplete prompts preserve the current user input", async () => {
    resetValidatedFlowsForTesting();
    type CaptureContext = { captured?: AutocompletePromptValue };
    const context: CaptureContext = {};
    const prompts: PromptAdapter = {
      autocomplete: async (options) => {
        const resolvedOptions =
          typeof options.options === "function"
            ? options.options.call({ userInput: "matching engine" })
            : options.options;

        expect(resolvedOptions).toContainEqual({
          value:
            "https://jenkins.example.com/job/crypto-order-matching-engine/",
          label: "crypto-order-matching-engine",
        });
        return "https://jenkins.example.com/job/crypto-order-matching-engine/";
      },
      select: async () => "",
      confirm: async () => false,
      text: async () => "",
      isCancel: () => false,
    };

    const result = await runFlow({
      definition: {
        id: "listInteractive",
        initialState: "search",
        states: {
          search: {
            prompt: {
              kind: "autocomplete",
              message: "Search",
              options: [
                {
                  value:
                    "https://jenkins.example.com/job/crypto-order-matching-engine/",
                  label: "crypto-order-matching-engine",
                },
              ],
            },
            onSelect: "capture",
            transitions: {
              "select:https://jenkins.example.com/job/crypto-order-matching-engine/":
                "complete",
            },
          },
        },
      },
      handlers: {
        capture: ({
          context,
          input,
        }: {
          context: CaptureContext;
          input?: FlowPromptValue;
        }) => {
          context.captured = input as AutocompletePromptValue;
          return `select:${context.captured.value}`;
        },
      },
      prompts,
      context,
    });

    expect(result.terminal).toBe("complete");
    expect(context.captured).toEqual({
      value: "https://jenkins.example.com/job/crypto-order-matching-engine/",
      userInput: "matching engine",
    });
  });
});
