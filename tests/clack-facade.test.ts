import { describe, expect, test } from "bun:test";
import {
  autocomplete as clackAutocomplete,
  autocompleteMultiselect as clackAutocompleteMultiselect,
  multiselect as clackMultiselect,
  select as clackSelect,
} from "@clack/prompts";
import {
  autocomplete,
  autocompleteMultiselect,
  multiselect,
  select,
} from "../src/clack";

describe("clack facade prompt ownership", () => {
  test("keeps standard select and single autocomplete unchanged", () => {
    expect(select).toBe(clackSelect);
    expect(autocomplete).toBe(clackAutocomplete);
  });

  test("routes both multi-select variants through custom renderers", () => {
    expect(multiselect).not.toBe(clackMultiselect);
    expect(autocompleteMultiselect).not.toBe(clackAutocompleteMultiselect);
  });
});
