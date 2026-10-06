# Security policy

## Supported versions

Only the latest release receives security fixes. Update with
`jenkins-cli update`, or `brew upgrade jenkins-cli` for Homebrew installs.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/jatinbansal1998/jenkins-cli-ts/security/advisories/new).
Do not open a public issue, discussion, or pull request for a vulnerability.

Include the affected version (`jenkins-cli --version`), your OS, steps to
reproduce, and the impact you expect. Remove tokens and internal hostnames from
anything you attach.

## Scope

In scope:

- The `jenkins-cli` binary and its release assets.
- The [`install`](install) script.
- The update path: `jenkins-cli update`, the background update check, and the
  minimum-version check.
- Credential storage: the OS keychain integration and the plaintext fallback in
  the config directory (`~/.config/jenkins-cli/` by default).

Out of scope: Jenkins itself, Jenkins plugins, and controllers you point the CLI
at.

## Logs

The CLI writes local error and API logs and masks active API tokens in them.
Other details from Jenkins or a proxy can still appear. See
[Diagnostics and privacy](README.md#diagnostics-and-privacy) before sharing a
log.
