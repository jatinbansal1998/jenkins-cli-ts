import { describe, expect, test } from "bun:test";
import { isCancel, S_RADIO_ACTIVE, S_RADIO_INACTIVE } from "@clack/prompts";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import {
  branchPicker,
  formatBranchInputRow,
  formatBranchPickerOption,
} from "../src/prompts/branch-picker";

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_LEFT = "\u001b[D";
const KEY_BACKSPACE = "\u007f";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\u001b";

const BRANCH_OPTIONS = [
  { value: "development", label: "development" },
  { value: "master", label: "master" },
  { value: "__remove__", label: "Remove cached branch" },
];

function startPicker(
  overrides: Partial<Parameters<typeof branchPicker>[0]> = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: string[] = [];
  output.on("data", (chunk: Buffer) => {
    frames.push(chunk.toString());
  });
  const result = branchPicker({
    message: "Branch name",
    options: BRANCH_OPTIONS,
    placeholder: "e.g. main",
    input,
    output,
    ...overrides,
  });
  return { input, frames, result };
}

async function press(input: PassThrough, data: string): Promise<void> {
  input.write(data);
  // Let readline process the keypress before the next write.
  await new Promise((resolve) => setImmediate(resolve));
}

async function pressEscape(input: PassThrough): Promise<void> {
  input.write(KEY_ESCAPE);
  // A bare ESC byte only resolves after readline's escapeCodeTimeout (50ms).
  await new Promise((resolve) => setTimeout(resolve, 120));
}

describe("branch picker interaction", () => {
  test("Enter with blank input selects the highlighted option", async () => {
    const { input, result } = startPicker();
    await press(input, KEY_ENTER);
    expect(await result).toBe("development");
  });

  test("cursor movement selects other options and wraps", async () => {
    const { input, result } = startPicker();
    await press(input, KEY_DOWN);
    await press(input, KEY_ENTER);
    expect(await result).toBe("master");

    const second = startPicker();
    await press(second.input, KEY_UP);
    await press(second.input, KEY_ENTER);
    expect(await second.result).toBe("__remove__");
  });

  test("typed input returns the custom branch over the highlighted option", async () => {
    const { input, result } = startPicker();
    await press(input, KEY_DOWN);
    await press(input, "feature/checkout");
    await press(input, KEY_ENTER);
    expect(await result).toBe("feature/checkout");
  });

  test("whitespace-only input does not override the highlighted option", async () => {
    const { input, result } = startPicker();
    await press(input, "   ");
    await press(input, KEY_ENTER);
    expect(await result).toBe("development");
  });

  test("clearing typed input restores highlighted-option selection", async () => {
    const { input, result } = startPicker();
    await press(input, "x");
    await press(input, KEY_BACKSPACE);
    await press(input, KEY_ENTER);
    expect(await result).toBe("development");
  });

  test("initial input, cursor movement, and editing behave correctly", async () => {
    const { input, result } = startPicker({ initialUserInput: "abc" });
    await press(input, KEY_LEFT);
    await press(input, KEY_BACKSPACE);
    await press(input, KEY_ENTER);
    expect(await result).toBe("ac");
  });

  test("disabled options are skipped and cannot be selected", async () => {
    const { input, result } = startPicker({
      options: [
        { value: "development", label: "development", disabled: true },
        { value: "master", label: "master" },
      ],
    });
    await press(input, KEY_ENTER);
    expect(await result).toBe("master");

    const wrapped = startPicker({
      options: [
        { value: "development", label: "development", disabled: true },
        { value: "master", label: "master" },
      ],
    });
    await press(wrapped.input, KEY_DOWN);
    await press(wrapped.input, KEY_ENTER);
    expect(await wrapped.result).toBe("master");
  });

  test("empty option list requires typed input before submitting", async () => {
    const { input, frames, result } = startPicker({ options: [] });
    await press(input, KEY_ENTER);
    const rendered = stripVTControlCharacters(frames.join(""));
    expect(rendered).toContain(
      "Branch is required to trigger a parameterized build.",
    );
    await press(input, "hotfix/build");
    await press(input, KEY_ENTER);
    expect(await result).toBe("hotfix/build");
  });

  test("long option lists render within maxItems and stay selectable", async () => {
    const manyOptions = Array.from({ length: 40 }, (_, index) => ({
      value: `branch-${index}`,
      label: `branch-${index}`,
    }));
    const { input, result } = startPicker({
      options: manyOptions,
      maxItems: 5,
    });
    await press(input, KEY_DOWN);
    await press(input, KEY_DOWN);
    await press(input, KEY_ENTER);
    expect(await result).toBe("branch-2");
  });

  test("Escape cancels with the prompt library cancel token", async () => {
    const { input, result } = startPicker();
    await pressEscape(input);
    expect(isCancel(await result)).toBe(true);
  });
});

describe("branch picker rendering", () => {
  const option = { value: "development", label: "development" };

  test("focused option keeps a plain label with an active radio", () => {
    const rendered = formatBranchPickerOption({
      option,
      active: true,
      typing: false,
    });

    // Focus is marked by the radio symbol alone — no italic/underline
    // treatment, which is reserved for the multi-select prompts.
    expect(rendered).toContain("\u001b[32m");
    expect(rendered).not.toContain("\u001b[3m");
    expect(rendered).not.toContain("\u001b[4m");
    expect(stripVTControlCharacters(rendered)).toBe(
      `${S_RADIO_ACTIVE} development`,
    );
  });

  test("typing dims the highlighted option", () => {
    const rendered = formatBranchPickerOption({
      option,
      active: true,
      typing: true,
    });

    expect(rendered).toContain("\u001b[2m");
    expect(rendered).not.toContain("\u001b[3m");
    expect(rendered).not.toContain("\u001b[4m");
  });

  test("disabled options render struck through and unfocused", () => {
    const rendered = formatBranchPickerOption({
      option: { ...option, disabled: true },
      active: true,
      typing: false,
    });

    expect(rendered).toContain("\u001b[9m");
    expect(rendered).not.toContain("\u001b[3m");
    expect(rendered).not.toContain("\u001b[4m");
  });

  test("input row takes focus while typing and shows the typed text", () => {
    const active = formatBranchInputRow({
      userInput: "feature/x",
      cursor: 9,
      active: true,
    });
    const inactive = formatBranchInputRow({
      userInput: "",
      cursor: 0,
      active: false,
      placeholder: "e.g. main",
    });

    expect(active).toContain("\u001b[32m");
    expect(active).not.toContain("\u001b[3m");
    expect(active).not.toContain("\u001b[4m");
    expect(stripVTControlCharacters(active)).toContain(
      `${S_RADIO_ACTIVE} Custom branch: feature/x`,
    );
    expect(inactive).not.toContain("\u001b[32m");
    expect(stripVTControlCharacters(inactive)).toContain(
      `${S_RADIO_INACTIVE} Custom branch: e.g. main`,
    );
  });
});
