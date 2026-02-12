import { describe, expect, test } from "bun:test";
import { flows } from "../src/flows/definition";
import {
  buildFlowHandlers,
  buildPreFlowHandlers,
  listFlowHandlers,
} from "../src/flows/handlers";
import { SEARCH_ALL_JOBS_VALUE } from "../src/flows/constants";
import { runFlow } from "../src/flows/runner";
import type {
  BuildPreContext,
  BuildPostContext,
  ListInteractiveContext,
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

function createPromptAdapter(responses: unknown[]) {
  let cursor = 0;
  return {
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

  test("watch cancellation routes to root", async () => {
    const context: ListInteractiveContext = {
      env: TEST_ENV,
      jobs: [{ name: "api", url: "https://jenkins.example.com/job/api/" }],
      performAction: async () => "watch_cancelled",
    };

    const result = await runFlow({
      definition: flows.listInteractive,
      handlers: listFlowHandlers,
      prompts: createPromptAdapter([
        "https://jenkins.example.com/job/api/",
        "watch",
      ]),
      context,
    });

    expect(result.terminal).toBe("root");
  });

  test("action error routes to root", async () => {
    const context: ListInteractiveContext = {
      env: TEST_ENV,
      jobs: [{ name: "api", url: "https://jenkins.example.com/job/api/" }],
      performAction: async () => "action_error",
    };

    const result = await runFlow({
      definition: flows.listInteractive,
      handlers: listFlowHandlers,
      prompts: createPromptAdapter([
        "https://jenkins.example.com/job/api/",
        "logs",
      ]),
      context,
    });

    expect(result.terminal).toBe("root");
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
      searchQuery: "",
      searchCandidates: [],
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
});
