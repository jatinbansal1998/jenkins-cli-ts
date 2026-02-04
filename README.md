# Jenkins CLI

Minimal Jenkins CLI for listing jobs, triggering builds, and checking status. Built
for interactive use and automation with clear, parseable output.

## Install

Installs `jenkins-cli` to your PATH (defaults to `$HOME/.bun/bin`). It will install
Bun if it is missing.

```bash
curl -fsSL http://jatinbansal.com/jenkins-cli/install/ | bash
```

Direct GitHub URL:

```bash
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

Environment variables always take precedence.

Login and save credentials:

```bash
jenkins-cli login
```

Example output:

```text
OK: Saved credentials to ~/.config/jenkins-cli/jenkins-cli-config.json
HINT: Run: export JENKINS_URL=... JENKINS_USER=... JENKINS_API_TOKEN=...
```

Custom branch parameter name:

```bash
jenkins-cli login --branch-param BRANCH_TAG
```

Example output:

```text
OK: Saved branchParam=BRANCH_TAG
```

## Usage

If you have not installed the global CLI, replace `jenkins-cli` with
`bun run src/index.ts`.

List jobs (uses local cache by default):

```bash
jenkins-cli list
```

Example output:

```text
OK: Loaded cached jobs (42)
```

Refresh the cache from Jenkins:

```bash
jenkins-cli list --refresh
```

Example output:

```text
OK: Fetched jobs from Jenkins (42)
```

Search with natural language:

```bash
jenkins-cli list --search "api prod deploy"
```

Example output:

```text
OK: Top matches: api-prod-deploy, api-prod-hotfix
HINT: Re-run with --job to select one
```

Trigger a build with a branch:

```bash
jenkins-cli build --job "api-prod" --branch main
```

Example output:

```text
OK: Triggered build for job "api-prod" (branch: main)
```

Use the job's default branch explicitly:

```bash
jenkins-cli build --job "api-prod" --default-branch
```

Example output:

```text
OK: Triggered build for job "api-prod" (default branch)
```

Check status:

```bash
jenkins-cli status --job "api-prod"
```

Example output:

```text
OK: Last build is SUCCESS (build #184)
```

## Development

Install dependencies:

```bash
bun install
```

Example output:

```text
OK: Dependencies installed
```

Run lint:

```bash
bun run lint
```

Example output:

```text
OK: Lint passed
```

Apply fixes:

```bash
bun run lint:fix
```

Example output:

```text
OK: Lint fixes applied
```

Build and install the global CLI (symlinked):

```bash
bun run install:global
```

Example output:

```text
OK: Linked jenkins-cli to your PATH
```

Update after changes:

```bash
bun run build
```

Example output:

```text
OK: Build complete
```

Helper script (installs Bun if needed, deps, and global CLI):

```bash
bash setup.sh
```

Example output:

```text
OK: Setup complete
```

## Notes

- Job lists are cached in the OS cache directory. Use `--refresh` to update.
  macOS: `~/Library/Caches/jenkins-cli/jobs.json`, Linux:
  `${XDG_CACHE_HOME:-~/.cache}/jenkins-cli/jobs.json`, Windows:
  `%LOCALAPPDATA%\jenkins-cli\jobs.json`.
- `deploy` is an alias for `build`.
- `build`/`deploy` uses `buildWithParameters`; branch is required unless you pass
  `--default-branch`.
- Use `--non-interactive` to disable prompts and fail fast.
