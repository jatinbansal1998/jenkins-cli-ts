# Backlog: audit findings

Audit date: 2026-09-29, at v1.0.0-rc.1. Read-only code review plus a few
measurements of the built binary. Performance gains are estimates from code
reading unless a number is marked "measured".

Tick items off as they ship, and move anything that turns out to be wrong to
the "Rejected" section at the bottom with a one-line reason.

## Measured baseline (Linux x64, `dist/jenkins-cli`)

| Command                                 | Time  | RSS  |
| --------------------------------------- | ----- | ---- |
| `--version`                             | 0.09s | 48MB |
| `--help`                                | 0.24s | 89MB |
| `auth current` warm                     | 0.12s | 60MB |
| `auth current` cold (hourly GitHub hit) | 0.60s | 60MB |
| Unit suite, 1021 tests / 97 files       | 82s   |      |
| Binary size                             | 89MB  |      |

Startup is fine. The cost is per-command network chatter and job-cache churn.

## Performance

Ranked by user-visible impact.

- [ ] **P1. Stage logs are serial and re-discovered every poll.**
      `src/pipeline-logs.ts:142-158` awaits every stage's `wfapi` node one by
      one, even with `--stage`. `logs --follow` reruns discovery every 1s
      (`src/commands/logs.ts:646`). 15 stages / 30 steps is ~45 sequential
      requests per second. Fix: fetch only the requested stage, `Promise.all`
      the rest (cap ~6), keep `consoleUrl` per node, re-discover only when
      `describe` shows a new or changed stage.
- [ ] **P2. `getBuildStatus` / `getJobStatus` do 2-4 serial round trips per
      poll** (`src/jenkins/client.ts:400-424`, `:288-324`) and re-download
      parameters, git revisions, causes that never change. `wait`,
      `build --watch`, `logs --follow` pay this each tick. Freestyle jobs get a
      `wfapi` 404 every poll. Fix: parallelize build details + `wfapi`, add a
      light `tree=building,result,number` poll, cache static metadata and
      "wfapi unsupported" per build URL on the client. In the logs follow loop
      rely on `X-More-Data` and only fetch status once it goes false.
- [ ] **P3. `getJobStatus` used where only the last build number is needed.**
      Call sites: `build.ts:275,651,1096,1206,1240`, `logs.ts:314`,
      `wait.ts:309,444,525`, `watch-utils.ts:151`, `cancel-core.ts:334`,
      `input.ts:357`. Add `getLastBuildSummary()` doing one request with
      `tree=lastBuild[number,building,result,url]`.
- [ ] **P4. Job cache file read ~4x and fully rewritten ~2x per command.**
      Readers/writers: `jobs.ts:150`, `recent-jobs.ts:37,67`,
      `stage-count-cache.ts:25,52`, `branches.ts:27,53,81`. Pretty-printed,
      no lock, `recordKnownStageTotal` writes even when unchanged, and
      `wait.ts:436` re-reads the whole file every poll when the job has no
      stage entry. Fix: load once per invocation, split small user state
      (recent jobs, stage totals, branches) from the big job list, compact
      JSON, skip no-op writes, lock the state file.
- [ ] **P5. `mergeCachedBranches` is O(n²)** (`jobs.ts:483-490`). Linear
      `findJobByUrl` with regex + lowercase per comparison, per job. Seconds at
      5k jobs on every refresh. Build a `Map` keyed by normalized URL.
- [ ] **P6. Job picker re-ranks every job ~3x per keypress, including arrow
      keys.** `job-picker.ts:52-66` passes `options` as a function; clack calls
      it on every access (key handler, input handler, render). Pre-normalize
      candidates once per jobs array, memoize the last query result, return
      only top `maxItems` for an empty query.
- [ ] **P7. Cache-only commands still resolve the keychain token**
      (`index.ts:170`). `cross-keychain` probes 8 backends and scans PATH on
      first use. Make the token lazy on the client; pick the platform backend
      directly with `useBackend`.
- [ ] **P8. `logs --tail` / `--since` download the whole log; `--since` twice**
      (`logs.ts:427-455`, `log-filters.ts:122-133`). Probe `X-Text-Size` with
      a huge `start`, read backwards in growing windows, run the two timestamp
      calls in parallel.
- [ ] **P9. Interactive `logs` build picker fetches `wfapi` for 10 builds and
      shows none of it** (`logs.ts:285`, `client.ts:484-495`). Add a
      non-enriched history query.
- [ ] **P10. `listRunningBuilds` walks the whole job tree**
      (`client.ts:160-190`). Query `computer/api/json` executors and
      `oneOffExecutors` instead; cost scales with executors, not jobs.
- [ ] **P11. `help --json` / `help --full` spawn 33 copies of the binary**
      (`src/cli/full-help.ts:103`). Each child runs full startup including the
      min-version refresh. Generate help in-process via yargs or embed a
      build-time catalog. Agents call this command most.
- [ ] **P12. Min-version refresh runs for `--version` / `--help` / `--json`**
      (`index.ts:99`; `shouldSkipAutoUpdate` in `update.ts:414` has a skip list,
      `kickOffMinimumVersionRefresh` does not). A pending fetch keeps the
      process alive up to 800ms once per hour. `update-state.json` is read 3x
      per start (measured via strace). Hand off to a detached child like the
      job-cache refresh, read state once.
- [ ] **P13. Folders deeper than `folderDepth` fetched one at a time**
      (`client.ts:192-222`, `:236-266`). Gather per level, fetch with capped
      concurrency.
- [ ] **P14. Multi-job `status` fetches each job serially**
      (`status.ts:118-190`). Capped `Promise.all`, print in order, record
      recent jobs once.
- [ ] **P15. Build flags.** Neither `bytecode: true` nor `minify: true` in
      `scripts/build.ts:66` / `build-local.ts:24`. Parse-time win only; binary
      size is the Bun runtime. Check Bun 1.4 ESM bytecode support first
      (`src/index.ts` uses top-level `await`).
- [ ] **P16. Test suite 82s.** Not profiled. Suspects: real sleeps, compiled
      CLI spawns in `compiled-cli.test.ts`, integration harness tests.
- [ ] **P17. Retries fire immediately, also after timeouts** (`client.ts:1487`).
      Worst case 2 x 10s. Add jittered backoff, don't retry after header
      timeout.
- [ ] **P18. `logApi*` build strings before checking `debugMode`**
      (`logger.ts:216-257`); `pruneOldLogs` does sync readdir+stat on every
      exit (`index.ts:309`). Early-return when debug off; prune once a day.
- [ ] **P19. Pipeline graph building is O(n²)** (`pipeline-logs.ts:223`,
      `isDescendantOf` at `:342-361`). Keep one `Map`.
- [ ] **P20. Config file parsed 3x per run** (`env.ts:250`, `env.ts:102`,
      `token-migration.ts:72`).
- [ ] **P21. musl detection reads the whole binary into a string**
      (`update.ts:86`). Use `BUILD_TARGET` or check `/lib/ld-musl-*`.

Already good, do not re-recommend: `tree=` on every query; single depth-3
folder query; progressiveText offsets with `X-Text-Size`/`X-More-Data`; crumb
caching with one 403 retry; no transport retry on non-idempotent POSTs; streamed
artifact downloads; detached background cache refresh with lock and 24h TTL;
`--grep` compiled once; Bun keep-alive and gzip untouched.

## Features

Open roadmap #120 is 6/7 done. Its body still shows unticked boxes for
`tests` / `changes` although #123 / #124 are closed. `plans/` is empty. No
TODO/FIXME in source.

### High value

- [ ] **F1. Shell completion** (bash/zsh/fish). Issue #126, the only open
      roadmap item. No `.completion()` in `src/index.ts` or `src/cli/*`.
- [ ] **F2. Multibranch / organization-folder jobs invisible to `list` and the
      picker.** `collectFolderJobs` (`client.ts:197`) only descends into plain
      Folders; `tests/folder-discovery.test.ts:336-361` asserts multibranch
      children are excluded. Reachable only via `--job-url`.
- [ ] **F3. Build aliases** `--build lastSuccessful|lastStable|lastFailed`.
      `--build` is numeric only (`options.ts:94`).
- [ ] **F4. `history --limit`.** Page size fixed at 5 (`history.ts:22`).
      `list --limit` also missing.
- [ ] **F5. File parameters.** `triggerBuild` is form-encoded only
      (`client.ts:1259`); no `FileParameterDefinition` handling.
- [ ] **F6. Parameterized pipeline input approval** rejected at
      `input.ts:586` (`INPUT_PARAMETERS_UNSUPPORTED`). Non-goal in #127.
- [ ] **F7. Configurable HTTP timeout and retry.** Timeout hardcoded 10s
      (`client.ts:123`), never passed from `index.ts:172`. No env key or flag.
- [ ] **F8. TLS / proxy options.** No `--insecure`, `--ca-cert`, proxy flags.
      Bun honors `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`; undocumented.
- [ ] **F9. `NO_COLOR` / `--no-color` / `--quiet`.** Not handled; relies on
      the TTY check in `util.styleText` only.
- [ ] **F10. Config dir override.** Fixed `~/.config/jenkins-cli`
      (`config.ts:10`). No `XDG_CONFIG_HOME`, `%APPDATA%`, `--config`.
- [ ] **F11. Exit code table.** Only `wait` documents codes (0/1/124/130).
      Everything else exits 0 or 1.
- [ ] **F12. `open` command** for job/build in the browser. Only `run` opens
      one (`register-operations-commands.ts:1091`).
- [ ] **F13. Test result diff vs previous build.** `tests` shows one build
      only.
- [ ] **F14. Force-kill escalation** `/term`, `/kill` after `/stop`
      (`client.ts:917`).

### Windows

- [ ] **F15.** `install` script refuses Windows; no `install.ps1`, winget,
      scoop.
- [ ] **F16.** `update` is a no-op on Windows (`update.ts:355`).
- [ ] **F17.** No Windows arm64 binary (`release.yml`).
- [ ] **F18.** CI skips `compiled-cli.test.ts` on Windows (`ci.yml`).

### Deliberately deferred (per #120, leave unless asked)

Job enable/disable/delete/rename, config.xml apply, node online/offline,
credentials, plugin install, script console, safe-restart/quiet-down, replay /
restart-from-stage, views, fingerprints, artifact upload, bearer/OIDC/mTLS auth.

## CI, tests, docs, repo hygiene

- [ ] **H1.** No coverage threshold in `bunfig.toml`; `verify` measures but
      never enforces.
- [ ] **H2.** CodeQL is weekly only, does not gate PRs (`codeql.yml`).
- [ ] **H3.** No Dependabot / Renovate.
- [ ] **H4.** CI matrix is x64 only; arm64 built only at release.
- [ ] **H5.** Integration tests run one Jenkins LTS image; no version matrix.
- [ ] **H6.** Doc-only PRs skip CI (`paths-ignore`); no markdown or link
      check. `paths-ignore` still lists nonexistent `fuzzy-search-docs/**`.
- [ ] **H7.** Load test workflow is manual, no baseline or regression tracking.
- [ ] **H8.** Missing `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
      issue / PR templates.
- [ ] **H9.** JSON output schemas undocumented outside `help --json`; no page
      for config file fields or env vars.
- [ ] **H10.** `docs/tui-state-diagrams.md` hand-maintained from
      `src/flows/definition.ts`, no drift check.
- [ ] **H11.** `auth current` with no config writes a "Missing JENKINS_URL"
      stack trace to `error-*.log` on every run (measured). It is an expected
      user error and should not be logged as an error.
- [ ] **H12.** Issue #120 body is stale (see above).

## Suggested order

P1-P4 and P11 first (hot polling paths, biggest wins), then F1, F2, F3.

## Rejected

(none yet)
