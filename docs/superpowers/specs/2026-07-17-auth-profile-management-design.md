# Authentication Profile Management Design

## Scope

Extend the canonical `auth` command group with local credential-profile
management:

```text
jenkins-cli auth list
jenkins-cli auth use <name>
jenkins-cli auth current
jenkins-cli auth rename <old> <new>
jenkins-cli auth logout [--profile <name>]
jenkins-cli auth logout --all
```

The commands manage credentials stored by this CLI. Logout does not revoke a
Jenkins API token at the controller because Jenkins exposes no general token
revocation operation through the credentials available to this CLI.

The existing `profile list`, `profile use`, and `profile delete` commands remain
supported compatibility commands. They route through the same profile
operations as the new `auth` commands so their behavior cannot drift.

## Shared profile operations

Move list, selection, rename, and deletion behavior behind a focused profile
management module. The command handlers own argument parsing, confirmation,
text output, and analytics. The shared operations own config validation,
secure-store changes, default-profile selection, rollback, and result data.

Every config update preserves all top-level settings, including `debug` and
`analyticsDisabled`. Profile names use the existing normalization rules.

## Command behavior

### `auth list`

List configured profiles with the active profile marked. Each row contains the
profile name, controller URL, username, and token storage type. With no stored
profiles, print a successful empty-state message.

`profile list` renders the same information.

### `auth use <name>`

Set an existing profile as `defaultProfile`. Reject empty and unknown names
with the available profile names in the remediation text. Selecting the
already-active profile is a successful no-op.

`profile use <name>` uses the same operation.

### `auth current`

Resolve credentials locally using the CLI's established precedence: complete
direct command-line credentials, explicit global `--profile`, configured
default profile, then environment credentials. Do not make a Jenkins network
request.

Render the resolved source, profile label, controller, username, token storage,
and whether a token is present. Never print the token. An unavailable
keychain-backed token is reported as unavailable without exposing secure-store
error details that might contain secrets. An unknown explicitly requested
profile or no resolvable credential source exits with a configuration error.

`auth current` is an inspection command, while `auth status` remains the
network-backed authentication validation command.

### `auth logout [--profile <name>]`

Without `--profile`, target the configured active profile. With `--profile`,
target that exact stored profile. Reject unknown profiles and the absence of an
active profile. Environment and direct command-line credentials are not mutable
by logout.

Interactive execution asks for confirmation. Global `--non-interactive`
execution proceeds without prompting. On success, delete both the local profile
and its matching secure-store entry. For a plaintext-backed profile, deleting
the local profile also deletes its stored token.

`profile delete <name>` uses this same strict deletion operation rather than
the previous best-effort secure-store cleanup.

### `auth logout --all`

Delete every configured profile and all matching secure-store entries.
`--all` and `--profile` are mutually exclusive. Interactive execution asks for
one confirmation covering the complete set. An empty profile set is a
successful no-op.

### `auth rename <old> <new>`

Reject empty names, an unknown source, and an already-existing destination. A
rename to the same normalized name is a successful no-op. Rename the default
profile reference when the source is active.

For plaintext-backed profiles, atomically update the config key. For a
keychain-backed profile, migrate the token from the account derived from the
old profile name and controller to the account derived from the new name and
controller. If the source token is already missing, rename the profile while
preserving that missing-token state. Never print or log the token.

## Strict secure-store semantics

A successful logout means both the config profile and matching secure-store
token are absent. A missing secure-store token counts as already absent. A
secure-store access, deletion, or verification error fails the operation before
the config is changed.

Cross-store changes use compensation so callers never receive success after a
partial operation:

1. Read and retain affected keychain tokens in memory.
2. Delete the affected secure-store entries and verify they are absent.
3. Atomically write the updated config.
4. If the config write fails, restore deleted secure-store entries and report
   whether rollback also failed.

For `--all`, complete and verify all secure-store deletions before writing the
empty profile map. If any deletion fails, restore entries already deleted and
leave the config unchanged.

A keychain-backed rename similarly writes and verifies the destination entry,
updates the config, then deletes and verifies the source entry. On failure it
restores the original config/store state where possible and reports any
rollback failure. The implementation must not leave an unreported duplicate or
orphaned token.

## Output, errors, and analytics

Successful mutating commands print the affected profile name or count and the
resulting active profile when one remains. Failures use `CliError` with a
specific cause and remediation; secrets are excluded from messages, debug
logs, and analytics.

Track the canonical commands independently as `auth:list`, `auth:use`,
`auth:current`, `auth:rename`, and `auth:logout`. Existing compatibility
commands retain their `profile:*` analytics names. Do not record profile names,
controller URLs, usernames, tokens, or secure-store accounts.

## Testing and documentation

Add focused tests for:

- Listing, selecting, and empty profile collections.
- Current-profile resolution from direct arguments, explicit profile, default
  profile, and environment without a network request or token leakage.
- Plaintext and keychain single-profile logout.
- Logout when the secure token is already absent.
- Secure-store read, delete, verification, config-write, and rollback failures.
- `logout --all`, its confirmation, empty state, argument conflict, and rollback.
- Plaintext and keychain rename, active-profile rename, name collision, missing
  source token, and rollback paths.
- Compatibility routing for `profile list`, `profile use`, and `profile delete`.
- Preservation of `debug`, `analyticsDisabled`, and unrelated profiles.
- Auth help, root help, and secret-free analytics.

Update the README credential and command reference sections. Document that
logout removes local credentials but does not revoke the Jenkins-side token.

After implementation, run `bun run format`, `bun run lint`,
`bun run typecheck`, `bun test`, and `bun run build`.
