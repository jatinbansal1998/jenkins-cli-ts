# Jenkins CLI (MVP)

Minimal Jenkins CLI with `list`, `build`, and `status` commands. Designed for
interactive use and AI-agent automation with clear, English error messages.

## Setup

Set required environment variables:

- `JENKINS_URL` (e.g., `https://jenkins.example.com`)
- `JENKINS_USER`
- `JENKINS_API_TOKEN`

The CLI also reads these values from `~/.config/jenkins-cli/jenkins-cli-config`
(JSON) if the env vars are not set:

```json
{
  "jenkinsUrl": "https://jenkins.example.com",
  "jenkinsUser": "your-username",
  "jenkinsApiToken": "your-token"
}
```

Environment variables always take precedence.

## Setup script

Run the helper script to set env vars and optionally persist them:

```bash
bash setup.sh
```

If you prefer executing directly:

```bash
chmod +x ./setup.sh
./setup.sh
```

It installs Bun if needed, installs dependencies, installs the CLI globally,
saves values to `~/.config/jenkins-cli/jenkins-cli-config`, and can optionally
add environment variable exports to your shell profile. After saving, open a new
terminal or run `. ~/.zshrc` (or your chosen profile).

Skip installs and only set env vars:

```bash
bash setup.sh --no-install
```

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

Or manually:

```bash
bun run build
bun install -g "file:."
```

If you want a different command name, change the `bin` key in `package.json`,
rebuild, and reinstall.

## Usage

If you have not installed the global CLI, replace `jenkins-cli` with
`bun run src/index.ts` in the commands below.

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

Use the job's default branch explicitly:

```bash
jenkins-cli build --job "api-prod" --default-branch
```

Check status:

```bash
jenkins-cli status --job "api-prod"
```

## Notes

- Job lists are cached in `.jenkins-cli/jobs.json`. Use `--refresh` to update.
- `build` always uses `buildWithParameters`. Branch is required unless you pass
  `--default-branch`.
- Natural language job matching is supported; ambiguous matches prompt for a
  specific selection.
- Use `--non-interactive` to disable prompts and fail fast.
- Outputs use `OK:`, `ERROR:`, and `HINT:` prefixes for easy parsing.
