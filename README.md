# Jenkins CLI (MVP)

Minimal Jenkins CLI with `list`, `build`/`deploy`, and `status` commands. Designed for
interactive use and AI-agent automation with clear, English error messages.

## Setup

Set required environment variables:

- `JENKINS_URL` (e.g., `https://jenkins.example.com`)
- `JENKINS_USER`
- `JENKINS_API_TOKEN`

The CLI also reads these values from `~/.config/jenkins-cli/jenkins-cli-config.json`
(JSON) if the env vars are not set:

```json
{
  "jenkinsUrl": "https://jenkins.example.com",
  "jenkinsUser": "your-username",
  "jenkinsApiToken": "your-token",
  "branchParam": "BRANCH"
}
```

Environment variables always take precedence.

You can also use the interactive login command to save config and print export
commands:

```bash
jenkins-cli login
```

If you want to set a custom branch parameter name, pass `--branch-param`.
When omitted, the login flow defaults to `JENKINS_BRANCH_PARAM` from env/config,
or `"BRANCH"` if nothing is set.

Optional branch parameter name (for jobs that don’t use `BRANCH`):

- `JENKINS_BRANCH_PARAM` (env var), or
- `"branchParam"` / `"jenkinsBranchParam"` / `"JENKINS_BRANCH_PARAM"` in the config file

## Setup script

Run the helper script to install Bun (if needed), dependencies, and the global CLI:

```bash
bash setup.sh
```

If you prefer executing directly:

```bash
chmod +x ./setup.sh
./setup.sh
```

After install, it runs `jenkins-cli login` unless credentials are already found
in the environment or config file (then you can choose to skip).

Install dependencies:

```bash
bun install
```

Lint:

```bash
bun run lint
```

Apply fixes:

```bash
bun run lint:fix
```

## Global CLI

Build and install once:

```bash
bun run install:global
```

This uses `bun link` to symlink the CLI, so updates are simple.

### Updating an Existing Installation

After pulling new changes or making edits, just rebuild:

```bash
bun run build
```

The global `jenkins-cli` command automatically uses the updated build since it's symlinked.

To check your current version:

```bash
jenkins-cli --version
```

### Uninstalling

```bash
bun unlink jenkins-cli-ts
```

## Usage

If you have not installed the global CLI, replace `jenkins-cli` with
`bun run src/index.ts` in the commands below.

List jobs (uses local cache by default):

```bash
jenkins-cli list
```

Login and save credentials to config:

```bash
jenkins-cli login
```

Login with a custom branch parameter name:

```bash
jenkins-cli login --branch-param BRANCH_TAG
```

Refresh the cache from Jenkins:

```bash
jenkins-cli list --refresh
```

Search with natural language:

```bash
jenkins-cli list --search "api prod deploy"
```

Trigger a build (or deploy) with a branch:

```bash
jenkins-cli build --job "api-prod" --branch main
```

```bash
jenkins-cli deploy --job "api-prod" --branch main
```

Use the job's default branch explicitly:

```bash
jenkins-cli build --job "api-prod" --default-branch
```

Check status:

```bash
jenkins-cli status --job "api-prod"
```

## Notes

- Job lists are cached in the OS cache directory. Use `--refresh` to update.
  macOS: `~/Library/Caches/jenkins-cli/jobs.json`, Linux:
  `${XDG_CACHE_HOME:-~/.cache}/jenkins-cli/jobs.json`, Windows:
  `%LOCALAPPDATA%\jenkins-cli\jobs.json`.
- `deploy` is an alias for `build`.
- `build`/`deploy` always uses `buildWithParameters`. Branch is required unless you pass
  `--default-branch`.
- Natural language job matching is supported; ambiguous matches prompt for a
  specific selection.
- Use `--non-interactive` to disable prompts and fail fast.
- Outputs use `OK:`, `ERROR:`, and `HINT:` prefixes for easy parsing.
