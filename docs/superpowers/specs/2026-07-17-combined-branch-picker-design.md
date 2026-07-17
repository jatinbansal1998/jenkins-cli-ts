# Combined Branch Picker Design

## Objective

Replace the two-step interactive branch selection (select a cached branch or
"Type a different branch", then a separate text prompt) with a single prompt
that shows cached branches, a persistent custom-branch input row, and the
existing "Remove cached branch" utility action.

## Current Behavior

Branch selection has two interactive surfaces:

1. The `branch_select` state in the `buildPre` flow
   (`src/flows/definition.ts`). It is a `select` prompt listing cached
   branches, a `"Type a different branch"` row (`BRANCH_CUSTOM_VALUE`) that
   routes to the `branch_entry` text state, and a `"Remove cached branch"` row
   (`BRANCH_REMOVE_VALUE`) that routes to the `branch_remove` menu. Esc returns
   to `branch_mode`. Every menu-driven entry point converges here: `jenkins
build` interactive, the list-interactive "Build" action, the status "Build
   now" action, and the "Trigger another build?" repeat loop.
2. An imperative duplicate, `promptForBranchSelection` in
   `src/commands/build.ts`, reached through `resolveBranchValue` from the
   discovered-parameters path (`promptForDiscoveredParameters.selectBranch`).
   Cancellation there throws `CliError("Operation cancelled.")`, which the
   caller converts to `{ cancelled: true }`.

The non-interactive path (`runBuildOnce` → `resolveBranchValue` with
`nonInteractive: true`) never prompts and must not change. The `branch_entry`
text state remains as the fallback when no cached branches exist.

## Considered Approaches

### Focused custom Clack prompt (chosen)

Add `src/prompts/branch-picker.ts` built on `@clack/core`'s base `Prompt`
class, following the repo's existing custom-prompt pattern
(`src/prompts/multiselect.ts`, `src/prompts/autocomplete-multiselect.ts`):
radio-style option rows plus a persistent input row, exported through
`src/clack.ts`, exposed on `PromptAdapter`, and used as a new `branchPicker`
prompt kind in the flow runner. Chosen because typed-input precedence is
explicit in one place, the UX is exact, and the pattern is already
institutionalized in this codebase.

### Reuse AutocompletePrompt with filtering disabled

Prefer nonblank `userInput` over the highlighted selection. Rejected: typed
text in an autocomplete is a search query, so valid custom branches would
render "No matches found", and Enter-selects-highlighted is the ingrained
autocomplete contract. It would also conflate the picker with the job search
prompt shown immediately before it.

### Compose stock prompts

No composition of stock `select` + `text` produces one prompt with both
semantics; anything here collapses back to the current two-step flow.

## Prompt Contract

`branchPicker(options)` returns `Promise<string | symbol>` where `symbol` is
Clack's cancel token.

Options: `message`, `options: PromptOption[]` (cached branches followed by
utility rows such as Remove), `placeholder?`, `initialUserInput?`, `maxItems?`,
`input?`, `output?`, `signal?` (streams and signal for tests).

Keyboard behavior:

- Up/Down move the list highlight, skipping disabled options and wrapping.
- Printable characters, Backspace, Left/Right edit the custom input line.
- Enter with nonblank trimmed input submits the typed branch; typed input
  always takes precedence over the highlighted option.
- Enter with blank or whitespace-only input submits the highlighted option
  value (a branch or `BRANCH_REMOVE_VALUE`).
- Esc/Ctrl+C cancel; the flow runner maps this to the `esc` event exactly like
  the other prompt kinds, so `branch_select` still returns to `branch_mode`.

Rendering:

- Cached branch rows use radio symbols with the shared
  `formatFocusedOption` treatment; utility rows render after branch rows.
- The custom input row is pinned last with a `Custom branch:` label and an
  inline cursor. While the input is nonblank, option rows render dimmed and
  the input row takes the focused treatment, making typed precedence visible.
- Colors go through `node:util` `styleText`, which honors `NO_COLOR`.
- Validation: submitting with a blank input, no enabled highlighted option,
  and an empty option list shows an inline error instead of resolving. Because
  `@clack/core` validates `this.value` before `finalize`, the prompt keeps its
  resolved value (typed input if nonblank, else highlighted option) up to date
  on every keypress rather than computing it at finalize time.

## Flow Integration

- `PromptAdapter` gains an optional `branchPicker` method; `PromptSpec` gains a
  `branchPicker` kind (`message`, `options(context)`, `placeholder?`,
  `maxItems?`). The runner resolves it like `select` (string value, cancel →
  `esc`) and throws a clear error if the adapter lacks the method.
- `branch_select` switches to the `branchPicker` kind. Its options become
  cached branches plus the Remove row when removable branches exist. The
  `"Type a different branch"` row and the `branch:entry` transition out of
  `branch_select` are removed; `BRANCH_CUSTOM_VALUE` is deleted from
  `src/flows/constants.ts`.
- `selectBranchHandler` keeps the `BRANCH_REMOVE_VALUE` case and the blank →
  `branch:retry` guard, and drops the custom-value case.
- `branch_entry`, `branch_remove`, `branch_remove_apply`, and all custom
  parameter states are unchanged.
- `src/commands/build.ts` adds `branchPicker` to `BuildDeps` and the `runFlow`
  adapter, and `promptForBranchSelection` is rewritten around the new prompt
  (remove loop and `CliError` cancellation preserved). The `status` command's
  multi-select behavior is untouched.

## Testing

New `tests/branch-picker.test.ts` drives the prompt with PassThrough streams
(readline `terminal: true` emits keypress events from raw writes):

- Enter with blank input selects the highlighted option.
- Typed input returns the custom branch; whitespace-only input does not
  override the highlighted option.
- Cursor movement wraps and skips disabled options; disabled options cannot be
  submitted.
- Initial input, Left/Right cursor movement, and Backspace editing work.
- Esc resolves to the cancel token.
- Empty and long (`maxItems`) option lists render safely.

Pure formatter tests mirror `tests/multiselect.test.ts`. Flow tests update
`tests/flow-definition.test.ts` (Remove row stays last, no custom-row
sentinel), `tests/flow-runner.test.ts` (new kind resolution and cancel), and
`tests/build-navigation.test.ts` (branchPicker mock: typed branch, remove, and
Esc journeys; custom-parameter navigation regressions). All tests follow the
Bun shared-process mock rules in `AGENTS.md`.
