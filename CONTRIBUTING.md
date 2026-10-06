# Contributing

Thanks for helping improve Jenkins CLI. This page covers what a change needs
before it can merge.

## 1.0 release candidate

The project is in release candidates for `1.0.0`. Exit codes and `--json` /
`--jsonl` output shapes are frozen: scripts and agents depend on them. Do not
rename, remove, or change the meaning of an exit code, error `code`, or JSON
field. If a change truly needs to, open an issue first.

## Setup

The project uses [Bun](https://bun.sh). Follow the
[Development](README.md#development) section of the README to install, run, and
build. [Testing](docs/testing.md) lists the prerequisites for the integration
suites.

## Checks

Both gates must pass locally before you open a pull request:

```bash
bun run verify
bun run test:integration:jenkins
```

- `verify` runs formatting, lint, types, unused-code checks, the test suite with
  coverage, and the build. Run `bun run format` to fix formatting.
- `test:integration:jenkins` builds `dist/jenkins-cli` and runs it against a
  disposable Jenkins controller. A change to Jenkins-facing behaviour must add
  or update a scenario in `tests/integration/jenkins.test.ts`. Use only the
  synthetic jobs and credentials of the disposable controller, never a real
  one.

## Test isolation

Bun shares state in ways that make tests pass alone and fail together:

- Run tests with `bun run test`, not bare `bun test`. The script passes
  `--isolate` so each file gets a fresh module registry, as in CI.
- Within a file, mocks are shared. Do not call `mock.restore()` in `afterEach`;
  it does not undo `mock.module` and wipes every other mock in the file.
- Create `spyOn` spies in `beforeEach` and call `mockRestore()` in `afterEach`.
- Capture real functions with `.bind()` before calling `mock.module`, because
  live namespace references become mocks afterwards.
- Tests that assert on ANSI escape codes must call `forceColorForFile()` from
  `tests/helpers.force-color.ts`.

## Branches and pull requests

- Work on a branch, never directly on `main`, and open the pull request against
  `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages and pull request titles, for example `fix(logs): ...` or
  `docs: ...`.
- Start the description with why the change is needed, then what changed and
  how you tested it. Show output before and after when behaviour changes.
- CI must be green before merge, including the real-Jenkins integration job.
- Keep a pull request to one change. Note unrelated problems in the description
  instead of fixing them in the same diff.
