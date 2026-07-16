import { MultiSelectPrompt, settings, wrapTextWithPrefix } from "@clack/core";
import {
  formatInstructionFooter,
  limitOptions,
  MULTISELECT_INSTRUCTIONS,
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  symbol,
  symbolBar,
} from "@clack/prompts";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { formatFocusedOption } from "./focused-option";

type Primitive = string | boolean | number;

export type MultiselectOption<Value extends Primitive> = {
  value: Value;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

export type MultiselectOptions<Value extends Primitive> = {
  message: string;
  options: MultiselectOption<Value>[];
  initialValues?: Value[];
  maxItems?: number;
  required?: boolean;
  cursorAt?: Value;
  showInstructions?: boolean;
  withGuide?: boolean;
  signal?: AbortSignal;
  input?: Readable;
  output?: Writable;
};

type MultiselectOptionState =
  | "active"
  | "active-selected"
  | "inactive"
  | "selected"
  | "disabled"
  | "submitted"
  | "cancelled";

function mapLines(value: string, format: (line: string) => string): string {
  return value
    .split("\n")
    .map((line) => format(line))
    .join("\n");
}

export function formatMultiselectOption<Value extends Primitive>(options: {
  option: MultiselectOption<Value>;
  state: MultiselectOptionState;
}): string {
  const { option, state } = options;
  const label = option.label ?? String(option.value);
  const hint = option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : "";

  if (state === "disabled") {
    return `${styleText("gray", S_CHECKBOX_INACTIVE)} ${mapLines(
      label,
      (line) => styleText(["strikethrough", "gray"], line),
    )}${hint}`;
  }
  if (state === "submitted") {
    return mapLines(label, (line) => styleText("dim", line));
  }
  if (state === "cancelled") {
    return mapLines(label, (line) => styleText(["strikethrough", "dim"], line));
  }

  const selected = state === "selected" || state === "active-selected";
  const active = state === "active" || state === "active-selected";
  const checkbox = selected
    ? styleText("green", S_CHECKBOX_SELECTED)
    : active
      ? styleText("cyan", S_CHECKBOX_ACTIVE)
      : styleText("dim", S_CHECKBOX_INACTIVE);
  const renderedLabel = active
    ? label
    : mapLines(label, (line) => styleText("dim", line));
  return formatFocusedOption(`${checkbox} ${renderedLabel}${hint}`, active);
}

export async function multiselect<Value extends Primitive>(
  options: MultiselectOptions<Value>,
): Promise<Value[] | symbol> {
  const required = options.required ?? true;
  const showInstructions = options.showInstructions ?? true;
  const prompt = new MultiSelectPrompt<MultiselectOption<Value>>({
    options: options.options,
    signal: options.signal,
    input: options.input,
    output: options.output,
    initialValues: options.initialValues,
    required,
    cursorAt: options.cursorAt,
    validate(value): string | undefined {
      if (required && (!value || value.length === 0)) {
        return "Please select at least one option.";
      }
      return undefined;
    },
    render() {
      const hasGuide = options.withGuide ?? settings.withGuide;
      const message = wrapTextWithPrefix(
        options.output,
        options.message,
        hasGuide ? `${symbolBar(this.state)}  ` : "",
        `${symbol(this.state)}  `,
      );
      const title = `${hasGuide ? `${styleText("gray", S_BAR)}\n` : ""}${message}\n`;
      const selectedValues = this.value ?? [];
      const formatOption = (
        option: MultiselectOption<Value>,
        active: boolean,
      ): string => {
        if (option.disabled) {
          return formatMultiselectOption({ option, state: "disabled" });
        }
        const selected = selectedValues.includes(option.value);
        return formatMultiselectOption({
          option,
          state: active
            ? selected
              ? "active-selected"
              : "active"
            : selected
              ? "selected"
              : "inactive",
        });
      };

      if (this.state === "submit") {
        const submitted =
          this.options
            .filter((option) => selectedValues.includes(option.value))
            .map((option) =>
              formatMultiselectOption({ option, state: "submitted" }),
            )
            .join(styleText("dim", ", ")) || styleText("dim", "none");
        return `${title}${wrapTextWithPrefix(
          options.output,
          submitted,
          hasGuide ? `${styleText("gray", S_BAR)}  ` : "",
        )}`;
      }

      if (this.state === "cancel") {
        const cancelled = this.options
          .filter((option) => selectedValues.includes(option.value))
          .map((option) =>
            formatMultiselectOption({ option, state: "cancelled" }),
          )
          .join(styleText("dim", ", "));
        if (!cancelled.trim()) {
          return `${title}${hasGuide ? styleText("gray", S_BAR) : ""}`;
        }
        return `${title}${wrapTextWithPrefix(
          options.output,
          cancelled,
          hasGuide ? `${styleText("gray", S_BAR)}  ` : "",
        )}${hasGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
      }

      const errorState = this.state === "error";
      const barStyle = errorState ? "yellow" : "cyan";
      const prefix = hasGuide ? `${styleText(barStyle, S_BAR)}  ` : "";
      const titleRows = title.split("\n").length;
      const footer = errorState
        ? [
            ...(hasGuide ? [styleText("yellow", S_BAR_END)] : []),
            ...this.error.split("\n").map((line) => styleText("yellow", line)),
          ]
        : showInstructions
          ? formatInstructionFooter(MULTISELECT_INSTRUCTIONS, hasGuide)
          : hasGuide
            ? [styleText("cyan", S_BAR_END)]
            : [];
      const renderedOptions = limitOptions({
        output: options.output,
        options: this.options,
        cursor: this.cursor,
        maxItems: options.maxItems,
        columnPadding: prefix.length,
        rowPadding: titleRows + footer.length + 1,
        style: formatOption,
      });

      return `${title}${prefix}${renderedOptions.join(`\n${prefix}`)}\n${footer.join(
        "\n",
      )}\n`;
    },
  });

  return (await prompt.prompt()) as Value[] | symbol;
}
