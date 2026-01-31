# Jenkins CLI (MVP)

Minimal Jenkins CLI with `list`, `build`, and `status` commands. Designed for
interactive use and AI-agent automation with clear, English error messages.

## Setup

Set required environment variables:

- `JENKINS_URL` (e.g., `https://jenkins.example.com`)
- `JENKINS_USER`
- `JENKINS_API_TOKEN`

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

## Usage

List jobs (uses local cache by default):

```bash
bun run src/index.ts list
```

Refresh the cache from Jenkins:

```bash
bun run src/index.ts list --refresh
```

Search with natural language:

```bash
bun run src/index.ts list --search "api prod deploy"
```

Trigger a build with a branch:

```bash
bun run src/index.ts build --job "api-prod" --branch main
```

Use the job's default branch explicitly:

```bash
bun run src/index.ts build --job "api-prod" --default-branch
```

Check status:

```bash
bun run src/index.ts status --job "api-prod"
```

## Notes

- Job lists are cached in `.jenkins-cli/jobs.json`. Use `--refresh` to update.
- `build` always uses `buildWithParameters`. Branch is required unless you pass
  `--default-branch`.
- Natural language job matching is supported; ambiguous matches prompt for a
  specific selection.
- Use `--non-interactive` to disable prompts and fail fast.
- Outputs use `OK:`, `ERROR:`, and `HINT:` prefixes for easy parsing.
