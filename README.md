# Jenkins CLI

Jenkins CLI for listing jobs, triggering builds, checking status, streaming
logs, inspecting build history, and managing multiple Jenkins profiles from the
terminal. Built for interactive use and automation with clear, parseable
output.

## Install

Installs the latest supported native `jenkins-cli` binary to your PATH
(defaults to `$HOME/.local/bin`). Bun is not required on the target machine.

Primary install URL:

```bash
curl -fsSL https://jatinbansal.com/jenkins-cli/install/ | bash
wget -qO- https://jatinbansal.com/jenkins-cli/install/ | bash
```

## Supported Features

| Feature                     | Supported | Notes                                                               |
| --------------------------- | --------- | ------------------------------------------------------------------- |
| Multi-profile configuration | Yes       | Store multiple Jenkins profiles and switch the default profile      |
| Job listing and search      | Yes       | Cached job listing with refresh and natural-language search         |
| Build triggers              | Yes       | Discovers common parameters and supports branch/default/custom runs |
| Status and watch mode       | Yes       | Track the latest build and watch until completion                   |
| Build history               | Yes       | Jenkins-style recent build history table                            |
| Queue visibility            | Yes       | Inspect the build queue, filter by job, and cancel or open items    |
| Node/agent visibility       | Yes       | List agents with status, executor usage, and labels                 |
| Running build actions       | Yes       | List, open, or batch-cancel live running builds                     |
| Logs, cancel, and rerun     | Yes       | Inspect recent logs and manage existing builds                      |
| Artifacts                   | Yes       | List build artifacts and stream them to disk, preserving paths      |
| One-off credentials         | Yes       | Override profile config with `--url`, `--user`, and `--token`       |
| Script-friendly output      | Yes       | Parseable `OK:` and `HINT:` output for automation                   |

GitHub install mirror:

```bash
curl -fsSL https://raw.githubusercontent.com/jatinbansal1998/jenkins-cli-ts/main/install | bash
wget -qO- https://raw.githubusercontent.com/jatinbansal1998/jenkins-cli-ts/main/install | bash
```

Optional override:

```bash
JENKINS_CLI_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://jatinbansal.com/jenkins-cli/install/ | bash
JENKINS_CLI_INSTALL_DIR="$HOME/.local/bin" wget -qO- https://jatinbansal.com/jenkins-cli/install/ | bash
```

Older versions are not installed through the script. If you need an older
release, download it manually from GitHub Releases.

On minimal Alpine images, if the installer falls back to the legacy Bun bundle
before a native musl binary is available, it may need `bash` and `unzip` to
bootstrap Bun. The script will try `apk add --no-cache bash unzip` when it can.

Homebrew (tap, alternative):

```bash
brew tap jatinbansal1998/tap
brew install jatinbansal1998/tap/jenkins-cli
```

Upgrade:

```bash
brew upgrade jenkins-cli
```

Maintainers: see `docs/homebrew.md` for tap publishing steps.

## Demo

![Jenkins CLI demo](docs/media/jenkins-cli-demo.gif)

## Quick Start

```bash
jenkins-cli auth login --profile work --url https://jenkins.example.com --user ci --token <token>
jenkins-cli auth status --profile work
jenkins-cli list --profile work
jenkins-cli build --job "api-prod" --branch main --profile work
```

## Setup

### Config File

`~/.config/jenkins-cli/jenkins-cli-config.json`

```json
{
  "version": 2,
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "jenkinsUrl": "https://jenkins.example.com",
      "jenkinsUser": "your-username",
      "jenkinsApiToken": "your-token",
      "branchParam": "BRANCH",
      "useCrumb": false
    }
  },
  "debug": false
}
```

### Add Credentials

```bash
jenkins-cli auth login
jenkins-cli auth login --profile work
jenkins-cli auth login --profile prod --url https://jenkins-prod.example.com --user ci --token <token>
```

`jenkins-cli login` remains supported as a compatibility alias for
`jenkins-cli auth login`.

Interactive login offers to open the browser twice:

1. After the Jenkins URL, it offers to open the Jenkins home page so you can
   sign in and confirm your Jenkins username.
2. After the username, it offers to open that user's Jenkins Security page
   (`/user/<username>/security/`) so you can create an API token before the
   token prompt appears.

Declining is the default for both questions, and both are skipped entirely with
`--non-interactive`.

### Secure Token Storage

When an OS-native secret store is available, `auth login` stores the API token
in the keychain via `cross-keychain` instead of writing it in plaintext to the
config file:

- **macOS** — the login Keychain.
- **Linux** — the Secret Service / libsecret keyring (e.g. GNOME Keyring or
  KWallet). Install with `sudo apt-get install libsecret-tools` on
  Debian/Ubuntu if needed.
- **Windows** — Windows Credential Manager.

For keychain-backed profiles the config file only holds a sentinel instead of
the secret:

```json
{
  "profiles": {
    "work": {
      "jenkinsUrl": "https://jenkins.example.com",
      "jenkinsUser": "your-username",
      "jenkinsApiToken": "@keychain",
      "tokenStorage": "keychain"
    }
  }
}
```

The token is resolved transparently on every command. If the keyring is locked
or the entry is missing, the CLI prints a `HINT:` explaining how to re-run
`auth login` and fails gracefully rather than sending an empty token.
After a secure login, the CLI shows profile-based usage instructions and does
not echo the token or suggest exporting credentials into the shell.

Behavior notes:

- **Fallback:** if no secure store is available (e.g. a headless box with no
  keyring, or `secret-tool` not installed), the token is written to the config
  file in plaintext and a one-line `HINT:` is printed. The profile remains
  eligible for automatic migration if secure storage becomes available later.
- **`--no-keychain`:** pass this flag to `auth login` to force plaintext
  storage in the config file even when a keychain is available. This explicit
  preference also disables automatic migration for that profile.
- **Existing profiles:** plaintext profiles keep working unchanged. A profile
  is migrated automatically once a secure store is available and the token can
  be written and read back successfully.
- **`auth logout` / `profile delete`** remove the matching keychain entry with
  strict semantics: the secure-store entry is deleted and verified absent
  before the config is updated, and a failed config write restores the entry.

#### Automatic secure-store migration

If you upgrade without re-running `auth login`, the CLI automatically attempts
to move an existing plaintext profile token into the secure store the next time
that profile is used.

- The token is written to the secure store and **read back to verify the
  round-trip**. Only then is plaintext replaced with the sentinel.
- If the secure store is unavailable, locked, fails verification, or the config
  cannot be updated, the plaintext profile remains active.
- Non-interactive and JSON commands migrate silently so their output contracts
  remain unchanged.
- Profiles created with `--no-keychain` are left in plaintext by explicit
  request.

```bash
jenkins-cli auth login --profile work                 # keychain when available
jenkins-cli auth login --profile work --no-keychain   # force plaintext config
```

### Manage Profiles

The canonical profile management commands live under `auth`:

```bash
jenkins-cli auth list                 # list profiles with URL, user, and token storage
jenkins-cli auth use prod             # set the default profile
jenkins-cli auth current              # show which credentials would be used (no network request)
jenkins-cli auth rename work corp     # rename a profile (moves its keychain token)
jenkins-cli auth logout               # delete the active profile's local credentials
jenkins-cli auth logout --profile work
jenkins-cli auth logout --all         # delete every stored profile
```

- `auth current` resolves credentials locally using the normal precedence
  (direct `--url --user --token`, explicit `--profile`, default profile, then
  environment variables) and never contacts Jenkins or prints the token. Use
  `auth status` for the network-backed authentication check.
- `auth logout` asks for confirmation unless `--non-interactive` is passed. It
  deletes the profile from the config and its matching secure-store entry.
- **Logout removes local credentials only.** The API token itself is not
  revoked at the Jenkins controller — Jenkins exposes no general token
  revocation operation to these credentials. To revoke the token, delete it
  from your Jenkins user configuration page.

The original `profile` commands remain supported and route through the same
operations:

```bash
jenkins-cli profile list
jenkins-cli profile use prod
jenkins-cli profile delete work
```

### Credential Selection Order

- If you pass `--url --user --token`, those one-off credentials are used for that command.
- Else if you pass `--profile`, that profile is used and env credentials are ignored.
- Else the CLI uses `defaultProfile`.
- If no profiles exist, the CLI falls back to environment variables.

### Environment Variable Fallback

Single-account fallback only:

- `JENKINS_URL` (e.g., `https://jenkins.example.com`)
- `JENKINS_USER`
- `JENKINS_API_TOKEN`
- Optional: `JENKINS_USE_CRUMB` (`true` to enable; default: disabled)

### Analytics

- Analytics is disabled by default.
- Set `"analyticsDisabled": false` in `~/.config/jenkins-cli/jenkins-cli-config.json` to enable the bundled PostHog analytics.
- Default analytics host is the managed reverse proxy: `https://t.jatinbansal.com`
- Optional: `JENKINS_POSTHOG_API_KEY` to enable analytics with a custom PostHog project token
- Optional: `JENKINS_POSTHOG_HOST` to override the PostHog host
- Optional: `JENKINS_ANALYTICS_DISABLED=false` to enable analytics from env using the bundled token
- Optional: `JENKINS_ANALYTICS_DISABLED=true` to force-disable analytics entirely
- Optional config: set `"analyticsDisabled": true` to force-disable analytics entirely

### Privacy Guardrails

- Analytics never sends Jenkins usernames, API tokens, Jenkins URLs, job names, job URLs, build URLs, queue URLs, branch names, raw search text, build parameter names or values, or log output.
- Authentication diagnostics also exclude profile names, token-storage details,
  redirect destinations, effective Jenkins users, and Jenkins versions from
  analytics.
- Analytics only sends anonymous install ID, CLI version, command names, interactivity/TTY flags, high-level outcomes, exact command durations in milliseconds, and coarse Jenkins API health counts.

## Usage

If you have not installed the global CLI, replace `jenkins-cli` with
`bun run src/index.ts`.

### Output Format Notes

- Commands return parseable output prefixed with `OK:` and `HINT:` where relevant.
- Running `jenkins-cli` with no command defaults to `list`.
- Interactive commands show an ASCII intro banner by default. Use `--no-banner`
  to disable it for a single run.

#### JSON Output (`--json`)

The read commands `list`, `params`, `status`, `history` (alias `builds`), and `wait`
accept a `--json` flag for scripting and automation:

- `--json` prints **exactly one JSON document** to stdout and nothing else — no
  banner, no `OK:`/`HINT:` lines, no prompts, no spinner. Hints and warnings, if
  any, go to stderr.
- `--json` implies `--non-interactive`: the command never prompts and fails fast.
- `--json` cannot be combined with `--watch` (or streaming flags); doing so is an
  error.

Success envelope:

```json
{ "ok": true, "command": "<name>", "data": <command-specific> }
```

Error envelope (also written to stdout, with a non-zero exit code):

```json
{ "ok": false, "error": { "message": "<message>", "code": "<code>" } }
```

Every build object shares the same camelCase shape across `status`, `history`,
and `wait`:

```json
{
  "number": 42,
  "url": "https://jenkins.example.com/job/api/42/",
  "result": "SUCCESS",
  "building": false,
  "durationMs": 12000,
  "timestampMs": 1700000000000,
  "estimatedDurationMs": 11000,
  "queueTimeMs": 250,
  "branch": "main",
  "parameters": [{ "name": "BRANCH", "value": "main" }],
  "stages": [{ "name": "Build", "status": "SUCCESS", "durationMs": 8000 }]
}
```

Fields that Jenkins does not return are omitted from the document.

**`params`** — `data` is the normalized parameter-definition array. Sensitive
parameters set `sensitive: true` and omit `defaultValue`:

```bash
jenkins-cli params --job "api-prod" --json
jenkins-cli params --job-url "https://jenkins.example.com/job/api-prod/" --json
```

```json
{
  "ok": true,
  "command": "params",
  "data": [
    {
      "name": "DEPLOY_ENV",
      "type": "choice",
      "description": "Target environment",
      "defaultValue": "staging",
      "choices": ["dev", "staging", "prod"],
      "sensitive": false
    }
  ]
}
```

**`list`** — `data` is an array of cached jobs:

```bash
jenkins-cli list --json
```

```json
{
  "ok": true,
  "command": "list",
  "data": [
    {
      "name": "api",
      "fullName": "team/api",
      "url": "https://jenkins.example.com/job/api"
    }
  ]
}
```

**`status`** — `data` is `{ job, build }` (`build` is `null` when the job has no
builds):

```bash
jenkins-cli status --json --job-url https://jenkins.example.com/job/api/
```

```json
{
  "ok": true,
  "command": "status",
  "data": {
    "job": "https://jenkins.example.com/job/api",
    "build": {
      "number": 42,
      "url": "https://jenkins.example.com/job/api/42/",
      "result": "SUCCESS",
      "building": false,
      "durationMs": 12000,
      "timestampMs": 1700000000000
    }
  }
}
```

**`history` / `builds`** — `data` is an array of builds (most recent first):

```bash
jenkins-cli history --json --job-url https://jenkins.example.com/job/api/
```

```json
{
  "ok": true,
  "command": "history",
  "data": [
    {
      "number": 42,
      "url": "https://jenkins.example.com/job/api/42/",
      "result": "FAILURE",
      "building": false,
      "durationMs": 75000,
      "branch": "main"
    }
  ]
}
```

**`wait`** — `data` is `{ result, build, waitedMs }`. The document is emitted on
every terminal path, and the exit code reflects the outcome: `0` success, `1`
non-success, `124` timeout, `130` interrupted.

```bash
jenkins-cli wait --json --build-url https://jenkins.example.com/job/api/42/
```

```json
{
  "ok": true,
  "command": "wait",
  "data": {
    "result": "SUCCESS",
    "build": {
      "number": 42,
      "url": "https://jenkins.example.com/job/api/42/",
      "result": "SUCCESS",
      "building": false,
      "durationMs": 12000
    },
    "waitedMs": 42000
  }
}
```

### Authentication Troubleshooting

Check the active default profile, a named profile, or a complete set of direct
credentials without triggering or modifying a build:

```bash
jenkins-cli auth status
jenkins-cli auth status --profile prod
jenkins-cli auth status --url https://jenkins.example.com --user ci --token <token>
```

The command follows the normal credential precedence: a complete direct
`--url --user --token` set, then an explicit `--profile`, then the configured
default profile, and finally environment variables when no profile exists. It
performs one read-only `GET` to `/whoAmI/api/json`, never requests a crumb, and
never writes configuration or secure-store data. Redirects are not followed,
so credentials are not forwarded to an SSO or reverse-proxy login page.

For a purely local view of the same resolution — which source, profile,
controller, username, and token storage would be used — run
`jenkins-cli auth current`; it makes no network request at all.

Successful authentication exits with status `0`:

```text
Profile:          work
Controller:       https://jenkins.company.com
Username:         jatin
Token storage:    macOS Keychain
Token present:    Yes
Authenticated:    Yes
Jenkins user:     jatin.bansal
Jenkins version:  2.516.1

OK: Authentication is working.
```

Every other result exits with status `1` after printing all fields that could
be determined. Failures distinguish missing or inaccessible tokens, rejected
credentials, denied identity access, anonymous responses, redirects, malformed
responses, timeouts, and network/DNS/TLS errors:

```text
Profile:          work
Controller:       https://jenkins.company.com
Username:         jatin
Token storage:    macOS Keychain
Token present:    Yes
Authenticated:    No
Jenkins user:     Unknown
Jenkins version:  2.516.1

ERROR: Jenkins rejected the supplied credentials (HTTP 401).
HINT: Check the username and API token, then run `jenkins-cli auth login` again.
```

When a token is missing or the secure store cannot be read, `auth status`
still probes the controller anonymously. This separates controller
reachability from credential availability without exposing a token, Basic
authorization value, response body, or redirect query string.

### List Jobs

Uses the local cache by default:

```bash
jenkins-cli list
```

In interactive mode, `list` acts as a launcher:

- Search and select a job
- Run `Build`, `Status`, `Build history`, `Watch`, `Logs`, `Cancel`, or `Rerun`

Refresh the cache from Jenkins:

```bash
jenkins-cli list --refresh
```

Search with natural language:

```bash
jenkins-cli list --search "api prod deploy"
```

Run any command against a specific profile:

```bash
jenkins-cli list --profile prod
```

Run any command with direct one-off credentials:

```bash
jenkins-cli list --url https://jenkins.example.com --user ci-user --token <token>
```

### Trigger Builds

From the root `jenkins-cli` launcher, search for a job and choose **Build**.
For a parameterized job the CLI reads authoritative Jenkins job metadata and
offers **Configure parameters** or **Run with default parameters**. Configure
mode uses text inputs for string/text parameters, confirms for booleans,
Jenkins-provided options for choices, and masked inputs for passwords. A final
summary is shown before the existing trigger/watch/post-build flow continues.

The initially supported Jenkins types are string, text, boolean, choice, and
password/secret parameters. Unknown plugin parameter types remain available as
generic text inputs instead of blocking the build.

Inspect a job without starting it:

```bash
jenkins-cli params --job "api-prod"
jenkins-cli params --job-url "https://jenkins.example.com/job/api-prod/"
jenkins-cli params --job "api-prod" --json
```

Trigger a build with a branch:

```bash
jenkins-cli build --job "api-prod" --branch main
```

Watch a build until completion (macOS notification on completion):

```bash
jenkins-cli build --job "api-prod" --branch main --watch
```

Press `Esc` to stop watching and return to the prompt.

Trigger a build without passing branch parameters:

```bash
jenkins-cli build --job "api-prod" --without-params
# useful for non-interactive usage too:
jenkins-cli build --job-url "https://jenkins.example/job/api-prod/" --non-interactive --without-params
```

In interactive mode, choose **Run with default parameters** from the build mode prompt.

Trigger a build with custom parameters:

```bash
jenkins-cli build --job "api-prod" --param DEPLOY_ENV=staging --param FORCE=true
jenkins-cli build --job "api-prod" --param DEPLOY_ENV=staging --non-interactive
```

Trigger a build with both branch and custom parameters:

```bash
jenkins-cli build --job "api-prod" --branch main --param DEPLOY_ENV=staging
```

When Jenkins metadata is available, non-interactive builds validate recognized
choice values and normalize common boolean forms (`true`/`false`, `yes`/`no`,
`on`/`off`, and `1`/`0`). Unknown `--param` names are still sent for backward
compatibility with a `HINT:` on stderr. `--non-interactive` and `--json` never
prompt.

Branch parameters keep the existing cached branch selection experience. A
discovered parameter matching the configured branch parameter (usually
`BRANCH`) uses that selector once; an explicit `--branch` wins and the CLI
continues through the other discovered parameters.

Secret parameter defaults are never displayed or returned in JSON. Entered
secret values are masked and redacted from summaries and generated command
tips. Jenkins request and response bodies are omitted from persistent debug
logs so parameter secrets are not recorded there.

If Jenkins reports no parameter definitions, or metadata discovery fails, the
CLI falls back to the existing branch/custom/default build mode. Discovery
failure prints a concise stderr hint, while genuinely non-parameterized jobs
remain quiet. Authentication and permission errors still fail using the normal
Jenkins error handling. Definitions are read from current job metadata only;
previous builds are not inspected.

In fallback interactive mode, build mode offers:

- **Select a branch**
- **Enter custom parameters**
- **Run with default parameters**

### Check Status

Check status:

```bash
jenkins-cli status --job "api-prod"
```

Watch the latest build status from status command:

```bash
jenkins-cli status --job "api-prod" --watch
```

### Build History

Show recent build history in a Jenkins-style table:

```bash
jenkins-cli history --job "api-prod"
jenkins-cli builds --job "api-prod"
jenkins-cli history --job "api-prod" --offset 5
```

In interactive mode, build history lets you:

- Page through builds 5 at a time
- Rebuild a selected historical build with the same parameters
- Continue into the same post-build action menu used by `build` after a rebuild
- Open the selected build's URL
- Jump into logs for the selected build
- Inspect failed step and failure reason when Jenkins exposes them

### Wait For Completion

Wait for a build to finish:

```bash
jenkins-cli wait --job "api-prod" --timeout 30m --interval 5s
jenkins-cli wait --build-url "https://jenkins.example.com/job/api-prod/184/"
jenkins-cli wait --queue-url "https://jenkins.example.com/queue/item/123/"
```

### Stream Logs

Stream logs:

```bash
jenkins-cli logs --job "api-prod" --follow
jenkins-cli logs --job "api-prod" --follow --poll 1s
jenkins-cli logs --build-url "https://jenkins.example.com/job/api-prod/184/" --no-follow
```

### Artifacts

List build artifacts (defaults to the latest completed build):

```bash
jenkins-cli artifacts --job "api-prod"
jenkins-cli artifacts --job "api-prod" --build 184
jenkins-cli artifacts --build-url "https://jenkins.example.com/job/api-prod/184/"
```

Download artifacts, preserving their `relativePath` subdirectories:

```bash
# Download every artifact to the current directory
jenkins-cli artifacts --job "api-prod" --download

# Download to a specific directory
jenkins-cli artifacts --job "api-prod" --download --dest ./out

# Download only specific artifacts (repeatable; overwrite with --force)
jenkins-cli artifacts --job "api-prod" --download \
  --artifact dist/app.js --artifact report.txt --force
```

Without `--download`, an interactive terminal offers a multi-select of
artifacts and a destination prompt. In `--non-interactive` mode the command
lists artifacts, or downloads them when `--download` is given. Existing files
are never overwritten unless `--force` is passed, and downloads stream to disk
rather than buffering in memory.

### Cancel Work

Cancel queued or running work:

```bash
jenkins-cli cancel
jenkins-cli cancel --job "api-prod"
jenkins-cli cancel --queue-url "https://jenkins.example.com/queue/item/123/"
jenkins-cli cancel --build-url "https://jenkins.example.com/job/api-prod/184/"
```

With no target in interactive mode, `cancel` shows live running builds and
supports selecting one, several, or all of them. You can also fall back to the
existing cached job search. Explicit targets and non-interactive behavior are
unchanged.

### Running Builds

List live running builds and open one in the default browser:

```bash
jenkins-cli run
jenkins-cli run --non-interactive
```

Interactive mode opens the selected build. Non-interactive mode prints every
running build and its exact URL without launching a browser. If nothing is
running, the command prints `OK: no running builds` and exits 0.

### Queue

Show the Jenkins build queue with humanized wait times and item state
(blocked / stuck / buildable / waiting):

```bash
jenkins-cli queue
jenkins-cli queue --job "api-prod"
jenkins-cli queue --non-interactive
```

An empty queue prints `OK: queue is empty` and exits 0. When a single item is
shown, the full `why` reason is printed below the table. In interactive mode you
can select a queued item and:

- Cancel the queued item (reuses the same logic as `cancel`)
- Open the queue item URL

Use `--non-interactive` to list only, which is handy for scripts.

### Nodes

Show Jenkins agents/executors with online/offline status, per-node executor
usage, and labels:

```bash
jenkins-cli nodes
jenkins-cli nodes --offline-only
```

The summary line reports total nodes, offline count, and busy/total executors,
for example `OK: 12 nodes, 2 offline, 5/48 executors busy.`. Use
`--offline-only` to show just the offline agents (useful for alerting scripts);
the summary still reflects the whole fleet. This command is read-only.

### Rerun Failed Builds

Rerun from last failed build:

```bash
jenkins-cli rerun --job "api-prod"
```

## Update

If installed with Homebrew, use:

```bash
brew upgrade jenkins-cli
```

`jenkins-cli update` is for standalone installs (for example via the install script).

Update to the latest release (alias: `upgrade`):

```bash
jenkins-cli update
jenkins-cli upgrade
```

Install a specific version:

```bash
jenkins-cli update vX.Y.Z
```

Check for updates without installing:

```bash
jenkins-cli update --check
```

Set the update channel:

```bash
jenkins-cli update --channel stable
jenkins-cli update --channel prerelease
```

Auto-update checks (notify only):

```bash
jenkins-cli update --enable-auto
jenkins-cli update --disable-auto
```

Auto-install updates:

```bash
jenkins-cli update --enable-auto-install
jenkins-cli update --disable-auto-install
```

Auto-update defaults:

- Notify-only checks are enabled by default.
- Auto-install is disabled by default.
- Update channel defaults to `stable`.
- Stable channel only installs stable releases, even if a newer prerelease exists.
- Prerelease channel installs whichever GitHub release is newest, using the release order from GitHub.

## Development

### Dev Container

For a no-local-setup workflow, open the repo in a devcontainer-capable editor
such as VS Code, Cursor, or GitHub Codespaces and choose **Reopen in
Container**. The container installs Bun and runs `bun install`
automatically on first create.

Once the container is ready, use the same Bun commands as local development:

```bash
bun run dev
bun test
bun run build
```

### Local Development

Install dependencies:

```bash
bun install
```

Run lint:

```bash
bun run lint
```

Run the end-to-end suite against an ephemeral Jenkins LTS controller (Docker is
required):

```bash
bun run test:integration:jenkins
```

The command provisions a secured controller and test job on a random local
port, tests the compiled CLI from authentication through artifact download,
and removes the controller afterward. Set `JENKINS_TEST_IMAGE` to test against
a different Jenkins image tag.

Run semantic mutation canaries against the Jenkins client unit tests:

```bash
bun run test:mutation
```

To inject the same protocol bugs into temporary copies of the CLI and require
the real Jenkins flow to catch each one:

```bash
bun run test:mutation:jenkins
```

Apply fixes:

```bash
bun run lint:fix
```

Build and install the global CLI (symlinked):

```bash
bun run install:global
```

Update after changes:

```bash
bun run build
```

Commands print `OK:` on success.

## Docs

- Build flow walkthrough: `docs/flow/build-flow.md`
- Prompt architecture and dependencies: `docs/flow/prompt-system.md`
- Interactive state diagrams: `docs/tui-state-diagrams.md`
- Fuzzy job search: `fuzzy-search-docs/FUZZY_SEARCH_ALGORITHM.md`

## Notes

- Job lists are cached in the OS cache directory and separated by Jenkins URL
  (for example `jobs-<host>-<hash>.json`). Use `--refresh` to update.
  macOS: `~/Library/Caches/jenkins-cli/`, Linux:
  `${XDG_CACHE_HOME:-~/.cache}/jenkins-cli/`, Windows:
  `%LOCALAPPDATA%\jenkins-cli\`.
- The first profile added becomes the default profile.
- Legacy single-profile config is migrated automatically when profile data is read/written.
- `deploy` is an alias for `build`.
- `login` is a compatibility alias for `auth login`; new examples use
  `auth login`.
- `build`/`deploy` uses `buildWithParameters` when branch or custom parameters are
  provided; otherwise it triggers Jenkins with no parameters.
- CSRF crumb usage is disabled by default. Enable it with
  `JENKINS_USE_CRUMB=true` or `useCrumb: true` in config when required by your Jenkins.
- Use `--non-interactive` to disable prompts and fail fast.
- `wait` exit codes: `0` success, `1` non-success, `124` timeout, `130`
  interrupted.
