import { describe, expect, test } from "bun:test";
import { S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED } from "@clack/prompts";
import { stripVTControlCharacters } from "node:util";
import { formatAutocompleteMultiselectOption } from "../src/prompts/autocomplete-multiselect";
import { formatFocusedOption } from "../src/prompts/focused-option";

const option = {
  value: "api",
  label: "api-deploy",
};

describe("custom autocomplete multi-select rendering", () => {
  test("italicizes and underlines the complete focused option", () => {
    const rendered = formatAutocompleteMultiselectOption({
      option,
      active: true,
      selectedValues: [],
      focusedValue: option.value,
    });

    expect(rendered).toContain("\u001b[3m");
    expect(rendered).toContain("\u001b[4m");
    expect(stripVTControlCharacters(rendered)).toBe(
      `${S_CHECKBOX_INACTIVE} api-deploy`,
    );
  });

  test("uses the shared focused-option formatter", () => {
    const rendered = formatAutocompleteMultiselectOption({
      option,
      active: true,
      selectedValues: [],
      focusedValue: option.value,
    });
    const expected = formatFocusedOption(
      `${S_CHECKBOX_INACTIVE} api-deploy`,
      true,
    );

    expect(stripVTControlCharacters(rendered)).toBe(
      stripVTControlCharacters(expected),
    );
  });

  test("keeps inactive options dim without focused styling", () => {
    const rendered = formatAutocompleteMultiselectOption({
      option,
      active: false,
      selectedValues: [],
      focusedValue: undefined,
    });

    expect(rendered).toContain("\u001b[2m");
    expect(rendered).not.toContain("\u001b[3m");
    expect(rendered).not.toContain("\u001b[4m");
  });

  test("preserves selected and disabled checkbox presentation", () => {
    const selected = formatAutocompleteMultiselectOption({
      option,
      active: true,
      selectedValues: [option.value],
      focusedValue: option.value,
    });
    const disabled = formatAutocompleteMultiselectOption({
      option: { ...option, disabled: true },
      active: true,
      selectedValues: [],
      focusedValue: option.value,
    });

    expect(stripVTControlCharacters(selected)).toBe(
      `${S_CHECKBOX_SELECTED} api-deploy`,
    );
    expect(selected).toContain("\u001b[32m");
    expect(disabled).toContain("\u001b[9m");
    expect(disabled).not.toContain("\u001b[3m");
    expect(disabled).not.toContain("\u001b[4m");
  });
});
