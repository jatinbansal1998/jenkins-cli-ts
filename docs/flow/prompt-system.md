# Prompt System (How Prompts Are Built)

This document explains how interactive prompts are assembled and executed in
`jenkins-cli`.

## 1) Prompt architecture

Prompt behavior is split into generic flow layers plus a focused Jenkins job
picker:

1. `FlowDefinition` (`src/flows/definition.ts`)
   - Declares states, prompt types, and transitions.
   - Defines what the user sees (`message`, `options`, placeholders, defaults).
2. Handlers (`src/flows/handlers.ts`)
   - Maps prompt input to semantic events (for example `select:job`).
   - Updates flow context (selected job, selected action, branch, etc.).
3. Runner (`src/flows/runner.ts`)
   - Executes state machine loop.
   - Renders prompts via a prompt adapter and resolves next transition.
4. Job picker (`src/job-picker.ts`)
   - Owns every interactive Jenkins job autocomplete.
   - Provides single- and multiple-selection modes over an already loaded job
     collection.
   - Applies fuzzy suggestions, preferred/recent ordering, validation, and
     structured cancellation in one place.

At runtime, commands call `runFlow(...)` and pass:

- `definition`: the flow map (`buildPre`, `buildPost`, `listInteractive`,
  `statusPost`)
- `handlers`: event resolver callbacks for each flow
- `prompts`: concrete prompt functions (`autocomplete`, `select`, `confirm`,
  `text`, `isCancel`)
- `context`: mutable flow state

Interactive prompt functions are routed through `src/clack.ts`, which wraps
`@clack/prompts`. The CLI intro banner is formatted in `src/cli-intro.ts` and
printed explicitly from `src/index.ts` before an interactive command starts,
instead of being triggered implicitly by the first prompt call.

## 2) Prompt types

Prompt kinds are defined in `src/flows/types.ts`:

- `select`: choose from options
- `confirm`: yes/no
- `text`: free input
- `autocomplete`: searchable single selection for domain-neutral flow prompts
- `branchPicker`: combined branch chooser (`src/prompts/branch-picker.ts`)
  with cached-branch options plus a persistent custom-branch input row;
  nonblank typed input wins over the highlighted option, and cancel maps to
  `esc` like every other kind

Jenkins job selection is not a `PromptSpec` kind. Flow entry handlers call the
shared job picker and translate its selected/cancelled result into semantic
flow events. Interactive `status` uses the picker's autocomplete multi-select
mode directly.

Each prompt field can be static or context-driven:

- Static: `message: "Branch name"`
- Dynamic: `message: (context) => \`Action for ${context.targetLabel}\``

## 3) How a prompt becomes a transition

For each state in `runFlow(...)`:

1. Resolve prompt config from context.
2. Execute adapter method (`select`/`confirm`/`text`).
3. Convert result to event:
   - Cancel -> `esc`
   - Confirm -> `confirm:yes` / `confirm:no`
   - Select / branch picker -> `select:<value>`
   - Text -> handler event (for example `search:candidates`)
4. Look up transition target in the state's `transitions`.
5. Continue until a terminal state (`exit_command`, `repeat`, etc.).

## 4) Dependencies and their uses

### External package dependencies

- `@clack/prompts` (`package.json`)
  - Actual terminal UI prompt implementation (`autocomplete`,
    `autocompleteMultiselect`, `select`, `confirm`, `text`, `multiselect`,
    `spinner`, `isCancel`).
  - Imported via `src/clack.ts` so interactive prompt usage stays centralized.
- `@clack/core` (`package.json`)
  - Low-level prompt state used for deliberately customized UI components.
  - The focused autocomplete multi-select renderer uses it to preserve Clack's
    navigation behavior while making the active option italic and underlined.
- `yargs` (`package.json`)
  - CLI argument parsing and command routing.
  - Indirectly affects prompts by deciding interactive vs non-interactive paths.

### Internal prompt dependencies

- `src/flows/types.ts`
  - Prompt and flow type contracts.
- `src/flows/definition.ts`
  - Declarative state machine + prompt spec per command flow.
- `src/flows/handlers.ts`
  - Input-to-event mapping and context updates.
- `src/flows/runner.ts`
  - Generic flow execution engine.
- `src/flows/validate.ts`
  - Validates flow definitions before first run.
- `src/clack.ts`
  - Shared `@clack/prompts` facade.
- `src/prompts/autocomplete-multiselect.ts`
  - Core-backed autocomplete multi-select renderer with explicit focused-row
    styling for terminal themes where dimming alone is not visible enough.
- `src/prompts/multiselect.ts`
  - Core-backed regular multi-select renderer used automatically by artifact
    and multiple-running-build selection.
- `src/prompts/focused-option.ts`
  - Opt-in italic-and-underline focused-row treatment shared by both custom
    multi-select renderers. Standard select and single autocomplete do not use
    it.
- `src/job-picker.ts`
  - Shared owner of interactive Jenkins job search and selection.
- `src/commands/ops-helpers.ts`
  - Loads and resolves job targets, bypasses prompts for explicit URLs and
    non-interactive calls, and delegates interactive selection to the picker.
- `src/cli-intro.ts`
  - CLI intro banner formatter/printer helpers.
- `src/commands/list-deps.ts`
  - Adapter surface used by `list` for prompts and delegated actions.

## 5) Which flows own which prompts

- `listInteractive`
  - Invokes the shared single-job picker, then owns the action menu for `list`.
- `buildPre`
  - Invokes the shared single-job picker, then owns branch and parameter input.
- `buildPost`
  - Post-build actions (`watch`, `logs`, `cancel`, `rerun`, `done`).
- `statusPost`
  - Post-status follow-up actions and repeat confirmation.

`status` invokes the shared multi-job picker before entering `statusPost`.

## 6) Non-interactive mode behavior

When `--non-interactive` is enabled, command code bypasses prompt flows and
fails fast if required input is missing.

Examples:

- `runBuild` uses `runBuildOnce(...)` without `runFlow(...)`
- `runStatus` uses `runStatusOnce(...)` without post-action prompt loops
