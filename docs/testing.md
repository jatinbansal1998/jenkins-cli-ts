# Testing

Run the normal local checks with Bun:

```bash
bun install
bun run verify
```

`verify` checks formatting, lint, types, unused code, the isolated test suite with
coverage, and the native build. It stops on failure and does not rewrite tracked
sources. To run individual checks, use the scripts in [package.json](../package.json).

Use `bun run test`, not bare `bun test`. The script passes `--isolate` to prevent
module mocks leaking between files. Coverage is written to `coverage/lcov.info`;
it does not measure code executing inside compiled CLI child processes.

## Disposable Jenkins

```bash
bun run test:integration:jenkins
```

The runner provisions a secured Jenkins LTS controller and synthetic jobs on a
random local port, exercises `dist/jenkins-cli`, and removes the controller.
Use only this disposable controller for integration tests. Override the image
with `JENKINS_TEST_IMAGE` when testing a different Jenkins version.

Docker is required. Linux also needs `dbus-run-session`, `gnome-keyring-daemon`,
`secret-tool`, and `strace`; the wrapper creates a temporary Secret Service session. macOS uses
Keychain. CI runs acceptance tests on Linux, macOS, and Windows.

## Network faults and connection inventory

```bash
bun run test:network:jenkins
bun run test:network:jenkins --mutation
```

Linux and macOS test latency, resets, truncated responses, and timeouts through
Toxiproxy. Build/create cases drop responses after Jenkins commits and check
that requests were not duplicated. These scenarios also run in the normal
integration suite. The runner downloads and verifies Toxiproxy automatically.

Linux uses `strace` to record destination IPs and ports for non-interactive CLI
child processes. Sanitized reports are written under
`test-artifacts/jenkins-*/connections/`. Incomplete traces fail, as do unexpected
non-controller destinations in Jenkins-only scenarios. A separate observation
scenario records external calls, including the GitHub minimum-version check.

The inventory does not record request bodies, headers, credentials, or full
arguments. It is not a firewall and cannot identify encrypted URLs from IPs.
Unconnected UDP, inherited sockets, interactive sessions, the controller, and
tooling downloads are outside the audit. macOS and Windows do not run this audit.

## Load tests

```bash
bun run test:load:jenkins
JENKINS_LOAD_CONCURRENCY=8 JENKINS_LOAD_SECONDS=60 bun run test:load:jenkins
```

The Linux/macOS runner seeds a disposable controller, then compares concurrent
read commands against serial baselines using a shared isolated cache. Traffic
is read-only after setup. Results include latency percentiles, throughput,
failures, and resource samples in `load.json`. Native macOS resource sampling
is unavailable. Setup and tracing are excluded from latency measurements.

| Setting                    | Default    | Range      |
| -------------------------- | ---------- | ---------- |
| `JENKINS_LOAD_CONCURRENCY` | 4 workers  | 1–32       |
| `JENKINS_LOAD_SECONDS`     | 30 seconds | 1–600      |
| `JENKINS_LOAD_TIMEOUT_MS`  | 15000 ms   | 100–120000 |
| `JENKINS_LOAD_P95_MS`      | 5000 ms    | 1–120000   |

Any failed sample or exceeded p95 limit fails the run. These limits apply to a
small synthetic workload, not a production performance guarantee. Compare runs
using the same workload and machine. The manual **Jenkins CLI load test** GitHub
Actions workflow uploads reports; PR and post-merge integration jobs upload
network reports. Generated artifacts are gitignored.

## Mutation checks

```bash
bun run test:mutation
bun run test:mutation:jenkins
```

The first command injects protocol bugs into unit-test runs. The second uses
temporary CLI copies and requires the real Jenkins scenarios to catch them.
