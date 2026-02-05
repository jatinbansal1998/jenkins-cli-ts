# Jenkins CLI

Minimal Jenkins CLI for listing jobs, triggering builds, and checking status. Built
for interactive use and automation with clear, parseable output.

## Install

Installs `jenkins-cli` to your PATH (defaults to `$HOME/.bun/bin`). It will install
Bun if it is missing.

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

Required environment variables:

- `JENKINS_URL` (e.g., `https://jenkins.example.com`)
- `JENKINS_USER`
- `JENKINS_API_TOKEN`

Config file (used when env vars are not set):
`~/.config/jenkins-cli/jenkins-cli-config.json`

```json
{
  "jenkinsUrl": "https://jenkins.example.com",
  "jenkinsUser": "your-username",
  "jenkinsApiToken": "your-token",
  "branchParam": "BRANCH"
}
```

Login and save credentials (saved to the config path above):

```bash
jenkins-cli login
```

Custom branch parameter name:

```bash
jenkins-cli login --branch-param BRANCH_TAG
```

Environment variables always take precedence.

## Usage

If you have not installed the global CLI, replace `jenkins-cli` with
`bun run src/index.ts`.

Output format notes:

- Commands return parseable output prefixed with `OK:` and `HINT:` where relevant.

List jobs (uses local cache by default):

```bash
jenkins-cli list
```

Refresh the cache from Jenkins:

```bash
jenkins-cli list --refresh
```

Search with natural language:

```bash
jenkins-cli list --search "api prod deploy"
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

Use the job's default branch explicitly:

```bash
jenkins-cli build --job "api-prod" --default-branch
```

Check status:

```bash
jenkins-cli status --job "api-prod"
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

## Notes

- Job lists are cached in the OS cache directory. Use `--refresh` to update.
  macOS: `~/Library/Caches/jenkins-cli/jobs.json`, Linux:
  `${XDG_CACHE_HOME:-~/.cache}/jenkins-cli/jobs.json`, Windows:
  `%LOCALAPPDATA%\jenkins-cli\jobs.json`.
- `deploy` is an alias for `build`.
- `build`/`deploy` uses `buildWithParameters`; branch is required unless you pass
  `--default-branch`.
- Use `--non-interactive` to disable prompts and fail fast.
