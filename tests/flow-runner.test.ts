import { describe, expect, test } from "bun:test";
import { flows } from "../src/flows/definition";
import {
  buildFlowHandlers,
  buildPreFlowHandlers,
  listFlowHandlers,
} from "../src/flows/handlers";
import { SEARCH_ALL_JOBS_VALUE } from "../src/flows/constants";
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
    const context: ListInteractiveContext = {
      env: TEST_ENV,
      jobs: [{ name: "api", url: "https://jenkins.example.com/job/api/" }],
      searchQuery: "",
      performAction: async () => "watch_cancelled",
    };

    const result = await runFlow({
      definition: flows.listInteractive,
      handlers: listFlowHandlers,
      prompts: createPromptAdapter([
        "https://jenkins.example.com/job/api/",
        "watch",
        CANCEL,
      ]),
      context,
    });

    expect(result.terminal).toBe("exit_command");
  });

  test("action error returns to job search", async () => {
    const context: ListInteractiveContext = {
      env: TEST_ENV,
      jobs: [{ name: "api", url: "https://jenkins.example.com/job/api/" }],
      searchQuery: "",
      performAction: async () => "action_error",
    };

    const result = await runFlow({
      definition: flows.listInteractive,
      handlers: listFlowHandlers,
      prompts: createPromptAdapter([
        "https://jenkins.example.com/job/api/",
        "logs",
        CANCEL,
      ]),
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

  test("build pre flow esc in search from recent returns to recent menu", async () => {
    const context: BuildPreContext = {
      env: TEST_ENV,
      jobs: [{ name: "api", url: "https://jenkins.example.com/job/api/" }],
      recentJobs: [
        { url: "https://jenkins.example.com/job/api/", label: "api" },
      ],
      jobSelectionLocked: false,
      searchQuery: "",
      branchParam: "BRANCH",
      customParams: {},
      defaultBranch: false,
      branchChoices: [],
      removableBranches: [],
    };

    const result = await runFlow({
      definition: flows.buildPre,
      handlers: buildPreFlowHandlers,
      prompts: createPromptAdapter([SEARCH_ALL_JOBS_VALUE, CANCEL, CANCEL]),
      context,
    });

    expect(result.terminal).toBe("exit_command");
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
