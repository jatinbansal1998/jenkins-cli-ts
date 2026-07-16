# Running Builds, Batch Cancel, and `run` Command Design

## Scope

Add one shared, live Jenkins running-build discovery capability and use it in
two commands:

- Enhance interactive `jenkins-cli cancel` with direct running-build choices,
  multi-select, select-all, and the existing all-job search fallback.
- Add `jenkins-cli run` to list running builds and open a selected build in the
  system browser.

Existing explicit cancel targets, queued-build cancellation, cached fuzzy job
search, and non-interactive cancel behavior remain unchanged.

## Running-build discovery

Add a normalized `RunningBuildSummary` model containing the job name, optional
full job name, job URL, build number, and exact build URL. Add one Jenkins
client method that queries the live jobs tree with each job's
`lastBuild[number,url,building]` fields and returns only entries whose latest
build has `building: true` and a valid build URL.

The query and traversal must follow the existing folder-depth and nested-folder
behavior used by job discovery. Results are deduplicated by normalized build
URL and sorted by display name, then build number. This is preferred over
executor discovery because a Pipeline build can still be running while it is
temporarily not occupying an executor, and preferred over calling job status
once per cached job because that would create an N+1 request pattern.

## `cancel` interaction

Only interactive `jenkins-cli cancel` calls with no `--job`, `--job-url`,
`--build-url`, or `--queue-url` use the new first menu. When running builds are
found, the menu contains:

1. One option per running build, labeled with job display name and build number.
2. `Select multiple running builds`.
3. `Select all running builds`.
4. `Search all jobs`.

Selecting an individual build uses its exact build URL. Multi-select opens a
checkbox prompt containing the running builds; an empty or cancelled selection
returns to the first menu. Select-all targets the complete discovered list.
Search enters the existing cached fuzzy-search path unchanged, including its
ability to resolve and cancel a queued item.

If there are no running builds, the command skips the first menu and opens the
existing job search directly. If live discovery fails, the command prints a
concise hint and also falls back to search rather than blocking cancellation.

For multiple targets, show one confirmation naming the number of builds. If the
user confirms, request cancellation for every selected build, continue after
an individual cancellation failure, and wait for each successfully requested
build to reach a terminal state. Report a final summary with succeeded and
failed counts; if any target fails, surface a command error after all targets
have been attempted. Single-build selection retains the current confirmation
and output.

Explicit targets and non-interactive cancel calls do not perform running-build
discovery and retain their current behavior.

## `run` command

Add `jenkins-cli run` as a read-only running-build browser command.

Interactive mode fetches the shared running-build list and presents a
single-select menu. Selecting a build opens its exact build URL in the system's
default browser. Escape returns without opening anything. If browser launch
fails, print the build URL and a concise hint so the user can open it manually.

Non-interactive mode prints every running build with its URL and never launches
a browser. If no builds are running, both modes print
`OK: no running builds` and exit successfully.

Browser opening is isolated behind a small cross-platform helper using Bun
process APIs: `open` on macOS, `xdg-open` on Linux, and `cmd /c start` on
Windows. The helper accepts an injectable launcher so command behavior can be
tested without opening a real browser.

## Error handling

- Malformed Jenkins job or build entries are skipped.
- A failed discovery request is a fallback condition only for interactive
  targetless `cancel`; it remains a command error for `run`, which has no
  alternate data source.
- Batch cancellation attempts all selected builds and reports partial failure
  only after the batch completes.
- Direct cancel option validation and Jenkins cancellation errors retain their
  existing messages.

## Testing and documentation

Add focused tests for:

- Running-build API normalization, nested folders, sorting, and deduplication.
- Individual, multiple, select-all, search, empty-list, and discovery-error
  paths in interactive `cancel`.
- Batch confirmation, partial failure, and terminal-status waiting.
- Interactive `run`, non-interactive listing, empty results, cancelled
  selection, and browser-launch fallback.
- CLI routing and help for the new `run` command.

Update the README command examples and supported-feature summary. Run format,
lint, typecheck, focused/full tests, and compilation validation.
