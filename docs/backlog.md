# Backlog: audit findings

Audit date: 2026-09-29, at v1.0.0-rc.1. Read-only code review plus a few
measurements of the built binary. Performance gains are estimates from reading
code unless marked "measured".

How to read this file:

- Every item has three parts. **Today** says what the code does now, with the
  file and line to look at. **Why it matters** says who feels it and how.
  **Do** says the concrete change.
- Items are grouped by area and ranked inside each group. P = performance,
  F = feature, H = hygiene (CI, tests, docs, repo).
- Tick items off as they ship. If an item turns out to be wrong or not worth
  doing, move it to "Rejected" at the bottom with a one-line reason.

## Measured baseline (Linux x64, `dist/jenkins-cli`)

| Command                                 | Time  | RSS  |
| --------------------------------------- | ----- | ---- |
| `--version`                             | 0.09s | 48MB |
| `--help`                                | 0.24s | 89MB |
| `auth current` warm                     | 0.12s | 60MB |
| `auth current` cold (hourly GitHub hit) | 0.60s | 60MB |
| Unit suite, 1021 tests / 97 files       | 82s   |      |
| Binary size                             | 89MB  |      |

Startup is fast enough and not the problem. The cost users feel is in how many
HTTP requests each command sends to Jenkins, and how often the local job-cache
file is read and rewritten. Most of the perf list below is one of those two.

## Performance

### Hot polling paths (biggest wins)

- [ ] **P1. Stage log streaming sends one request per stage, one after
      another, and repeats all of it every second.** - Today: `discoverPipelineGraph` in `src/pipeline-logs.ts:142-158` calls
      `wfapi/describe`, then loops over every stage and `await`s a
      `wfapi` node fetch for each one, even when the user passed `--stage X`
      and only wants one. Then `:78-79` fetches each step node's log the same
      way. In `logs --follow`, `src/commands/logs.ts:646` runs this whole
      discovery again on every 1s poll, and `:626` calls `getBuildStatus` on
      top. - Why it matters: a pipeline with 15 stages and 30 steps sends roughly
      45 sequential requests per second while following. On a slow or busy
      controller the follow loop falls behind and the CLI looks frozen. It
      also hammers Jenkins. - Do: when `--stage` or `--stage-id` is given, fetch only that stage's
      node. For `--failed`, fetch only the failed stage. Fetch the remaining
      nodes with `Promise.all` capped at ~6 in flight. Remember each node's
      `consoleUrl` after the first fetch so the log body is not re-fetched.
      In follow mode, call `describe` once per poll and re-run discovery
      only when a stage id or status actually changed.

- [ ] **P2. Every status poll makes 2-4 serial round trips and re-downloads
      data that never changes.** - Today: `getBuildStatus` (`src/jenkins/client.ts:400-424`) fetches build
      details, then waits, then fetches `wfapi/describe`, then maybe
      `queue/item/N`. `getJobStatus` (`:288-324`) adds the job fetch in front
      of that, so 3-4 sequential requests. The build-details query
      (`BUILD_DETAILS_FIELDS`, `:1803`) asks for parameters, git revisions,
      remote URLs and causes every time. Freestyle jobs get a 404 from `wfapi`
      on every poll. In the logs follow loop, `logs.ts:506` calls
      `getBuildStatus` every second just to learn whether the build is still
      running, even though `progressiveText` already returns an
      `X-More-Data` header saying exactly that (`client.ts:1230`). - Why it matters: `wait`, `build --watch`, `status`, `logs --follow` all
      sit on this path. Each poll takes the sum of 3-4 latencies instead of
      the max of them, so on a 200ms controller a poll costs ~800ms of pure
      waiting. - Do: run build details and `wfapi` in parallel with `Promise.all`. Add a
      light poll query, `api/json?tree=building,result,duration,estimatedDuration,number`.
      Cache the static metadata (parameters, causes, queue wait) per build URL
      on the client instance after the first fetch. Remember "wfapi not
      supported" per build so freestyle jobs stop hitting the 404. In the
      logs follow loop, rely on `X-More-Data` and fetch status only once it
      goes false.

- [ ] **P3. `getJobStatus` is called in a dozen places that only need the last
      build number.** - Today: these call sites read only `buildNumber`, `building` or
      `buildUrl` from the result, but pay for the full 3-4 request chain in
      P2: `build.ts:275, 651, 1096, 1206, 1240`, `logs.ts:314`,
      `wait.ts:309, 444, 525`, `watch-utils.ts:151`, `cancel-core.ts:334`,
      `input.ts:357`. In `wait.ts:444` and `build.ts:1206` the queued-state
      loop does this every 5s. - Why it matters: `build` waits for this chain before it even sends the
      trigger request, so every build start is 2-3 round trips slower than
      it needs to be. - Do: add `getLastBuildSummary()` on the client that sends one request,
      `api/json?tree=lastBuild[number,building,result,url]`, and switch the
      call sites above to it. `getLastBuild` at `client.ts:527` is a starting
      point.

- [ ] **P4. The job cache file is read about 4 times and fully rewritten about
      2 times per command, with no lock.** - Today: the whole `jobs-*.json` file is read, parsed and normalized
      separately by `loadJobs` (`jobs.ts:150`), `loadPreferredJobs`
      (`recent-jobs.ts:37`), `recordRecentJob` (`recent-jobs.ts:67`, then
      rewrites the file), `getKnownStageTotal` (`stage-count-cache.ts:25`),
      `recordKnownStageTotal` (`stage-count-cache.ts:52`, another rewrite),
      and `branches.ts:27, 53, 81` (more rewrites). Writes are pretty-printed
      with `JSON.stringify(cache, null, 2)` (`jobs.ts:300`).
      `recordKnownStageTotal` writes even when the value did not change.
      `wait.ts:436` and `:542` only cache the stage total once it is found,
      so when the job has no stored value the whole file is re-read on every
      poll. Nothing locks the file; the only lock in the codebase is on
      `update-state.json`. - Why it matters: with a few thousand jobs the file is megabytes. A single
      `status --job X` parses it four times and writes it twice. The
      background refresh process and a foreground command can overwrite each
      other's changes and lose recent-job or branch history. - Do: load the cache once per invocation and pass it around (a memo on
      the command context). Move the small, frequently written user state
      (recent jobs, stage totals, branch history) into a separate small file
      so the big job list is read-only during normal commands. Write compact
      JSON. Skip writes that change nothing. Remember "looked up, not found"
      so the poll loop stops re-reading. Use read-modify-write under a lock
      for the small state file.

- [x] **P11. `help --json` and `help --full` start 33 copies of the 89MB
      binary.** - Today: `src/cli/full-help.ts:103` spawns one child process per entry
      in `FULL_HELP_COMMANDS` (33 of them), all at once, and each child runs
      full startup including the min-version refresh (P12). - Why it matters: `help --json` is the command agents call most, and it
      is the slowest one in the CLI. When the hourly update TTL has expired,
      33 children race on the same GitHub fetch and the same lock file. - Do: generate help in-process (build the yargs parser once, call
      `getHelp()` per command), or generate the catalog at build time and
      embed it in the binary.

### Job list and picker

- [ ] **P5. Merging branches into the refreshed job list is O(n²).** - Today: `mergeCachedBranches` (`jobs.ts:483-490`) calls `findJobByUrl`
      for every fetched job. `findJobByUrl` (`job-url.ts:28-33`) is a linear
      `.find`, and each comparison trims, runs a regex replace and lowercases
      both sides. - Why it matters: at 5k jobs that is 12-25 million string comparisons on
      every `list --refresh`, every cache miss, and every background refresh.
      Seconds of CPU. - Do: build one `Map` keyed by normalized URL from the existing cache,
      then look up each fetched job in O(1).

- [ ] **P6. The interactive job picker re-ranks every job about 3 times per
      keypress, including arrow keys.** - Today: `job-picker.ts:52-66` passes `options` to clack as a function.
      clack's `get options()` calls it on every access: in the key handler
      (every key, including up/down), in the input handler, and in render.
      Each call runs `rankJobs`, which normalizes every candidate string
      (two regex replaces), splits tokens and does the fuzzy match. - Why it matters: with thousands of jobs, typing in the picker lags and
      arrow-key navigation stutters. - Do: pre-normalize candidates and tokens once per jobs array (a
      `WeakMap` keyed on the array). Memoize the last query and its result so
      repeated calls with the same input are free. For an empty query return
      only the top `maxItems` preferred jobs instead of mapping all N.

- [ ] **P7. Commands that only read the local cache still unlock the
      keychain.** - Today: `src/index.ts:170` resolves the API token for every contextual
      command before it runs. `list` served from a fresh cache and the job
      picker never contact Jenkins, so they never need it. On first use
      `cross-keychain` checks all 8 backend types, scans `PATH` for
      `secret-tool` and `security`, and loads its native addon. - Why it matters: on macOS this can pop a Keychain prompt for a command
      that never talks to Jenkins. On Linux it is a D-Bus round trip per run. - Do: give `JenkinsClient` a lazy token provider that resolves on the
      first HTTP request. For `scheduleBackgroundRefresh`, resolve only when
      the cache is actually stale. Pick the platform backend directly with
      `useBackend("native-linux" | "native-macos" | "native-windows")` and
      fall back to detection only if that fails.

- [ ] **P10. `listRunningBuilds` walks the entire job tree to find a handful
      of running builds.** - Today: `client.ts:160-190` fetches the depth-3 nested tree of every
      job, plus extra requests for deeper folders, then filters for
      `building`. - Why it matters: `run` gets slower in proportion to how many jobs the
      controller has, not how many builds are running. - Do: query executors instead:
      `computer/api/json?tree=computer[executors[currentExecutable[url,number,building,fullDisplayName,timestamp]],oneOffExecutors[currentExecutable[...]]]`.
      Cost then scales with executors. Pipeline builds appear under
      `oneOffExecutors`.

- [ ] **P13. Folders deeper than `folderDepth` are fetched one at a time.** - Today: `client.ts:192-222` and `:236-266` `await` each folder's request
      inside a loop. - Why it matters: deep folder trees on a slow controller take the sum of
      all latencies during `list --refresh`. - Do: gather the unexpanded folders at each level and fetch them with
      capped concurrency (~6).

### Logs

- [ ] **P8. `logs --tail` and `logs --since` download the whole log; `--since`
      downloads it twice.** - Today: `readSnapshot` (`logs.ts:427-430`, `:775-798`) pulls the full
      log with `value += chunk.text` just to keep the last N lines. For
      `--since`, `:452-455` then calls `timestamps/?appendLog=true`, which
      returns the whole log again. The two timestamp calls at `:442` and
      `:452` are independent but run one after the other. `tailLogLines`
      (`log-filters.ts:122-133`) splits the entire log into an array and
      joins the discarded part just to count its bytes. - Why it matters: a 50MB console log means 50-100MB downloaded and held
      in memory to show 20 lines. - Do: for tail, get the total size from `progressiveText?start=<huge>`,
      which returns an empty body plus `X-Text-Size`, then read backwards in
      growing windows (64KB, 256KB, ...) until N newlines are found. For
      since, skip the full snapshot and use the `appendLog` response alone.
      Run the two timestamp calls in parallel. Count skipped bytes as
      `byteLength(text) - byteLength(tail)` using `lastIndexOf("\n")`.

- [ ] **P9. The interactive `logs` build picker fetches pipeline details for
      10 builds and shows none of it.** - Today: `logs.ts:285-289` calls `listBuildHistory(limit 10)`. That
      method (`client.ts:484-495`) also calls `wfapi/describe` per build, and
      a stage-node fetch for failed ones. `formatInteractiveBuildLabel`
      (`logs.ts:938-945`) only displays number, result and building. - Why it matters: 10-20 wasted requests before the picker appears. - Do: add an `enrich: false` option to `listBuildHistory`, or a separate
      method that runs only the `builds[...]{0,10}` tree query.

- [ ] **P19. Pipeline graph building has quadratic loops.** - Today: `pipeline-logs.ts:223` uses `graph.find` for every added node.
      `isDescendantOf` (`:342-361`) rebuilds a `byId` map for every node
      inside the filter at `:61-69`, and uses `pending.shift()`. - Why it matters: only noticeable on pipelines with hundreds of steps. - Do: build one `Map` at the start and reuse it.

### Startup and background work

- [x] **P12. The minimum-version check runs even for `--version`, `--help`
      and `--json`, and can hold the process open.** - Today: `index.ts:99` calls `kickOffMinimumVersionRefresh` with no skip
      list, unlike `shouldSkipAutoUpdate` (`update.ts:414-431`) which does
      skip those. The timeout timer is `unref`'d (`with-timeout.ts:13-15`)
      but a pending `fetch` keeps the process alive, so up to two GitHub
      fetches can delay exit of a fast command by up to 800ms each time the
      1-hour TTL expires. `update-state.json` is read three times per start
      (`min-version-policy.ts:73`, `:126`, `update.ts:436`). Measured via
      strace. - Why it matters: this is the 0.60s cold `auth current` in the baseline
      table. Scripts that call the CLI in a loop hit it once an hour. - Do: read the state file once and share it. Hand the refresh off to a
      detached child process, the same way `jobs.ts:203-221` already does
      for the job cache, so the foreground never waits. Skip the refresh for
      `--version`, `--help` and `--json`.

- [x] **P15. The binary is built without bytecode or minification.** - Today: neither `bytecode: true` nor `minify: true` is set in
      `scripts/build.ts:66-76` or `scripts/build-local.ts:24-34`. The bundle
      is ~1.47MB of JS source that is parsed on every start. - Why it matters: a parse-time win of maybe 10-30ms per invocation. Not
      measured. The 89MB binary size is the Bun runtime and will not shrink. - Do: try `bytecode: true` and `minify: true`. `src/index.ts` ends in a
      top-level `await main()`; Bun's bytecode mode has historically needed
      CommonJS output, so check Bun 1.4 supports ESM bytecode or wrap the
      entry in an IIFE. - Shipped: `bytecode`, `minify` and `format: "esm"`
      (Bun 1.4 supports ESM bytecode). Measured: `--version` 96ms to 47ms,
      `--help` 234ms to 185ms. Binary grew 89MB to 92MB.

- [ ] **P20. The config file is parsed three times per run.** - Today: `getDebugDefault` (`env.ts:250`, called from middleware),
      `loadEnv` (`env.ts:102`) and `maybeMigrateToken`
      (`token-migration.ts:72`) each read and parse it. - Why it matters: small, but it is on every command. - Do: read it once and pass it along.

- [ ] **P21. musl detection reads the entire binary into a string.** - Today: `update.ts:86` reads `/proc/self/exe` as latin1, lowercases it,
      and searches for "musl". It only runs when both `ldd` probes fail, in
      the update path. - Why it matters: holds ~100MB in memory twice for a yes/no answer. - Do: `BUILD_TARGET` already records whether the binary is a musl build.
      Use it, or check for `/lib/ld-musl-*.so.1`.

### HTTP client

- [x] **P17. Retries fire immediately, and also after a timeout.** - Today: `client.ts:1487-1490` retries with no delay, and retries after
      an `AbortError` timeout too, so worst case is 2 x 10s = 20s. - Why it matters: immediate retry on a 503 usually gets another 503. A
      retry after a timeout doubles the wait for nothing. - Do: jittered backoff (~200-500ms). Do not retry after a header
      timeout. Keep retrying GETs on 502/503/504. Non-idempotent POSTs
      already never retry; keep that.

- [ ] **P14. Multi-job `status` fetches each job one after another.** - Today: `status.ts:118-190` awaits `recordRecentJob`, then
      `getJobStatus`, then a cache read and write, per target. - Why it matters: `status` with 5 jobs selected takes 5x the single-job
      latency. - Do: fetch all statuses with capped `Promise.all`, print in order,
      record recent jobs once at the end.

- [ ] **P18. Debug logging does string work even when debug is off; log
      pruning runs on every exit.** - Today: `logApiRequest`, `logApiResponse`, `logApiError`
      (`logger.ts:216-257`) build a timestamp and format headers before
      `logBlock` checks `debugMode`. `pruneOldLogs` (`logger.ts:102-135`)
      does a sync `readdirSync` plus `statSync` on every exit
      (`index.ts:309`). - Why it matters: small per-request overhead on every HTTP call. - Do: early-return when debug is off. Prune once a day using a stamp
      file or the mtime of today's log.

### Tests

- [ ] **P16. The unit suite takes 82s for 1021 tests.** - Today: measured with `bun run test`. Not profiled yet. Suspects are
      real sleeps, the compiled-CLI spawns in `compiled-cli.test.ts`, and the
      integration harness tests. - Why it matters: slow local feedback and slow CI. - Do: run `bun test --isolate` per file with timing, list the top 10
      slowest, and attack those.

### Already good, do not re-recommend

`tree=` on every JSON query. History uses `{offset,end}` ranges. One nested
depth-3 query lists jobs. Log streaming uses `start` offsets and reads
`X-Text-Size` / `X-More-Data` correctly. Crumbs are cached per client with one
retry on 403. Non-idempotent POSTs never retry. Artifacts stream to disk with
backpressure. The stale job cache is refreshed by a detached background process
under a lock with a 24h TTL. `--grep` is compiled once. Bun keep-alive and gzip
are untouched.

## Features

Context: open roadmap issue #120 is 6 of 7 done. Its body still shows unticked
boxes for `tests` and `changes` although #123 and #124 are closed. `plans/` is
empty. There are no TODO or FIXME comments in source.

### High value

- [ ] **F1. Shell completion for bash, zsh and fish.** - Today: no `.completion()` call in `src/index.ts` or `src/cli/*`, no
      `completion` command. Issue #126, the only open roadmap item. - Why it matters: users type job names, profile names and option names
      by hand or from `--help`. Completion is the most requested feature of
      any CLI. - Do: `jenkins-cli completion bash|zsh|fish` prints a script;
      `completion check <shell>` diagnoses installation. Complete commands,
      nested `auth` and `input` subcommands, options, enum values and local
      profile names. Never contact Jenkins or read the keychain during
      completion.

- [ ] **F2. Multibranch and organization-folder jobs are invisible to `list`
      and the picker.** - Today: `collectFolderJobs` (`client.ts:197`) only descends into
      `com.cloudbees.hudson.plugins.folder.Folder`.
      `tests/folder-discovery.test.ts:336-361` asserts that multibranch
      children do not appear. A branch job is reachable only via `--job-url`. - Why it matters: most modern Jenkins setups are multibranch pipelines.
      For those users the job picker shows the parent and nothing under it. - Do: descend into `WorkflowMultiBranchProject` and
      `OrganizationFolder` the same way as folders, and show branch jobs as
      `repo/branch`. Update the discovery test to expect them.

- [ ] **F3. `--build` accepts only a number.** - Today: `options.ts:94` parses `--build` as an integer. The client uses
      `lastBuild`, `lastCompletedBuild` and `lastFailedBuild` internally but
      never exposes them. - Why it matters: "show me the logs of the last successful build" is a
      daily task and today needs two commands. - Do: accept `--build lastSuccessful|lastStable|lastFailed|lastCompleted`
      on every build-scoped command, resolved through the existing selector.

- [ ] **F4. `history` is fixed at 5 rows and `list` has no limit.** - Today: `HISTORY_PAGE_SIZE = 5` (`history.ts:22`), only `--offset`.
      `configureListOptions` has search, refresh, active-only and json but
      no `--limit`. - Why it matters: scripts and agents have to page 5 at a time. - Do: add `--limit` to both.

- [ ] **F5. File parameters are not supported.** - Today: `triggerBuild` (`client.ts:1259`) sends `URLSearchParams` only.
      There is no `FileParameterDefinition` handling in `job-parameters.ts`
      or `interactive-job-parameters.ts`. - Why it matters: jobs with a file parameter cannot be triggered from the
      CLI at all. - Do: detect file parameters and send `multipart/form-data` with the
      file and the `json` field Jenkins expects.

- [ ] **F6. Pipeline `input` steps with parameters cannot be approved.** - Today: `assertParameterlessApproval` (`input.ts:586`) rejects any input
      that takes parameters with `INPUT_PARAMETERS_UNSUPPORTED`. Listed as a
      non-goal in #127. - Why it matters: approval gates that ask "which environment?" are
      common, and the CLI sends the user back to the browser for them. - Do: prompt for the parameters (or accept `--param`), and submit them
      through `wfapi/inputSubmit`.

- [ ] **F7. HTTP timeout and retry count are hardcoded.** - Today: `options.timeoutMs ?? 10_000` in `client.ts:123`; `index.ts:172`
      never passes it. Retries default to 1 (`client.ts:1337`). No env key
      or flag for either. `src/env-keys.ts` has only 6 keys. - Why it matters: slow controllers behind VPNs time out at 10s with no
      way to raise it. - Do: add `JENKINS_TIMEOUT_MS` and `--timeout`, plus a profile field,
      and pass it through.

- [ ] **F8. No TLS or proxy options, and the ones Bun already honors are
      undocumented.** - Today: no `--insecure`, `--ca-cert` or proxy flags. Bun's `fetch`
      honors `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`, but nothing in the
      README says so. - Why it matters: corporate Jenkins behind a private CA or a proxy is
      the normal case, and users cannot tell whether it is supported. - Do: document the two env vars now. Add `--ca-cert` and `--insecure`
      (with a loud warning) as profile fields.

- [ ] **F9. No `NO_COLOR`, `--no-color` or `--quiet`.** - Today: color is decided only by the TTY check inside
      `util.styleText`. No `--quiet` among the global options in
      `options.ts`. - Why it matters: `NO_COLOR` is a widely followed convention; CI logs
      and some terminals need it. `--quiet` matters for scripts that only
      care about exit codes. - Do: honor `NO_COLOR` and `FORCE_COLOR`, add `--no-color` and
      `--quiet`.

- [ ] **F10. The config directory cannot be moved.** - Today: `CONFIG_DIR` is always `~/.config/jenkins-cli`
      (`config.ts:10`). No `XDG_CONFIG_HOME`, `%APPDATA%` on Windows, or a
      `--config` / `JENKINS_CLI_CONFIG` override. - Why it matters: shared machines, CI runners and Windows users expect
      the platform convention, and tests have to monkeypatch `HOME`. - Do: honor `XDG_CONFIG_HOME` and `%APPDATA%`, and add a
      `JENKINS_CLI_CONFIG_DIR` override.

- [ ] **F11. Exit codes are only defined for `wait`.** - Today: `wait` documents 0/1/124/130. Every other command exits 0 or 1
      for everything, including auth failures and not-found. - Why it matters: scripts cannot tell "job does not exist" from "token
      rejected" without parsing text. - Do: define a small table (auth, not found, protected profile, Jenkins
      error, usage error), apply it everywhere, and document it in the
      README.

- [ ] **F12. No `open` command.** - Today: only `run` opens a browser
      (`register-operations-commands.ts:1091`). - Why it matters: "open this build in the browser" is a two-second task
      that today requires copying a URL. - Do: `jenkins-cli open --job X [--build N]` using the existing browser
      helper.

- [ ] **F13. `tests` cannot compare with the previous build.** - Today: `src/commands/tests.ts` shows one build only. - Why it matters: "which tests started failing in this build" is the
      actual question. - Do: add `--diff` that fetches the previous completed build's report
      and shows newly failed, newly fixed.

- [ ] **F14. No force-kill for stuck builds.** - Today: only `<build>/stop` (`client.ts:917`). Jenkins also offers
      `/term` and `/kill` for pipelines that ignore stop. - Why it matters: a hung pipeline cannot be killed from the CLI. - Do: `cancel --force` escalates stop, then term, then kill.

### Windows

- [ ] **F15.** The `install` script refuses Windows and there is no
      `install.ps1`, winget or scoop manifest. Users download the exe by hand.
- [ ] **F16.** `update` is a no-op on Windows (`update.ts:355`, "not yet
      perfectly supported").
- [ ] **F17.** No Windows arm64 binary in `release.yml`.
- [ ] **F18.** CI skips `compiled-cli.test.ts` on Windows (`ci.yml`), so the
      Windows binary is never exercised end to end.

### Deliberately deferred (per #120, leave unless asked)

Job enable/disable/delete/rename, applying `config.xml`, node online/offline,
credentials management, plugin install, script console, safe-restart and
quiet-down, replay and restart-from-stage, views, fingerprints, artifact
upload, bearer/OIDC/mTLS auth.

## Hygiene: CI, tests, docs, repo

- [ ] **H1. No coverage threshold.** - Today: `bunfig.toml` has no `coverageThreshold`. `verify` generates
      coverage but never fails on it. - Do: set a floor at the current number and raise it over time.

- [ ] **H2. CodeQL does not gate PRs.** - Today: `codeql.yml` runs weekly and on manual dispatch only. - Do: add `pull_request` trigger.

- [ ] **H3. No automated dependency updates.** - Today: no `.github/dependabot.yml` or Renovate config. - Do: add Dependabot for npm and GitHub Actions, weekly.

- [ ] **H4. CI matrix is x64 only.** - Today: arm64 binaries are only built at release, never tested. - Do: add an arm64 runner to `ci.yml` for at least the compiled-CLI test.

- [ ] **H5. Integration tests run one Jenkins version.** - Today: a single `jenkins:lts-jdk21` image with pinned
      `tests/integration/jenkins/plugins.txt`. - Do: add one older LTS to the matrix so API regressions show up.

- [ ] **H6. Doc-only changes skip CI entirely, and there is no markdown
      check.** - Today: `pull-request.yml` and `post-merge.yml` use `paths-ignore` for
      `**/*.md` and `docs/**`. `paths-ignore` still lists
      `fuzzy-search-docs/**`, which no longer exists. This very file was
      pushed to `main` without any run. - Do: run at least `format:check` and a link check on doc changes.
      Remove the stale path.

- [ ] **H7. Load tests have no baseline.** - Today: `jenkins-load.yml` is `workflow_dispatch`, ubuntu only, and
      nothing compares results across runs. - Do: store the numbers as a workflow artifact and diff against the
      previous run.

- [ ] **H8. Standard repo files missing.** - Today: no `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
      `.github/ISSUE_TEMPLATE/` or PR template. - Do: add them. CHANGELOG can be generated from release notes.

- [ ] **H9. JSON output shapes are undocumented.** - Today: discoverable only through `help --json`. No page for the
      config file fields or the env vars either. - Do: a `docs/json-output.md` and `docs/configuration.md`.

- [ ] **H10. TUI state diagrams can drift from code.** - Today: `docs/tui-state-diagrams.md` is hand-maintained from
      `src/flows/definition.ts` with no check. - Do: generate it from the definition in a script and diff in CI.

- [ ] **H11. Expected user errors are logged as errors.** - Today: `auth current` with no config writes a "Missing JENKINS_URL"
      stack trace to `~/.config/jenkins-cli/error-*.log` on every run.
      Measured. - Why it matters: the error log fills with noise and a real crash is
      hard to find. - Do: only log unexpected errors (not `CliError` with a known code).

- [ ] **H12. Issue #120 body is stale.** - Today: shows unticked boxes for `tests` and `changes`, both shipped. - Do: edit the issue.

## Suggested order

1. P1, P2, P3, P4, P11. All in the hot polling paths or the most-called
   command. Biggest user-visible wins.
2. F1 (completion), F2 (multibranch), F3 (`--build` aliases).
3. H6, H11, H1 as cheap hygiene wins.

## Rejected

(none yet)
