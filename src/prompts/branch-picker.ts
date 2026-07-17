import { Prompt, settings } from "@clack/core";
import {
  limitOptions,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  symbol,
} from "@clack/prompts";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import type { PromptOption } from "../flows/types";

export type BranchPickerOptions = {
  message: string;
  /** Cached branches first, utility rows (e.g. remove) last. */
  options: PromptOption[];
  placeholder?: string;
  initialUserInput?: string;
  maxItems?: number;
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
};

export function formatBranchPickerOption(options: {
  option: PromptOption;
  active: boolean;
  /** Nonblank typed input visually moves focus to the input row. */
  typing: boolean;
}): string {
  const { option, active, typing } = options;
  const hint = option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : "";

  if (option.disabled) {
    return `${styleText("gray", S_RADIO_INACTIVE)} ${styleText(
      ["strikethrough", "gray"],
      option.label,
    )}${hint}`;
  }
  if (active && !typing) {
    return `${styleText("green", S_RADIO_ACTIVE)} ${option.label}${hint}`;
  }
  return `${styleText("dim", S_RADIO_INACTIVE)} ${styleText(
    "dim",
    option.label,
  )}${hint}`;
}

export function formatBranchInputRow(options: {
  userInput: string;
  cursor: number;
  active: boolean;
  placeholder?: string;
}): string {
  const { userInput, cursor, active, placeholder } = options;
  const radio = active
    ? styleText("green", S_RADIO_ACTIVE)
    : styleText("dim", S_RADIO_INACTIVE);
  const label = styleText("dim", "Custom branch:");
  const text = formatInputText(userInput, cursor, placeholder);
  return `${radio} ${label} ${text}`;
}

function formatInputText(
  userInput: string,
  cursor: number,
  placeholder?: string,
): string {
  if (!userInput) {
    if (placeholder) {
      return `${styleText("inverse", placeholder.charAt(0))}${styleText(
        "dim",
        placeholder.slice(1),
      )}`;
    }
    return styleText("inverse", " ");
  }
  if (cursor >= userInput.length) {
    return `${userInput}${styleText("inverse", " ")}`;
  }
  return `${userInput.slice(0, cursor)}${styleText(
    "inverse",
    userInput.charAt(cursor),
  )}${userInput.slice(cursor + 1)}`;
}

function nextEnabledIndex(
  options: PromptOption[],
  cursor: number,
  direction: -1 | 1,
): number {
  if (options.length === 0) {
    return 0;
  }
  let index = cursor;
  for (let step = 0; step < options.length; step += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabled) {
      return index;
    }
  }
  return cursor;
}

class BranchPickerPrompt extends Prompt<string> {
  private readonly pickerOptions: PromptOption[];
  private readonly message: string;
  private readonly placeholder?: string;
  private readonly maxItems?: number;
  private cursorIndex: number;

  constructor(options: BranchPickerOptions) {
    super(
      {
        initialUserInput: options.initialUserInput,
        input: options.input,
        output: options.output,
        signal: options.signal,
        validate: (value: string | undefined): string | undefined => {
          if (!value?.trim()) {
            return "Branch is required to trigger a parameterized build.";
          }
          return undefined;
        },
        render: function (this: BranchPickerPrompt) {
          return this.renderFrame();
        },
      },
      true,
    );

    this.pickerOptions = options.options;
    this.message = options.message;
    this.placeholder = options.placeholder;
    this.maxItems = options.maxItems;
    this.cursorIndex = Math.max(
      this.pickerOptions.findIndex((option) => !option.disabled),
      0,
    );
    this.syncValue();

    this.on("cursor", (action) => {
      if (action === "up") {
        this.cursorIndex = nextEnabledIndex(
          this.pickerOptions,
          this.cursorIndex,
          -1,
        );
      }
      if (action === "down") {
        this.cursorIndex = nextEnabledIndex(
          this.pickerOptions,
          this.cursorIndex,
          1,
        );
      }
      this.syncValue();
    });
    this.on("userInput", () => {
      this.syncValue();
    });
  }

  /**
   * Keeps `value` resolved on every keystroke because `@clack/core` runs
   * `validate` against `value` before `finalize` fires. Nonblank typed input
   * always wins over the highlighted option.
   */
  private syncValue(): void {
    const typed = this.userInput.trim();
    if (typed) {
      this._setValue(typed);
      return;
    }
    const option = this.pickerOptions[this.cursorIndex];
    this._setValue(option && !option.disabled ? option.value : "");
  }

  private renderFrame(): string {
    const hasGuide = settings.withGuide;
    const title = `${hasGuide ? `${styleText("gray", S_BAR)}\n` : ""}${symbol(
      this.state,
    )}  ${this.message}\n`;
    const typing = this.userInput.trim().length > 0;

    if (this.state === "submit") {
      return `${title}${hasGuide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(
        "dim",
        this.value ?? "",
      )}`;
    }
    if (this.state === "cancel") {
      const cancelled = typing
        ? this.userInput.trim()
        : (this.pickerOptions[this.cursorIndex]?.label ?? "");
      return `${title}${hasGuide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(
        ["strikethrough", "dim"],
        cancelled,
      )}${hasGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
    }

    const errorState = this.state === "error";
    const barStyle = errorState ? "yellow" : "cyan";
    const prefix = hasGuide ? `${styleText(barStyle, S_BAR)}  ` : "";
    const instructions = [
      `${styleText("dim", "↑/↓")} branches`,
      `${styleText("dim", "Type:")} custom branch`,
      `${styleText("dim", "Enter:")} confirm`,
    ];
    const footer = errorState
      ? [
          ...(hasGuide ? [styleText("yellow", S_BAR_END)] : []),
          ...this.error.split("\n").map((line) => styleText("yellow", line)),
        ]
      : [
          `${prefix}${instructions.join(styleText("dim", " • "))}`,
          ...(hasGuide ? [styleText("cyan", S_BAR_END)] : []),
        ];
    const inputRow = `${prefix}${formatBranchInputRow({
      userInput: this.userInput,
      cursor: this._cursor,
      active: typing || this.pickerOptions.length === 0,
      placeholder: this.placeholder,
    })}`;
    const titleRows = title.split("\n").length;
    const optionRows = limitOptions({
      output: this.output,
      cursor: this.cursorIndex,
      options: this.pickerOptions,
      maxItems: this.maxItems,
      columnPadding: prefix.length,
      rowPadding: titleRows + footer.length + 2,
      style: (option, active) =>
        formatBranchPickerOption({ option, active, typing }),
    }).map((line) => `${prefix}${line}`);

    return [title.trimEnd(), ...optionRows, inputRow, ...footer].join("\n");
  }
}

export async function branchPicker(
  options: BranchPickerOptions,
): Promise<string | symbol> {
  const result = await new BranchPickerPrompt(options).prompt();
  return typeof result === "symbol" ? result : String(result ?? "");
}
