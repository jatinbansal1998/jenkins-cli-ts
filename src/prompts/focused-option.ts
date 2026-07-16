import { styleText } from "node:util";

/** Applies the shared focused-row treatment without changing inactive content. */
export function formatFocusedOption(content: string, active: boolean): string {
  return active ? styleText(["italic", "underline"], content) : content;
}
