# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry is condensed from its [GitHub release](https://github.com/jatinbansal1998/jenkins-cli-ts/releases).
A prerelease entry lists only what was new in that prerelease. A stable entry
lists everything since the previous stable release, including its prereleases.

## [Unreleased]

### Added

- `JENKINS_CLI_CONFIG_DIR` moves the config directory (config file, logs,
  update state) to any absolute path. `auth status` and `--help` print the
  resolved path.

### Changed

- The config directory follows `XDG_CONFIG_HOME` when it is set, and
  `%APPDATA%\jenkins-cli` on Windows. Users whose config lived in
  `~/.config/jenkins-cli` under a different `XDG_CONFIG_HOME`, or on Windows,
  must move that folder to the new location.

### Fixed

- Job URLs in `--json` output (`details.candidates[].url`, `list`, `queue`,
  `build`, `rerun`, and `input` `jobUrl`) always end with `/`, as Jenkins
  returns them. A job read from the local cache printed without the slash.
- `history --limit <n>` reads the per-build stage data with at most 6 requests
  in flight instead of `n` at once.

## [1.0.0-rc.5] - 2026-10-06

### Added

- `--quiet` prints nothing except errors and their hints on stderr. It implies
  `--non-interactive`, skips the background update check, and is rejected with
  `--json` or `--jsonl`.
- `--no-color`, `NO_COLOR`, and `FORCE_COLOR` apply to every styled string,
  including the status result, which was bold even when piped.
- `history --limit <n>` sets the page size (default 5) and works with
  `--offset`; with `--json` it returns up to `n` builds in one document.
  `list --limit <n>` prints or returns at most `n` jobs after `--search` and
  `--active-only`.

### Changed

- Exit codes follow the error class: `2` usage, `3` authentication, `4` not
  found, `5` read-only profile, `6` Jenkins error, `130` interrupted or prompt
  cancelled, `1` for failed outcomes and other errors. `124` stays for
  `wait --timeout`. The exit code always matches the `--json` error `code`.
- Jenkins HTTP 400 responses (for example an invalid parameter value) map to the
  usage class as `JENKINS_BAD_REQUEST`.
- Recent jobs, branch history, and stage totals live in `state-<key>.json` next
  to the job list, scoped per Jenkins URL. Values stored in old `jobs-*.json`
  files are not carried over and rebuild with use.
- The `--json` and `--jsonl` error body is
  `{ code, message, hints, details? }`. `hints` carries the same next steps the
  text output prints. `JOB_AMBIGUOUS` and `JOB_NOT_FOUND` add
  `details.candidates`, the `{ name, url }` of each job the hint lists.

### Fixed

- Concurrent commands no longer overwrite each other's recent jobs or branch
  history: state writes are read-modify-write under a lock.
- A flag given without its value (for example a bare `--limit`) exits `2` with
  `INVALID_USAGE` instead of `1` as an unexpected error.

### Performance

- The job list is read once per command and written only by a refresh. State
  writes are compact and skipped when nothing changed.
- Refresh no longer merges branches back into the job list, removing an O(n²)
  pass over large job lists.
- Interactive `status` with several jobs picked reads them 6 at a time
  instead of one after another, so 5 jobs take about as long as one.

## [1.0.0-rc.4] - 2026-09-30

### Added

- `--build` accepts `lastSuccessful`, `lastStable`, `lastFailed`, and
  `lastCompleted` on every build-scoped command. A job with no matching build
  fails with `BUILD_NOT_FOUND`; an unknown value fails with
  `INVALID_BUILD_NUMBER` and the hint lists the shortcuts.

### Fixed

- When `ldd` is unavailable, `update` detects musl from the binary's build
  target. The old scan of the whole executable used about 185MB and wrongly
  picked the musl asset on glibc hosts.

### Performance

- `logs --stage`, `--failed`, and `--stage-id` (for a stage) read only the
  selected stage. On a 15-stage Pipeline, `--follow` dropped from about 27 to 5
  requests per second.
- Step logs are read up to 6 at a time, finished stages and steps are not
  re-read, and a final read after the build ends keeps the last lines.
- Log reads wait at least 200ms between requests.
- Each command reads the config file once instead of three times.

## [1.0.0-rc.3] - 2026-09-30

### Added

- `list`, the job picker, and running-build discovery descend into multibranch
  pipelines and organization folders. Branch jobs resolve by name as
  `repo/branch` without `--job-url`.

### Performance

- Each status poll fetches build details and Pipeline stages in parallel.
- Parameters, causes, and queue wait are fetched once per build and reused. A
  missing Pipeline stage endpoint is remembered per build.
- Commands that only need the last build (`build`, `wait`, `watch`, `logs`,
  `cancel`, `input`) get it from one request instead of three or four.
- Whole-build `logs --follow` checks build status only after Jenkins reports the
  log is closed.
- `logs --tail N` reads the log backwards from the end instead of downloading
  all of it.
- `logs --since` on a finished build downloads the log once instead of twice.

## [1.0.0-rc.2] - 2026-09-29

### Changed

- A request that fails with a network error waits 200–500ms (jittered) before
  its single retry.
- A request that hits the header timeout fails straight away instead of
  retrying, so the worst-case wait is no longer doubled.

### Fixed

- Keychain token errors surface as auth errors from every command, including
  best-effort reads such as `logs --queue-url` polling, `cancel` build
  discovery, stale job-cache refreshes, and pending input submission.

### Performance

- Binaries are compiled with bytecode and minification. On Linux x64,
  `--version` dropped from 96ms to 47ms and `--help` from 234ms to 185ms.
- `help --json` and `help --full` render in-process instead of spawning one
  child process per command.
- The minimum-version policy refresh runs in a detached background worker.
  `--help`, `--version`, and `help` skip it entirely.
- The OS keychain is read only when a command actually reaches Jenkins.

## [1.0.0-rc.1] - 2026-09-19

### Added

- `jenkins-cli help --json` (and `--json help`) prints a command catalog with
  paths, structured-output support, and help text.

### Changed

- Removed compatibility aliases. Use `auth login` instead of `login`,
  `auth list` / `auth use` / `auth logout` instead of `profile`, `build` instead
  of `deploy`, `history` instead of `builds`, and `update` instead of `upgrade`.
  `--api-token` still works as an alias for `--token`.
- CSRF crumbs are sent on writes by default. Opt out with
  `JENKINS_USE_CRUMB=false` or `"useCrumb": false` in the profile.
- Releases ship native platform binaries only. The generic JS bundle and Bun
  bootstrap are gone, and a missing native asset fails instead of falling back.
- Manual `update` prints the current version, check progress, target version,
  and old/new versions. Downloads stage next to the installed executable and
  replace it with one atomic rename.
- Standalone auto-update runs `update <tag>` in a detached process. Homebrew and
  Windows stay hint-only. `--enable-auto`, `--disable-auto`,
  `--enable-auto-install`, and `--disable-auto-install` are removed.
- Update requests cancel after five minutes; hung version probes are killed
  after five seconds.
- Clients older than `0.8.7` are told to update.

### Fixed

- Compiled binaries print `jenkins-cli` in help instead of platform asset names
  such as `jenkins-cli-darwin-arm64`.

## [0.8.16] - 2026-09-17

No CLI behaviour change.

### Changed

- Integration tests install CloudBees Folder 6.1106 so release-asset validation
  can start Jenkins, and `@types/bun` is pinned to 1.4.2.

## [0.8.15] - 2026-09-16

### Added

- `input list`, `input approve`, and `input abort` handle Pipeline `input` steps
  waiting on one exact build. Approve and abort always confirm interactively;
  non-interactive and `--json` runs must pass `--yes`. Parameterized inputs fail
  with `INPUT_PARAMETERS_UNSUPPORTED` but can still be aborted. A lost response
  never resubmits. Read-only profiles block approve and abort until
  `--confirm-protected`. A `Pending inputs` action appears in the `list`,
  `build`, `status`, and `history` menus.
- `changes` reports build trigger causes and SCM commits for an exact build or a
  job's latest build, grouped by SCM source. `--paths` adds affected files,
  `--limit` bounds commits, and `--json` returns `changeSets`.
- `config` prints a job or folder's raw `config.xml`.
- `create` creates an item from a local config file or copies an existing job or
  folder, including inside folders. Read-only profiles block it unless
  explicitly confirmed.

### Changed

- The CLI collects no usage analytics and sends no automatic error reports. The
  PostHog and Sentry integrations, their environment variables, and the
  `analyticsDisabled` config key are removed.
- Errors are written locally to `~/.config/jenkins-cli/error-YYYY-MM-DD.log`,
  even without `--debug`. Active API tokens and their Basic-auth encodings are
  masked in error and API logs. Logs rotate daily in UTC, are kept for seven
  days, use owner-only permissions on Unix, and refuse file symlinks.

### Fixed

- Build, queue, and history URLs are derived from the selected controller's job
  URL, so a controller with a different configured root URL no longer sends
  follow-up requests to the wrong host.

## [0.8.15-rc.5] - 2026-09-09

### Changed

- Removed telemetry from normal CLI operation. Error logs are persisted locally
  for troubleshooting.

## [0.8.15-rc.4] - 2026-09-08

No user-facing changes since `v0.8.15-rc.3`. See the
[compare range](https://github.com/jatinbansal1998/jenkins-cli-ts/compare/v0.8.15-rc.3...v0.8.15-rc.4).

## [0.8.15-rc.3] - 2026-09-08

### Added

- `input` command group for Pipeline `input` steps waiting on one exact build:
  `input list`, `input approve`, and `input abort`, with stable error codes, a
  `--yes` requirement for non-interactive runs, read-only profile protection,
  and a `Pending inputs` menu action.

### Fixed

- Build, queue, and history URLs are derived from the selected controller's job
  URL instead of the URLs Jenkins reports.

## [0.8.15-rc.2] - 2026-09-05

### Changed

- `changes` groups commits and affected paths by SCM source, with repository
  names when checkout metadata matches. The commit limit applies across all
  sources after chronological sorting.
- `changes --json` replaces the top-level `changes` array with `changeSets`.
  Scripts written against rc.1 must use the new structure.

## [0.8.15-rc.1] - 2026-09-01

### Added

- `config` prints a job or folder's raw `config.xml`.
- `create` creates an item from a local config file or copies an existing job or
  folder. `create --json` returns the created name, URL, and copy source.
- `changes` reports build trigger causes and SCM commits. `--paths` adds
  affected files, `--limit` bounds commits, and `--json` keeps full multiline
  commit messages.

## [0.8.14] - 2026-08-31

### Added

- `tests` summarizes a build's published test report. `--failed` prints every
  failing case with its message and full stack trace. Matrix builds are folded
  in from `childReports[]`. Each failure mode has a stable error code.
- Build JSON exposes `overheadMs`, the build time not attributed to any stage.
- "No jobs match" lists the closest jobs sharing any query token.

### Changed

- A job cache older than 24 hours is served immediately and refreshed by a
  detached background process. A missing or mismatched cache is fetched
  synchronously in every mode, so non-interactive runs no longer fail and
  demand `list --refresh`. A lock file prevents duplicate refresh workers.
- `logs` follows when stdout is a terminal and reads once when piped or
  redirected. `--follow` and `--no-follow` override.
- The ASCII banner is opt-in via `--banner`. Interactive commands show a compact
  intro with the CLI version and Jenkins target.
- The Homebrew formula infers its version from the tag.

### Performance

- Token migration checks cheap profile conditions before probing the OS keyring.

## [0.8.14-rc.4] - 2026-08-31

### Changed

- The ASCII intro banner is opt-in with `--banner`. Interactive commands show a
  compact intro with the CLI version and Jenkins target. `--json` output is
  unaffected.

## [0.8.14-rc.3] - 2026-08-30

### Changed

- An expired job cache is returned immediately and refreshed in a detached
  background worker. A missing or mismatched cache is fetched synchronously in
  every mode. A lock file stops duplicate background refreshes.

## [0.8.14-rc.2] - 2026-08-25

No CLI behaviour change.

### Changed

- The repo, its CI, and released binaries use Bun 1.4. Every `bun test` run
  passes `--isolate`.
- Added project icon, favicon, and social-preview assets, and rewrote the README
  intro.

## [0.8.14-rc.1] - 2026-08-18

### Added

- `tests` summarizes test results for a build. `--failed` prints failing cases
  with full stack traces, and `--json` returns the standard envelope. Missing,
  unavailable, denied, malformed, and transport-failed reports each get a
  stable error code.
- `status --json` and `wait --json` expose `overheadMs`.

### Changed

- `logs` follows by default only when stdout is a TTY, so
  `jenkins-cli logs ... > file.log` terminates.
- The Homebrew formula no longer pins `version`.
- The release workflow picks the channel from the tag: plain tags publish as
  stable and sync the Homebrew tap, semver prerelease tags publish as
  prereleases.

## [0.8.13] - 2026-08-12

### Added

- `logs --plain` strips ANSI sequences, concealed Jenkins metadata, and Pipeline
  framing. `--no-timestamps` recognizes ISO-8601 and `[HH:mm:ss]` prefixes,
  `--grep` accepts regular expressions, and `--context` adds surrounding lines.
- Exact-build `status` shows the job's current `ENABLED` or `DISABLED` state.
- Human output shows who or what triggered a build; JSON exposes `triggeredBy`.
- Human history output marks full pages with `(more available)`.

### Changed

- Human `status`, `history`, and `wait` output uses an unambiguous
  day-month-year start time.
- Releases are published as stable and marked latest. Before, every tag shipped
  as a prerelease, so the install script served an older binary than Homebrew.

### Fixed

- Log text filtering keeps partial lines isolated per Pipeline node, preserves
  CRLF boundaries split across chunks, and flushes buffered tails on cancel or
  error. `--jsonl` rejects text post-processing options.
- History pagination uses offset ranges with a lookahead entry and recovers when
  a controller or proxy ignores the range. Malformed or deleted builds no
  longer hide the next page.

## [0.8.11] - 2026-08-10

### Added

- `logs --plain`, `--no-timestamps` for ISO-8601 and `[HH:mm:ss]` prefixes,
  regular-expression `--grep`, and `--context`.
- Exact-build `status` shows the job's current `ENABLED` or `DISABLED` state.
- Human history output marks full pages with `(more available)`.

### Fixed

- Log text filtering handles partial lines per Pipeline node and CRLF split
  across chunks. `--jsonl` rejects text post-processing options.
- History pagination no longer hides the next page when builds are malformed or
  deleted concurrently.

## [0.8.10] - 2026-08-10

### Added

- Human build output shows a `By:` line with who or what triggered the build.
  `status`, `history`, and `wait` JSON include `triggeredBy`.

### Changed

- Build start times in `status`, `history`, and `wait` use a day-month-year
  format ("7 August 2026, 4:23:22 PM").

## [0.8.9] - 2026-08-09

### Added

- `status --json`, `history --json`, and `wait --json` expose `revisions[]` from
  Git-plugin checkout data: repository, remote URLs, branch, and commit SHA.
  Credentials embedded in HTTP(S) remotes are removed.
- Read-only profiles block builds, cancels, and reruns. `--confirm-protected`
  allows writes for one command.
- `list --active-only` shows enabled jobs with builds. Disabled jobs are marked,
  and JSON listings expose `disabled` and `lastBuild`.

### Fixed

- Long job names no longer push genuine substring matches below the match
  threshold.
- Unhandled promise rejections stay fatal when Sentry reporting is enabled, and
  Sentry transport failures cannot turn a failed command into a success.
- Boolean environment settings, non-interactive watch output, and the
  documented installer URL.

## [0.8.8] - 2026-08-08

### Added

- Read-only profiles: `auth login --profile <name> --protected` blocks builds,
  cancels, and reruns until `--confirm-protected` is passed for that run.
  Blocked runs exit non-zero, or emit `PROFILE_PROTECTED` with `--json`.
  `--no-protected` clears the flag.
- `list --active-only` shows only jobs with at least one build that are not
  disabled. Disabled jobs show as `<name> [disabled]`. `list --json` entries
  carry `disabled` and `lastBuild`.

### Changed

- The documented installer URL is the GitHub raw URL.

### Fixed

- `JENKINS_USE_CRUMB=1` was ignored; boolean environment parsing is consistent.
- `build --watch --non-interactive` no longer animates a spinner.

## [0.8.7] - 2026-08-01

### Added

- `logs --tail`, `--since`, `--stage`, `--stage-id`, and `--failed`.
  `--tail` with `--follow` prints history and then streams without duplicates.
- An interactive Logs flow to pick a build, a log view, and whether to follow.
- `--build <number>` on every build-scoped command: `status`, `wait`, `logs`,
  `artifacts`, `cancel`, and `rerun`.
- Job-scoped commands accept the job name positionally, such as
  `jenkins-cli status my-job`.
- `--json` and `--jsonl` across authentication, profiles, builds, queue and node
  inspection, logs, and artifacts.
- `status` reports whether a job is enabled or disabled, and JSON exposes
  `jobState`.
- Unexpected internal failures are reported to Sentry on a privacy-safe,
  best-effort basis.
- Homebrew install path: `brew install jatinbansal1998/tap/jenkins-cli`.

### Changed

- Windows release executables embed the Credential Manager helper.
- Release validation downloads and checksum-verifies the published assets on
  Windows, macOS, and Ubuntu and runs them against a real Jenkins.
- Successful login no longer prints shell export commands for API tokens.
- Jenkins failures surface sanitized controller details from `x-error`, JSON, or
  readable text and HTML responses.

### Fixed

- `watch` and `wait` track the selected build instead of switching to the latest
  run.
- Ctrl+C stops only the local log follow and never cancels the Jenkins build.
- Unsupported Pipeline or timestamp metadata gives an explicit capability error.
- Windows credential checks verify the secure-store backend that matches each
  artifact.

## [0.8.6] - 2026-07-29

### Added

- `--build <number>` on every build-scoped command, combinable with `--job` or
  `--job-url`.
- README badges, a demo, a table of contents, and the Homebrew tap install path.

### Changed

- Windows release executables embed the Credential Manager helper.
- Published Windows, macOS, and Ubuntu assets are checksum-verified and run
  against a real Jenkins before release.
- Successful login no longer prints shell export commands for API tokens.
- Refreshed GitHub Actions dependencies.

### Fixed

- `watch` and `wait` track the selected build instead of switching to the latest
  run.

## [0.8.3] - 2026-07-25

### Added

- Job-scoped commands accept the job name positionally. Conflicting positional
  and `--job` values fail validation.
- `--json` and `--jsonl` give one machine-readable contract across the command
  surface, including authentication, profiles, build controls, queue and node
  inspection, logs, and artifacts.

### Fixed

- `--json=true` and `--jsonl=true` are handled consistently. Help shortcuts with
  a structured-output flag reject the combination.

## [0.8.2] - 2026-07-24

### Added

- `status` reports a job's enabled or disabled state, and `--json` exposes
  `jobState`.

### Changed

- When Jenkins rejects a request, the CLI shows the controller's error message
  from `x-error`, a JSON body, or an HTML page, capped at 2,000 characters and
  stripped of terminal control sequences. Authentication failures keep
  `JENKINS_AUTH_ERROR`.

## [0.8.1] - 2026-07-23

### Added

- Unexpected internal errors are reported to Sentry by default. Disable with
  `JENKINS_ERROR_REPORTING_DISABLED=true`; override with `SENTRY_DSN` and
  `SENTRY_ENVIRONMENT`. Reporting never changes output, exit codes, or
  behaviour.
- A manual `Sentry Smoke Test` workflow and `bun run sentry:smoke` for live
  verification.

## [0.8.0] - 2026-07-23

### Added

- Secure token storage through macOS Keychain, Linux Secret Service, and Windows
  Credential Manager, with automatic plaintext-token migration and a
  `--no-keychain` opt-out.
- `auth status` and profile list, use, current, rename, delete, and logout.
- Inline Jenkins URL validation and browser-assisted login prompts.
- `params`, `run`, expanded cancellation, queue and node inspection, and
  protected artifact downloads.
- Searchable job and branch pickers with typo-tolerant matching and recent
  selections.
- `--json` output for `list`, `params`, `status`, `history`, and `wait`.

### Changed

- Secure-store account names are fixed-length, versioned identifiers derived
  from the profile and controller URL. Secure writes are transactional with
  verified reads and rollback.
- Compiled-CLI tests run against a real disposable Jenkins, Linux Secret
  Service, and macOS Keychain.

### Fixed

- Backspace and Delete in the interactive branch picker under Bun.

[Unreleased]: https://github.com/jatinbansal1998/jenkins-cli-ts/compare/v1.0.0-rc.5...HEAD
[1.0.0-rc.5]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v1.0.0-rc.5
[1.0.0-rc.4]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v1.0.0-rc.1
[0.8.16]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.16
[0.8.15]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.15
[0.8.15-rc.5]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.15-rc.5
[0.8.15-rc.4]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.15-rc.4
[0.8.15-rc.3]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.15-rc.3
[0.8.15-rc.2]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.15-rc.2
[0.8.15-rc.1]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.15-rc.1
[0.8.14]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.14
[0.8.14-rc.4]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.14-rc.4
[0.8.14-rc.3]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.14-rc.3
[0.8.14-rc.2]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.14-rc.2
[0.8.14-rc.1]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.14-rc.1
[0.8.13]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.13
[0.8.11]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.11
[0.8.10]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.10
[0.8.9]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.9
[0.8.8]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.8
[0.8.7]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.7
[0.8.6]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.6
[0.8.3]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.3
[0.8.2]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.2
[0.8.1]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.1
[0.8.0]: https://github.com/jatinbansal1998/jenkins-cli-ts/releases/tag/v0.8.0
