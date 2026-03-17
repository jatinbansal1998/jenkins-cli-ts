import {
  autocomplete as clackAutocomplete,
  confirm,
  isCancel,
  multiselect,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { PromptAdapter } from "./flows/types";

export { confirm, isCancel, multiselect, password, select, spinner, text };

// Clack can also return its internal cancel token at runtime; `isCancel`
// handles that path, while the typed adapter keeps successful payloads narrow.
export const autocomplete =
  clackAutocomplete as PromptAdapter["autocomplete"];
