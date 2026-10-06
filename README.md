# Jenkins CLI

[![CI](https://github.com/jatinbansal1998/jenkins-cli-ts/actions/workflows/post-merge.yml/badge.svg?branch=main)](https://github.com/jatinbansal1998/jenkins-cli-ts/actions/workflows/post-merge.yml?query=branch%3Amain)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/jatinbansal1998/jenkins-cli-ts)
[![CodeQL](https://github.com/jatinbansal1998/jenkins-cli-ts/actions/workflows/codeql.yml/badge.svg)](https://github.com/jatinbansal1998/jenkins-cli-ts/actions/workflows/codeql.yml)
[![stable](https://img.shields.io/github/v/release/jatinbansal1998/jenkins-cli-ts?color=blue&label=stable)](https://github.com/jatinbansal1998/jenkins-cli-ts/releases/latest)
[![prerelease](https://img.shields.io/github/v/release/jatinbansal1998/jenkins-cli-ts?include_prereleases&color=orange&label=prerelease)](https://github.com/jatinbansal1998/jenkins-cli-ts/releases)
[![built with Bun](https://img.shields.io/badge/built%20with-Bun-F9F1E5?logo=bun&logoColor=000)](https://bun.sh)
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
jenkins-cli logs --job api --build lastSuccessful
jenkins-cli tests --job api --build 42
jenkins-cli artifacts --job api --build 42 --download --dest ./artifacts
```

Use `--job-url` or `--build-url` when you already have a Jenkins URL. Commands
such as `status` and `logs` use the latest build unless you select one explicitly.
`--build` also accepts `lastSuccessful`, `lastStable`, `lastFailed`, or
`lastCompleted`.

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
token in plaintext in `jenkins-cli-config.json` in the config directory.
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

The config directory holds the config file, logs, and update state. It is
`JENKINS_CLI_CONFIG_DIR` when set (an absolute path, used as-is), else
`$XDG_CONFIG_HOME/jenkins-cli` when `XDG_CONFIG_HOME` is set, else
`%APPDATA%\jenkins-cli` on Windows, else `~/.config/jenkins-cli`. `auth status`
and `--help` print the resolved path. The job cache lives in the platform cache
directory instead.

Each Jenkins request times out after 10 seconds and a failed connection is
retried once. For a slow controller, for example one behind a VPN, raise them per
run, per shell, or per profile. The flag beats the env var, which beats the
profile field:

| Setting           | Flag              | Env var              | Profile field        | Default |
| ----------------- | ----------------- | -------------------- | -------------------- | ------- |
| Request timeout   | `--timeout <dur>` | `JENKINS_TIMEOUT_MS` | `"timeoutMs": 30000` | `10s`   |
| Transport retries | `--retries <n>`   | `JENKINS_RETRIES`    | `"retries": 3`       | `1`     |

Durations use the same syntax as `wait --timeout`: `500ms`, `30s`, `2m`, `1h`,
or a bare number of milliseconds. Under `wait`, `--timeout` stays the overall
wait deadline, so set the request timeout there with `JENKINS_TIMEOUT_MS` or the
profile. Retries apply only to requests that are safe to repeat: triggering a
build, creating an item, and approving or aborting an input never retry, because
a lost response may hide a request that Jenkins already carried out.

## Scripts and agents

Use `--json` for structured output and `help --json` to discover supported
commands and options:

```bash
jenkins-cli help --json
jenkins-cli status --job api --json
jenkins-cli history --job api --limit 20 --json
jenkins-cli list --search api --limit 10 --json
jenkins-cli build api --branch main --watch --json
jenkins-cli logs --job api --build 42 --jsonl
```

`--json` disables prompts and writes one JSON document to stdout, with `ok`,
`command`, and `data` on success or `ok: false` and `error` on failure. Log
streaming uses `--jsonl` instead. Diagnostics go to stderr.

A failure is `{ ok: false, error: { code, message, hints, details? } }`.
`hints` holds the same next steps the text output prints, and is `[]` when
there are none. `details` is present only for codes that carry structured
context. `JOB_AMBIGUOUS` and `JOB_NOT_FOUND` list the jobs the name could mean:

```json
{
  "ok": false,
  "error": {
    "code": "JOB_AMBIGUOUS",
    "message": "Job name is ambiguous for \"deploy\".",
    "hints": [
      "Options: team/deploy-api, team/deploy-web",
      "Pass `--job <exact name>` or `--job-url <url>`."
    ],
    "details": {
      "candidates": [
        {
          "name": "team/deploy-api",
          "url": "https://jenkins.example.com/job/team/job/deploy-api"
        },
        {
          "name": "team/deploy-web",
          "url": "https://jenkins.example.com/job/team/job/deploy-web"
        }
      ]
    }
  }
}
```

A `--jsonl` stream ends with `{ "type": "error", "error": { ... } }` carrying
the same `error` body.

`history --limit <n>` sets how many builds each page holds (default 5) and works
with `--offset`; with `--json` it returns up to `n` builds in one document.
`list --limit <n>` prints or returns at most `n` jobs after `--search` and
`--active-only`.

For text output without prompts, pass `--non-interactive`. Pipeline input
approval and abort also require `--yes` in non-interactive runs.

`--quiet` prints nothing except errors, which still go to stderr, so a script
can read the result from the exit code alone. It implies `--non-interactive`,
skips the background update check, and cannot be combined with `--json` or
`--jsonl`. Help and `--version` still print.

Color is used only on a terminal. `--no-color` or `NO_COLOR=1` turns it off;
`FORCE_COLOR=1` keeps it on when output is piped.

## Exit codes

The exit code is derived from the error `code` in `--json` output, so both stay
in step.

| Exit  | Meaning                                                                                                      | Example error codes                                            |
| ----- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `0`   | Success                                                                                                      |                                                                |
| `1`   | The build or operation finished unsuccessfully (for example `build --watch` saw `FAILURE`), or another error | `CANCEL_INCOMPLETE`, `UPDATE_FAILED`, `UNEXPECTED_ERROR`       |
| `2`   | Usage: invalid flags, arguments, or config file, or a request Jenkins rejected with HTTP 400                 | `INVALID_USAGE`, `INVALID_BUILD_SELECTOR`, `CONFIG_INVALID`    |
| `3`   | Authentication: missing, unreadable, or rejected credentials                                                 | `CREDENTIALS_MISSING`, `JENKINS_AUTH_ERROR`                    |
| `4`   | Not found: job, build, stage, queue item, input, artifact, or profile                                        | `JOB_NOT_FOUND`, `BUILD_NOT_FOUND`, `JENKINS_NOT_FOUND`        |
| `5`   | A write was refused because the profile is read-only                                                         | `PROFILE_PROTECTED`                                            |
| `6`   | Jenkins was unreachable, timed out, or returned an error or unexpected response                              | `JENKINS_UNREACHABLE`, `JENKINS_TIMEOUT`, `JENKINS_HTTP_ERROR` |
| `124` | `wait --timeout` elapsed before the build finished                                                           |                                                                |
| `130` | Interrupted with Ctrl+C, or a prompt was cancelled                                                           | `OPERATION_CANCELLED`                                          |

The full list of error codes and their exit codes is in
[`src/error-codes.ts`](src/error-codes.ts).

## Diagnostics and privacy

Use `auth status` to diagnose credentials and `--debug` for API diagnostics.
Local logs are stored in the config directory as `error-YYYY-MM-DD.log` and
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

See [Contributing](CONTRIBUTING.md) before opening a pull request, and
[Security](SECURITY.md) to report a vulnerability privately.

- [Build flow](docs/flow/build-flow.md)
- [Prompt system](docs/flow/prompt-system.md)
- [Interactive state diagrams](docs/tui-state-diagrams.md)
- [Homebrew publishing](docs/homebrew.md)
