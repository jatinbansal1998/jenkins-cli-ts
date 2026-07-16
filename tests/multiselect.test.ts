import { describe, expect, test } from "bun:test";
import {
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
} from "@clack/prompts";
import { stripVTControlCharacters } from "node:util";
import { formatFocusedOption } from "../src/prompts/focused-option";
import { formatMultiselectOption } from "../src/prompts/multiselect";

const option = { value: "api", label: "api-deploy" };

describe("shared focused option styling", () => {
  test("is opt-in and only styles active content", () => {
    const focused = formatFocusedOption("api-deploy", true);
    const inactive = formatFocusedOption("api-deploy", false);

    expect(focused).toContain("\u001b[3m");
    expect(focused).toContain("\u001b[4m");
    expect(inactive).toBe("api-deploy");
  });
});

describe("regular multi-select rendering", () => {
  test("styles the complete active option", () => {
    const rendered = formatMultiselectOption({ option, state: "active" });

    expect(rendered).toContain("\u001b[3m");
    expect(rendered).toContain("\u001b[4m");
    expect(stripVTControlCharacters(rendered)).toBe(
      `${S_CHECKBOX_ACTIVE} api-deploy`,
    );
  });

  test("keeps selected state while focused", () => {
    const rendered = formatMultiselectOption({
      option,
      state: "active-selected",
    });

    expect(rendered).toContain("\u001b[3m");
    expect(rendered).toContain("\u001b[4m");
    expect(rendered).toContain("\u001b[32m");
    expect(stripVTControlCharacters(rendered)).toBe(
      `${S_CHECKBOX_SELECTED} api-deploy`,
    );
  });

  test("leaves inactive rows dim and focused styling off", () => {
    const rendered = formatMultiselectOption({ option, state: "inactive" });

    expect(rendered).toContain("\u001b[2m");
    expect(rendered).not.toContain("\u001b[3m");
    expect(rendered).not.toContain("\u001b[4m");
    expect(stripVTControlCharacters(rendered)).toBe(
      `${S_CHECKBOX_INACTIVE} api-deploy`,
    );
  });

  test("preserves disabled presentation", () => {
    const rendered = formatMultiselectOption({
      option: { ...option, disabled: true },
      state: "disabled",
    });

    expect(rendered).toContain("\u001b[9m");
    expect(rendered).not.toContain("\u001b[3m");
    expect(rendered).not.toContain("\u001b[4m");
  });
});
