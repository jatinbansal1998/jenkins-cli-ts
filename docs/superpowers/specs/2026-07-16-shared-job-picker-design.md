# Shared Job Picker Design

## Objective

Make every interactive Jenkins job lookup use the same autocomplete behavior
and implementation. Commands that operate on one job use a single-select
picker. `jenkins-cli status` keeps its ability to select multiple jobs by using
the matching autocomplete multi-select picker.

This change applies only to choosing Jenkins jobs from the cached job list.
Free-form values such as branch names, parameter values, URLs, profile names,
usernames, and destination directories remain text inputs.

## Current Problem

Interactive job selection is split across three implementations:

1. `list` and `build` declare autocomplete prompts inside their flow
   definitions.
2. `params`, `history`, `wait`, `logs`, `artifacts`, `cancel`, and `rerun` use
   `resolveJobTarget`, which first asks for free text and then presents a second
   selection prompt when the query has multiple matches.
3. `status` owns another free-text search loop followed by a multi-select
   prompt.

The implementations differ in presentation, recent-job behavior, cancellation
semantics, and retry handling. Updating search behavior therefore requires
coordinated edits in multiple command files.

## Recommended Architecture

Create a focused job-selection module at `src/job-picker.ts`. It owns all
interactive job-picker presentation and exposes single-select and multi-select
behavior through one discriminated API.

The conceptual interface is:

```ts
type JobPickerOptions = {
  env: EnvConfig;
  jobs: JenkinsJob[];
  mode: "single" | "multiple";
  initialQuery?: string;
};

type JobPickerResult =
  | { kind: "selected"; jobs: JenkinsJob[] }
  | { kind: "cancelled"; userInput: string };

async function pickJobs(options: JobPickerOptions): Promise<JobPickerResult>;
```

The public result always contains an array so the underlying picker has one
implementation. Thin typed wrappers may expose `pickJob()` for single-select
callers when that improves call-site types, but wrappers must delegate directly
to `pickJobs()` and contain no search or prompt behavior.

The module depends on the prompt facade in `src/clack.ts`, not directly on
`@clack/prompts`. This preserves the project's testing seam. The facade will
export and type both `autocomplete` and `autocompleteMultiselect`.

## Picker Behavior

Both modes share these rules:

- Prompt message: `Job name or description`, decorated with the active target
  through `withPromptTarget`.
- Placeholder: `e.g. api prod deploy`.
- Dynamic options come from `getSuggestedJobs(query, jobs)`.
- Job labels use `getJobDisplayName(job)`.
- Clack's substring filter is disabled because `getSuggestedJobs` already
  performs fuzzy ranking and filtering.
- An empty query shows preferred jobs first. Preferred ordering comes from
  `loadPreferredJobs`, which already places recent jobs before the remaining
  alphabetical list.
- A selection is validated against the supplied job collection before being
  returned.
- Escape returns a structured cancellation result. The picker does not decide
  whether cancellation exits a command or moves to another state.

Single mode renders Clack's `autocomplete` and requires one selected job.
Multiple mode renders Clack's `autocompleteMultiselect`, requires at least one
selected job, and returns selections in picker order.

### Focused Multi-Select Styling

The installed `@clack/prompts` 1.7.0 release is also the latest available
release. Its autocomplete multi-select distinguishes the focused row primarily
by dimming inactive labels. That contrast is not visible enough in some light
terminal themes.

Add `@clack/core` 1.4.3 as a direct dependency and implement a focused custom
autocomplete multi-select renderer. The renderer stays behind the existing
`src/clack.ts` facade so command and picker code remain independent of prompt
internals, and the core dependency can support other deliberately designed
custom UI elements later.

The renderer follows Clack's current autocomplete multi-select behavior for
search, fuzzy-filter bypass, scrolling, checked state, validation,
cancellation, instructions, and submission. Its only presentation change is
that the complete focused option is both italicized and underlined. Inactive
options remain dimmed and selected checkboxes remain green. The focused style
moves with Up/Down navigation and does not imply that an option is selected.

Do not patch `node_modules` or couple `job-picker.ts` directly to
`@clack/core`. Renderer-specific tests will verify focused, inactive, selected,
and disabled option output. Picker tests continue to cover selection behavior.

There will be no separate recent-jobs menu for job lookup. Recent jobs appear
first when the input is blank, and users can immediately type to search the full
cache. This makes the interaction consistent across `list`, `build`, `status`,
and direct commands.

## Target Resolution

Interactive presentation and target resolution remain separate concerns:

- `pickJobs` selects from an already loaded collection.
- A consolidated resolver loads jobs, handles explicit `--job-url`, resolves
  non-interactive `--job` values, and invokes `pickJobs` only when interaction
  is required.

The resolver preserves existing rules:

- `--job-url` bypasses the cache and picker.
- Non-interactive commands require `--job` or `--job-url` and never prompt.
- A non-interactive query must resolve unambiguously through
  `resolveJobMatch`.
- Missing or unusable job caches retain the existing actionable error and
  refresh hint.
- Returned URLs are normalized and validated centrally.

Single-job commands receive one normalized `{ jobUrl, jobLabel }` target.
`status` receives an array of normalized targets in interactive multiple mode.

## Command Integration

### `list`

Replace the embedded autocomplete option generation in `listInteractive` with
the shared single picker. Selecting a job still leads to the existing action
menu. Esc exits at the list root, and returning from the action menu opens the
same picker again.

### `build` and `deploy`

Replace both build search states and the separate recent-job menu with the
shared single picker. A successful selection continues into parameter and
branch preparation. Esc at the root exits; navigation after branch or build
mode remains unchanged.

### `status`

Replace the recent-job menu, free-text prompt, candidate search loop, and plain
multi-select with the shared multiple picker. `status` continues to show and
process every selected job. Follow-up actions remain available only when one
job was selected, matching current behavior.

When an interactive `--job` query is supplied, its matching candidates seed the
multiple picker. An unambiguous query may resolve directly. Non-interactive
status continues to resolve exactly one job.

### Shared single-job commands

`params`, `history`/`builds`, `wait`, `logs`, `artifacts`, `cancel`, and `rerun`
delegate to the consolidated single-target resolver. Their direct URL options
continue to bypass job selection.

The targetless `cancel` running-build menu introduced in the current codebase
is preserved. Its `Search all jobs` action delegates to the shared single
picker; it does not create another search implementation.

## Flow Integration

The generic flow runner will not gain a Jenkins-specific prompt kind. Instead,
job selection is invoked from focused flow handlers or entry states, and the
result is translated into the flow's existing semantic events.

This keeps `PromptSpec` and `runFlow` domain-neutral. Command flows own only
navigation decisions, while `job-picker.ts` owns job search presentation and
selection.

Flow contexts no longer need to duplicate fuzzy option construction. They may
retain the current search input only when necessary to restore user input after
navigating back to the picker.

## Cancellation and Errors

The picker reports cancellation without throwing. Each caller maps it to its
own navigation:

- root `list` or `build`: exit the command;
- returning from a nested action: return to that command's defined parent;
- `status`: exit at the root;
- `cancel` after choosing `Search all jobs`: return to the running-build menu;
- other direct commands: report `Operation cancelled.` through their existing
  command boundary.

Errors caused by loading or resolving jobs remain `CliError`s with the existing
messages and hints. A stale selection that is absent from the supplied job list
is rejected inside the picker and shown again instead of leaking an invalid URL
to command logic.

## Testing

Add a focused `tests/job-picker.test.ts` suite covering:

- shared fuzzy-ranked dynamic options;
- preferred/recent ordering for an empty query;
- single selection;
- multiple selection;
- required-selection validation;
- cancellation and preservation of typed input;
- rejection of a stale or unknown selected URL;
- target decoration in the prompt message.

Extend resolver tests to cover:

- explicit URL bypass;
- interactive single selection;
- interactive multiple selection for status;
- non-interactive exact and ambiguous queries;
- empty cache and invalid selected URL errors.

Update command and flow tests so each command proves only its integration
contract: which picker mode it requests, how it handles cancellation, and what
it does with the selected targets. Remove tests that duplicate fuzzy-search and
prompt behavior now owned by `job-picker.ts`.

Because Bun runs test files in one process, prompt dependencies will be injected
through stable dependency objects. Tests must follow the repository's existing
mock-isolation rules and avoid global cleanup that can invalidate mocks in
other files.

## Documentation

Update the prompt-system and flow documentation to show the shared job picker
as the owner of interactive Jenkins job selection. Remove descriptions of the
text-then-select status and shared-resolver paths.

No CLI flags, JSON schemas, Jenkins API calls, or non-interactive output formats
change as part of this work.

## Acceptance Criteria

- Every interactive Jenkins job lookup shows autocomplete suggestions while the
  user types.
- All single-job commands use one shared single-selection implementation.
- Interactive `status` uses autocomplete multi-select and can process multiple
  selected jobs.
- The complete focused status option is italicized and underlined while arrow
  navigation moves through the list.
- Blank input prioritizes recent jobs consistently.
- `cancel` retains its running-build shortcuts and delegates full job search to
  the shared picker.
- Explicit URL and non-interactive paths do not prompt.
- Existing flow navigation remains intact apart from removing redundant recent
  and text-search screens.
- Prompt behavior is tested centrally and command tests cover integration only.
- Format, lint, typecheck, tests, and build pass after implementation.
