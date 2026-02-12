# Jenkins CLI

Minimal Jenkins CLI for listing jobs, triggering builds, and checking status. Built
for interactive use and automation with clear, parseable output.

## Install

Installs `jenkins-cli` to your PATH (defaults to `$HOME/.bun/bin`). It will install
Bun if it is missing.

Homebrew (tap):

```bash
brew tap jatinbansal1998/tap
brew install jatinbansal1998/tap/jenkins-cli
```

Upgrade:

```bash
brew upgrade jenkins-cli
```

Maintainers: see `docs/homebrew.md` for tap publishing steps.

Install options:

```bash
curl -fsSL http://jatinbansal.com/jenkins-cli/install/ | bash
curl -fsSL https://raw.githubusercontent.com/jatinbansal1998/jenkins-cli-ts/main/install | bash
```

Optional overrides:

```bash
JENKINS_CLI_VERSION=vX.Y.Z curl -fsSL http://jatinbansal.com/jenkins-cli/install/ | bash
JENKINS_CLI_INSTALL_DIR="$HOME/.local/bin" curl -fsSL http://jatinbansal.com/jenkins-cli/install/ | bash
```

## Setup

Config file:
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

Add credentials:

```bash
jenkins-cli login
jenkins-cli login --profile work
jenkins-cli login --profile prod --url https://jenkins-prod.example.com --user ci --token <token>
```

Manage profiles:

```bash
jenkins-cli profile list
jenkins-cli profile use prod
jenkins-cli profile delete work
```

Selection behavior:

- If you pass `--url --user --token`, those one-off credentials are used for that command.
- Else if you pass `--profile`, that profile is used and env credentials are ignored.
- Else the CLI uses `defaultProfile`.
- If no profiles exist, the CLI falls back to environment variables.

Environment variable fallback (single account only):

- `JENKINS_URL` (e.g., `https://jenkins.example.com`)
- `JENKINS_USER`
- `JENKINS_API_TOKEN`
- Optional: `JENKINS_USE_CRUMB` (`true` to enable; default: disabled)

## Usage

If you have not installed the global CLI, replace `jenkins-cli` with
`bun run src/index.ts`.

Output format notes:

- Commands return parseable output prefixed with `OK:` and `HINT:` where relevant.
- Running `jenkins-cli` with no command defaults to `list`.

List jobs (uses local cache by default):

```bash
jenkins-cli list
```

In interactive mode, `list` acts as a launcher:

- Search and select a job
- Run `Build`, `Status`, `Watch`, `Logs`, `Cancel`, or `Rerun`

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

In interactive mode, choose **Build without parameters** from the build mode prompt.

Trigger a build with custom parameters:

```bash
jenkins-cli build --job "api-prod" --param DEPLOY_ENV=staging --param FORCE=true
```

Trigger a build with both branch and custom parameters:

```bash
jenkins-cli build --job "api-prod" --branch main --param DEPLOY_ENV=staging
```

In interactive mode, build mode now offers:

- **Build with branch parameter**
- **Build with custom parameters**
- **Build without parameters**

Check status:

```bash
jenkins-cli status --job "api-prod"
```

Watch the latest build status from status command:

```bash
jenkins-cli status --job "api-prod" --watch
```

Wait for a build to finish:

```bash
jenkins-cli wait --job "api-prod" --timeout 30m --interval 10s
jenkins-cli wait --build-url "https://jenkins.example.com/job/api-prod/184/"
jenkins-cli wait --queue-url "https://jenkins.example.com/queue/item/123/"
```

Stream logs:

```bash
jenkins-cli logs --job "api-prod" --follow
jenkins-cli logs --build-url "https://jenkins.example.com/job/api-prod/184/" --no-follow
```

Cancel queued or running work:

```bash
jenkins-cli cancel --job "api-prod"
jenkins-cli cancel --queue-url "https://jenkins.example.com/queue/item/123/"
jenkins-cli cancel --build-url "https://jenkins.example.com/job/api-prod/184/"
```

Rerun from last failed build:

```bash
jenkins-cli rerun --job "api-prod"
```

## Update

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
