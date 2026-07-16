import { AutocompletePrompt, settings } from "@clack/core";
import {
  limitOptions,
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  symbol,
} from "@clack/prompts";
import { styleText } from "node:util";
import type {
  PromptAdapter,
  PromptFilterOption,
  PromptOption,
} from "../flows/types";
import { formatFocusedOption } from "./focused-option";

type AutocompleteMultiselect = NonNullable<
  PromptAdapter["autocompleteMultiselect"]
>;
type AutocompleteMultiselectOptions = Parameters<AutocompleteMultiselect>[0];

export function formatAutocompleteMultiselectOption(options: {
  option: PromptOption;
  active: boolean;
  selectedValues: string[];
  focusedValue: string | undefined;
}): string {
  const { option, active, selectedValues, focusedValue } = options;
  const selected = selectedValues.includes(option.value);
  const checkbox = selected
    ? styleText("green", S_CHECKBOX_SELECTED)
    : styleText("dim", S_CHECKBOX_INACTIVE);
  const hint =
    option.hint && focusedValue === option.value
      ? styleText("dim", ` (${option.hint})`)
      : "";

  if (option.disabled) {
    return `${styleText("gray", S_CHECKBOX_INACTIVE)} ${styleText(
      ["strikethrough", "gray"],
      option.label,
    )}`;
  }

  const content = `${checkbox} ${option.label}${hint}`;
  if (active) {
    return formatFocusedOption(content, true);
  }
  return `${checkbox} ${styleText("dim", option.label)}`;
}

export const autocompleteMultiselect: AutocompleteMultiselect = async (
  options: AutocompleteMultiselectOptions,
) => {
  const dynamicOptions = Array.isArray(options.options)
    ? undefined
    : options.options;
  const staticOptions = Array.isArray(options.options)
    ? options.options
    : undefined;
  let prompt!: AutocompletePrompt<PromptOption>;
  prompt = new AutocompletePrompt<PromptOption>({
    options: dynamicOptions
      ? function (this: AutocompletePrompt<PromptOption>): PromptOption[] {
          return dynamicOptions.call({ userInput: this.userInput });
        }
      : (staticOptions ?? []),
    multiple: true,
    placeholder: options.placeholder,
    filter: options.filter
      ? (search, option) =>
          options.filter?.(search, option as PromptFilterOption) ?? true
      : undefined,
    validate: (): string | Error | undefined => {
      if (options.required && prompt.selectedValues.length === 0) {
        return "Please select at least one item";
      }
      return options.validate?.(prompt.selectedValues);
    },
    render() {
      const hasGuide = settings.withGuide;
      const title = `${hasGuide ? `${styleText("gray", S_BAR)}\n` : ""}${symbol(
        this.state,
      )}  ${options.message}\n`;
      const userInput = this.userInput;
      const showPlaceholder =
        userInput === "" && options.placeholder !== undefined;
      const searchText =
        this.isNavigating || showPlaceholder
          ? styleText(
              "dim",
              showPlaceholder ? (options.placeholder ?? "") : userInput,
            )
          : this.userInputWithCursor;
      const allOptions = this.options;
      const matches =
        this.filteredOptions.length !== allOptions.length
          ? styleText(
              "dim",
              ` (${this.filteredOptions.length} match${
                this.filteredOptions.length === 1 ? "" : "es"
              })`,
            )
          : "";

      if (this.state === "submit") {
        return `${title}${hasGuide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(
          "dim",
          `${this.selectedValues.length} items selected`,
        )}`;
      }
      if (this.state === "cancel") {
        return `${title}${hasGuide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(
          ["strikethrough", "dim"],
          userInput,
        )}`;
      }

      const barStyle = this.state === "error" ? "yellow" : "cyan";
      const guidePrefix = hasGuide ? `${styleText(barStyle, S_BAR)}  ` : "";
      const guideEnd = hasGuide ? styleText(barStyle, S_BAR_END) : "";
      const noResults =
        this.filteredOptions.length === 0 && userInput
          ? [`${guidePrefix}${styleText("yellow", "No matches found")}`]
          : [];
      const errors =
        this.state === "error"
          ? [`${guidePrefix}${styleText("yellow", this.error)}`]
          : [];
      const header = [
        ...`${title}${hasGuide ? styleText(barStyle, S_BAR) : ""}`.split("\n"),
        `${guidePrefix}${styleText("dim", "Search:")} ${searchText}${matches}`,
        ...noResults,
        ...errors,
      ];
      const instructions = [
        `${styleText("dim", "↑/↓")} to navigate`,
        `${styleText("dim", this.isNavigating ? "Space/Tab:" : "Tab:")} select`,
        `${styleText("dim", "Enter:")} confirm`,
        `${styleText("dim", "Type:")} to search`,
      ];
      const footer = [`${guidePrefix}${instructions.join(" • ")}`, guideEnd];
      const displayedOptions = limitOptions({
        cursor: this.cursor,
        options: this.filteredOptions,
        style: (option, active) =>
          formatAutocompleteMultiselectOption({
            option,
            active,
            selectedValues: this.selectedValues,
            focusedValue: this.focusedValue,
          }),
        maxItems: options.maxItems,
        output: process.stdout,
        rowPadding: header.length + footer.length,
      });

      return [
        ...header,
        ...displayedOptions.map((option) => `${guidePrefix}${option}`),
        ...footer,
      ].join("\n");
    },
  });

  return (await prompt.prompt()) as string[] | symbol;
};
