import { describe, expect, mock, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import { promptForDiscoveredParameters } from "../src/interactive-job-parameters";
import type { JobParameterDefinition } from "../src/types/jenkins";

const env = { jenkinsUrl: "https://jenkins.example.com" } as EnvConfig;
const CANCEL = Symbol("cancel");

const definitions: JobParameterDefinition[] = [
  {
    name: "BRANCH",
    type: "string",
    description: "Git branch",
    defaultValue: "develop",
    sensitive: false,
  },
  {
    name: "TAG",
    type: "string",
    description: "Image tag",
    defaultValue: "latest",
    sensitive: false,
  },
  {
    name: "DRY_RUN",
    type: "boolean",
    defaultValue: false,
    sensitive: false,
  },
  {
    name: "ENV",
    type: "choice",
    choices: ["dev", "prod"],
    defaultValue: "dev",
    sensitive: false,
  },
  { name: "TOKEN", type: "password", sensitive: true },
  { name: "PLUGIN_VALUE", type: "unknown", sensitive: false },
];

describe("interactive discovered parameter prompts", () => {
  test("uses type-specific controls, keeps explicit branch, and redacts secrets", async () => {
    const text = mock(async (options: { message: string }) =>
      options.message.includes("TAG") ? "v2" : "generic",
    );
    const password = mock(async () => "top-secret-value");
    const confirm = mock(async (options: { message: string }) =>
      options.message.includes("DRY_RUN") ? true : true,
    );
    const select = mock(async () => "prod");
    const selectBranch = mock(async () => "should-not-run");
    const lines: string[] = [];

    const result = await promptForDiscoveredParameters({
      definitions,
      env,
      branchParam: "BRANCH",
      branch: "main",
      deps: {
        text,
        password,
        confirm,
        select,
        isCancel: (value) => value === CANCEL,
        writeLine: (line) => lines.push(line),
      },
      selectBranch,
    });

    expect(result).toEqual({
      cancelled: false,
      branch: "main",
      customParams: {
        TAG: "v2",
        DRY_RUN: "true",
        ENV: "prod",
        TOKEN: "top-secret-value",
        PLUGIN_VALUE: "generic",
      },
      sensitiveNames: new Set(["TOKEN"]),
    });
    expect(selectBranch).not.toHaveBeenCalled();
    expect(text).toHaveBeenCalledTimes(2);
    expect(password).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    const textCalls = text.mock.calls as unknown as Array<
      [{ message: string }]
    >;
    expect(textCalls[0]?.[0].message).toContain("Image tag");
    expect(lines.join("\n")).toContain("TOKEN: <redacted>");
    expect(lines.join("\n")).not.toContain("top-secret-value");
  });

  test("uses branch selection once and does not prompt the branch as text", async () => {
    const selectBranch = mock(async () => "release/42");
    const text = mock(async () => "value");
    const result = await promptForDiscoveredParameters({
      definitions: [definitions[0] as JobParameterDefinition],
      env,
      branchParam: "BRANCH",
      deps: {
        text,
        password: mock(async () => ""),
        confirm: mock(async () => true),
        select: mock(async () => ""),
        isCancel: (value) => value === CANCEL,
        writeLine: () => undefined,
      },
      selectBranch,
    });

    expect(result).toEqual({
      cancelled: false,
      branch: "release/42",
      customParams: {},
      sensitiveNames: new Set(),
    });
    expect(selectBranch).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });

  test("cancellation stops before the final confirmation", async () => {
    const confirm = mock(async () => true);
    const result = await promptForDiscoveredParameters({
      definitions: [{ name: "TOKEN", type: "password", sensitive: true }],
      env,
      branchParam: "BRANCH",
      deps: {
        text: mock(async () => ""),
        password: mock(async () => CANCEL),
        confirm,
        select: mock(async () => ""),
        isCancel: (value) => value === CANCEL,
        writeLine: () => undefined,
      },
      selectBranch: mock(async () => "main"),
    });

    expect(result).toEqual({ cancelled: true });
    expect(confirm).not.toHaveBeenCalled();
  });
});
