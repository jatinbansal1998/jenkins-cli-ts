# Jenkins CLI

[![CI](https://github.com/jatinbansal1998/jenkins-cli-ts/actions/workflows/post-merge.yml/badge.svg?branch=main)](https://github.com/jatinbansal1998/jenkins-cli-ts/actions/workflows/post-merge.yml?query=branch%3Amain)
[![stable](https://img.shields.io/github/v/release/jatinbansal1998/jenkins-cli-ts?color=blue&label=stable)](https://github.com/jatinbansal1998/jenkins-cli-ts/releases/latest)
[![License: MIT](https://img.shields.io/github/license/jatinbansal1998/jenkins-cli-ts?color=green)](LICENSE)

Build jobs, stream logs, inspect results, and manage multiple Jenkins profiles
from your terminal. Interactive job search and menus for daily use; JSON output
for scripts and agents. Ships as a native executable. No Java or Bun required.

![Jenkins CLI demo](docs/media/jenkins-cli-demo.gif)

## Install

On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/jatinbansal1998/jenkins-cli-ts/main/install | bash
```

The installer puts `jenkins-cli` in `~/.local/bin`. Add that directory to your
`PATH` if needed.

With Homebrew:

```bash
brew tap jatinbansal1998/tap
brew install jatinbansal1998/tap/jenkins-cli
```

Native binaries for macOS and Linux (x64/arm64, including Linux musl) and Windows
(x64) are also available from [GitHub Releases](https://github.com/jatinbansal1998/jenkins-cli-ts/releases).

Upgrade standalone installs with `jenkins-cli update`, or Homebrew installs with
`brew upgrade jenkins-cli`. On Windows, download the new executable from Releases.

## Quick start

```bash
jenkins-cli auth login --profile work
jenkins-cli auth status
jenkins-cli
```

Login prompts for the Jenkins URL, username, and API token. The first profile
becomes the default. Running `jenkins-cli` opens the job picker, where you can
search jobs, start builds, inspect results, and view logs.

For a direct build:

```bash
jenkins-cli build api --branch main --watch
```

## Common commands

```bash
jenkins-cli list --refresh
jenkins-cli params --job api
jenkins-cli build api --param DEPLOY_ENV=staging --watch
jenkins-cli status --job api
jenkins-cli history --job api
jenkins-cli logs --job api --build 42
jenkins-cli tests --job api --build 42
jenkins-cli artifacts --job api --build 42 --download --dest ./artifacts
```

Use `--job-url` or `--build-url` when you already have a Jenkins URL. Commands
such as `status` and `logs` use the latest build unless you select one explicitly.

| Task            | Commands                                                     |
| --------------- | ------------------------------------------------------------ |
| Monitor work    | `run`, `queue`, `nodes`, `wait`                              |
| Inspect a build | `status`, `history`, `logs`, `tests`, `changes`, `artifacts` |
| Change work     | `build`, `cancel`, `rerun`, `input approve`, `input abort`   |
| Manage items    | `config`, `create`                                           |

Find options and examples in the CLI:

```bash
jenkins-cli --help
jenkins-cli build --help
jenkins-cli help --full
```

## Profiles and credentials

```bash
jenkins-cli auth login --profile prod
jenkins-cli auth list
jenkins-cli auth use work
jenkins-cli auth current
jenkins-cli status --job api --profile prod
```

`auth current` shows which credentials would be used without contacting Jenkins.
`auth status` checks authentication with Jenkins. `auth logout --profile work`
removes local credentials; it does not revoke the token in Jenkins.

Tokens use macOS Keychain, Linux Secret Service, or Windows Credential Manager
when available. If the secure store is unavailable, login warns and stores the
token in plaintext in `~/.config/jenkins-cli/jenkins-cli-config.json`.
`auth login --no-keychain` explicitly selects plaintext storage.

Credentials come from a complete `--url --user --token` set, then an explicit
`--profile`, then the default profile. With no configured profiles, the CLI uses
`JENKINS_URL`, `JENKINS_USER`, and `JENKINS_API_TOKEN`.

To block writes through a profile unless `--confirm-protected` is supplied:

```bash
jenkins-cli auth login --profile prod --protected
```

CSRF crumbs are enabled by default. Controllers that do not need them can opt out
with `JENKINS_USE_CRUMB=false` or `"useCrumb": false` in the profile.

## Scripts and agents

Use `--json` for structured output and `help --json` to discover supported
commands and options:

```bash
jenkins-cli help --json
jenkins-cli status --job api --json
jenkins-cli build api --branch main --watch --json
jenkins-cli logs --job api --build 42 --jsonl
```

`--json` disables prompts and writes one JSON document to stdout, with `ok`,
`command`, and `data` on success or `ok: false` and `error` on failure. Log
streaming uses `--jsonl` instead. Diagnostics go to stderr.

For text output without prompts, pass `--non-interactive`. Pipeline input
approval and abort also require `--yes` in non-interactive runs. `wait` exits
with `0` on success, `1` on a non-success result, `124` on timeout, or `130` when
interrupted.

## Diagnostics and privacy

Use `auth status` to diagnose credentials and `--debug` for API diagnostics.
Local logs are stored in `~/.config/jenkins-cli/` as `error-YYYY-MM-DD.log` and
`api-YYYY-MM-DD.log` and retained for seven days. Active API tokens are masked,
but other error details can contain sensitive data. Review logs before sharing.

No usage analytics or automatic error reports are sent. Update and minimum-version
checks contact GitHub.

## Development

Use [Bun](https://bun.sh), or open the repository in its dev container:

```bash
bun install
bun run dev
bun run verify
bun run test:integration:jenkins
```

`verify` checks formatting, lint, types, unused code, test coverage, and the build.
The integration suite separately exercises the compiled CLI against disposable
Jenkins. See [Testing](docs/testing.md) for prerequisites and focused suites.

- [Build flow](docs/flow/build-flow.md)
- [Prompt system](docs/flow/prompt-system.md)
- [Interactive state diagrams](docs/tui-state-diagrams.md)
- [Homebrew publishing](docs/homebrew.md)
