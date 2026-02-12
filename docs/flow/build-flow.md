# Build Flow (End-to-End)

This is the complete flow for:

```bash
jenkins-cli build
```

## 1) Big picture

```text
CLI args
  -> createContext (env + Jenkins client)
  -> runBuild(options)
       -> buildPre flow (collect job + build parameters)
       -> triggerBuild(...)
       -> optional watch loop
       -> buildPost flow (watch/logs/cancel/rerun/done)
```

## 2) Where each part lives

- CLI command wiring: `src/index.ts`
- Env/config loading: `src/env.ts`
- Build orchestration: `src/commands/build.ts`
- Flow map (states/transitions): `src/flows/definition.ts`
- Flow state logic: `src/flows/handlers.ts`
- Jenkins HTTP calls: `src/jenkins/client.ts`

## 3) Full request path

### A) CLI entry and options

1. `build` command is parsed in `src/index.ts`.
2. `createContext()` builds:
   - `env` from `loadEnv()`
   - `client = new JenkinsClient(...)`
3. `runBuild({...})` is called with flags:
   - `job`, `jobUrl`, `branch`, `branchParam`, `param`
   - `defaultBranch`, `watch`, `nonInteractive`

### B) `runBuild` startup

1. Validates option combinations.
2. Normalizes `branchParam`.
3. If `--non-interactive`:
   - goes through `runBuildOnce(...)`
   - no prompt flows
4. Else:
   - enters interactive loop
   - runs `resolveInteractiveBuildSelection(...)`

### C) `buildPre` flow (input collection)

The flow chooses job + parameter strategy and returns when state reaches `complete`.

```text
entry
  -> recent_menu OR search_direct
  -> search_from_recent
	-> results_from_recent/results_direct
	-> prepare_branch
	-> branch_mode (branch/custom/without)
	-> branch_select OR branch_entry OR custom_key/custom_value loop
	-> complete
```

What this flow writes into context:

- `selectedJobUrl`
- `selectedJobLabel`
- `branch`
- `customParams`
- branch cache lists (`branchChoices`, `removableBranches`)

### D) Build trigger

After `buildPre` returns `complete`:

```text
params =
  {}                                                  if without parameters
  { [branchParam]: selectedBranch, ...customParams } otherwise

client.triggerBuild(jobUrl, params)
```

Then it records:

- recent job cache
- selected branch cache (when applicable)

### E) Optional watch

If watch is enabled/chosen:

1. Poll queue/build status
2. Print compact status updates
3. On completion:
   - send desktop notification
   - set `process.exitCode = 1` if result is not success

### F) `buildPost` flow

After trigger (and optional initial watch), post menu runs:

- `watch`
- `logs`
- `cancel`
- `rerun`
- `done`

Possible outcomes:

- `repeat` -> loop back and start another build flow
- `exit_command`
- caller-return outcomes for composed flows

## 4) Concrete example with data

Assume user does:

1. `jenkins-cli build`
2. Selects `Search all jobs`
3. Types `api prod`
4. Selects job `api-prod`
5. Selects build mode `Build with branch parameter`
6. Selects branch `development`
7. Chooses to add custom parameter `DEPLOY_ENV=staging`
8. Chooses `Watch`

Data evolution:

```text
Initial:
  searchQuery=""
  selectedJobUrl=undefined
  branch=undefined

After search submit:
  searchQuery="api prod"
  searchCandidates=[...]

After job select:
  selectedJobUrl="https://jenkins.example.com/job/api-prod/"
  selectedJobLabel="api-prod"

After branch select:
  branch="development"

After custom parameter entry:
  customParams={ DEPLOY_ENV: "staging" }

Trigger payload:
  params={ BRANCH: "development", DEPLOY_ENV: "staging" }
```

## 5) Esc/back behavior in `buildPre`

```text
recent_menu (Esc) -> exit command
search_from_recent (Esc) -> recent_menu
results_from_recent (Esc) -> search_from_recent
branch_select (Esc) -> entry -> recent_menu (if recent jobs exist)
```

This is why Esc no longer abruptly quits in the middle of search/branch navigation.
