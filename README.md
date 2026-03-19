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
curl -fsSL http://jatinbansal.com/jenkins-cli/install/ | bash
```

## Supported Features

| Feature                     | Supported | Notes                                                                 |
| --------------------------- | --------- | --------------------------------------------------------------------- |
| Multi-profile configuration | Yes       | Store multiple Jenkins profiles and switch the default profile        |
| Job listing and search      | Yes       | Cached job listing with refresh and natural-language search           |
| Build triggers              | Yes       | Supports branch builds, default-parameter runs, and custom parameters |
| Status and watch mode       | Yes       | Track the latest build and watch until completion                     |
| Build history               | Yes       | Jenkins-style recent build history table                              |
| Logs, cancel, and rerun     | Yes       | Inspect recent logs and manage existing builds                        |
| One-off credentials         | Yes       | Override profile config with `--url`, `--user`, and `--token`         |
| Script-friendly output      | Yes       | Parseable `OK:` and `HINT:` output for automation                     |

GitHub install mirror:

```bash
curl -fsSL https://raw.githubusercontent.com/jatinbansal1998/jenkins-cli-ts/main/install | bash
```

Optional override:

```bash
JENKINS_CLI_INSTALL_DIR="$HOME/.local/bin" curl -fsSL http://jatinbansal.com/jenkins-cli/install/ | bash
```

Older versions are not installed through the script. If you need an older
release, download it manually from GitHub Releases.

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
jenkins-cli login --profile work --url https://jenkins.example.com --user ci --token <token>
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
jenkins-cli login
jenkins-cli login --profile work
jenkins-cli login --profile prod --url https://jenkins-prod.example.com --user ci --token <token>
```

### Manage Profiles

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
- Analytics only sends anonymous install ID, CLI version, command names, interactivity/TTY flags, high-level outcomes, exact command durations in milliseconds, and coarse Jenkins API health counts.

## Usage

If you have not installed the global CLI, replace `jenkins-cli` with
`bun run src/index.ts`.

### Output Format Notes

- Commands return parseable output prefixed with `OK:` and `HINT:` where relevant.
- Running `jenkins-cli` with no command defaults to `list`.
- Interactive commands show an ASCII intro banner by default. Use `--no-banner`
  to disable it for a single run.

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
```

Trigger a build with both branch and custom parameters:

```bash
jenkins-cli build --job "api-prod" --branch main --param DEPLOY_ENV=staging
```

In interactive mode, build mode now offers:

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

### Cancel Work

Cancel queued or running work:

```bash
jenkins-cli cancel --job "api-prod"
jenkins-cli cancel --queue-url "https://jenkins.example.com/queue/item/123/"
jenkins-cli cancel --build-url "https://jenkins.example.com/job/api-prod/184/"
```

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

Install dependencies:

```bash
bun install
```

Run lint:

```bash
bun run lint
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

Helper script (installs Bun if needed, deps, and global CLI):

```bash
bash setup.sh
```

Commands print `OK:` on success.

## Docs

- Build flow walkthrough: `docs/flow/build-flow.md`
- Prompt architecture and dependencies: `docs/flow/prompt-system.md`

## Notes

- Job lists are cached in the OS cache directory and separated by Jenkins URL
  (for example `jobs-<host>-<hash>.json`). Use `--refresh` to update.
  macOS: `~/Library/Caches/jenkins-cli/`, Linux:
  `${XDG_CACHE_HOME:-~/.cache}/jenkins-cli/`, Windows:
  `%LOCALAPPDATA%\jenkins-cli\`.
- The first profile added becomes the default profile.
- Legacy single-profile config is migrated automatically when profile data is read/written.
- `deploy` is an alias for `build`.
- `build`/`deploy` uses `buildWithParameters` when branch or custom parameters are
  provided; otherwise it triggers Jenkins with no parameters.
- CSRF crumb usage is disabled by default. Enable it with
  `JENKINS_USE_CRUMB=true` or `useCrumb: true` in config when required by your Jenkins.
- Use `--non-interactive` to disable prompts and fail fast.
- `wait` exit codes: `0` success, `1` non-success, `124` timeout, `130`
  interrupted.
