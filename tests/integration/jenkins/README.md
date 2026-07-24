# Jenkins build rejection reproduction

This fixture reproduces Jenkins build-trigger responses using only synthetic
data. It starts a disposable Jenkins controller on an ephemeral localhost port,
installs the pinned `git`, `git-parameter`, and Pipeline plugins, and provisions
an admin user through `init.groovy`.

The harness creates a local bare Git repository with `main` and
`feature-alpha`, mounts it into the container, and configures the Pipeline job
`demo-app-deploy` with:

- `BRANCH_TAG`: Git Parameter, `PT_BRANCH`, sourced from that repository
- `Test`: boolean

No external Jenkins controller or repository is contacted. The container,
temporary repository, Jenkins home, credentials, and integration image are
removed when the run finishes.

## Run

Docker must be available:

```sh
bun run test:integration:jenkins-build-errors
```

The standard `bun run test:integration:jenkins` command also runs this suite,
so the existing pull-request and post-merge GitHub Actions Jenkins jobs validate
these responses against their disposable controller.

The test builds `dist/jenkins-cli`, prints the raw response status, `x-error`,
content type, and normalized body for every scenario, then verifies the
compiled CLI output.

To include before/after output from another executable:

```sh
JENKINS_INTEGRATION_BEFORE_CLI=/path/to/baseline/jenkins-cli \
  bun run test:integration:jenkins-build-errors
```

## Findings

Captured against Jenkins 2.568.1 with Git Parameter
`462.463.v496a_59f698e5`:

| Scenario                                                         | Status | Real signal from Jenkins                                                                           | CLI behavior                                                             |
| ---------------------------------------------------------------- | -----: | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Existing `main` branch                                           |    201 | Empty body; queue `Location` may be present                                                        | Reports the build as triggered, queued, or started                       |
| Missing `no-such-branch`                                         |    400 | `x-error: Parameter BRANCH_TAG provided value 'no-such-branch' is invalid`; HTML repeats the error | Reports HTTP 400 and the `x-error` without adding a mapped hint          |
| `BRANCH_TAG` sent to a parameterized job that does not define it |    201 | Empty body; Jenkins ignores the unknown parameter                                                  | Preserves the existing metadata warning and reports the build trigger    |
| Unknown job                                                      |    404 | HTML says the page may not exist or the caller may lack permission; no `x-error`                   | Reports HTTP 404 with the readable Jenkins response body                 |
| Disabled `demo-app-deploy`                                       |    409 | No `x-error`; HTML/plain error content contains `demo-app-deploy is not buildable`                 | Reports HTTP 409 with `demo-app-deploy is not buildable`; no mapped hint |

The disabled check runs with a valid branch. Jenkins returns 409 before Git
Parameter validation, confirming disabled-job handling takes precedence.

The CLI uses the same generic extraction for every non-success Jenkins
response: `x-error` first, then compact JSON or readable text extracted from the
body, then a status-only fallback. Controller details are limited to 2,000
characters, and executable HTML content is removed. The CLI does not attempt to
map controller errors to a growing set of hand-authored hints.
