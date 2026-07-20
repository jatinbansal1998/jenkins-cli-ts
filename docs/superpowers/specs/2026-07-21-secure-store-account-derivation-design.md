# Secure-Store Account Derivation Design

## Scope

Replace the readable `profile@host` secure-store account with one uniform,
versioned account derivation for every Jenkins profile. This prevents profile
names, ports, IPv6 hosts, paths, Unicode, and input length from violating
`cross-keychain`'s account constraints.

This Keychain feature has not had a GA rollout and has no existing users whose
entries require compatibility. The implementation therefore makes a clean
cutover without legacy lookup, migration, or dual-write behavior.

## Account identity

The secure-store entry remains keyed by the pair:

```text
(service, account)
```

The service remains the constant `jenkins-cli`. The account becomes:

```text
v1.<base64url(SHA-256(canonical-payload))>
```

SHA-256 produces 32 bytes. Unpadded Base64url encodes those bytes as 43
characters, so the complete account is always 46 characters and contains only
characters accepted by `cross-keychain`. Standard Base64 is not used because
its `+`, `/`, and `=` characters are not all valid account characters.

The `v1.` prefix identifies the derivation format. Any future change to the
canonical payload or digest algorithm must use a new version prefix rather
than silently changing the meaning of `v1`.

## Canonical payload

The digest input is the UTF-8 encoding of this JSON tuple:

```json
["<normalized-profile-name>", "<normalized-full-jenkins-url>"]
```

Using a JSON tuple avoids delimiter ambiguity. Profile names use the existing
trim normalization. Jenkins URLs use the CLI's existing normalization: trim
surrounding whitespace, parse as an HTTP or HTTPS URL, apply URL
canonicalization, preserve non-default ports and controller paths, and remove
trailing slashes.

The full normalized controller URL is included instead of only its host. This
keeps profiles for `https://host/one` and `https://host/two`, or controllers on
different schemes and ports, isolated from each other.

The Jenkins username and API token are deliberately excluded. A profile holds
one current Jenkins identity, so changing its username or rotating its token
must update the same secure-store entry rather than create an orphaned entry.

For example, the canonical payload:

```json
["default", "https://jenkins.pluang.org"]
```

derives this account:

```text
v1.6wqHyJLxhkabpPotDmbQp23XKq4PPcDTbGiTq65bvWg
```

## Implementation boundary

`buildSecureStoreAccount` remains the only account-derivation boundary. It
normalizes the profile name and Jenkins URL, constructs the canonical payload,
hashes it with Bun's SHA-256 implementation, and returns the versioned
Base64url account.

The current URL normalizer lives in `env.ts`, which already imports the
secure-store module. Move that pure normalization function to a focused shared
module and re-export it from `env.ts` so existing callers keep their API. Both
environment resolution and account derivation then use one implementation
without introducing an import cycle or duplicating URL rules.

All secure-store workflows already call this helper, so login, automatic
plaintext migration, token resolution, auth diagnostics, rename, logout, and
logout rollback adopt the new format without command-specific encoding rules.
Callers must never construct or interpret secure-store accounts themselves.

Changing a profile name or normalized controller URL changes its account.
Existing transactional rename and login behavior remains responsible for
writing and verifying the destination, updating config, deleting the source,
and compensating on failure. Reusing the same profile name and normalized URL
updates the existing `(service, account)` entry.

## Compatibility and failure behavior

Do not read, migrate, or delete the former `profile@host` account as part of
normal operations. Pre-release development entries created with the old
format may remain unused and can be removed manually. Affected development
profiles can log in again; plaintext profiles such as the reported
`dev/stage 2` profile will migrate normally using the new account.

Account derivation is synchronous and does not expose the canonical payload,
profile name, controller URL, username, token, or account through analytics.
Existing secure-store errors and verified-write/rollback behavior remain
unchanged.

## Testing

Add account-derivation tests before changing production code. Cover:

- The exact deterministic account for a known profile and controller.
- The `v1.` prefix, 46-character length, and `cross-keychain` character set.
- Equivalent surrounding whitespace and trailing-slash URL forms.
- Distinct accounts for different profiles, schemes, hosts, ports, and paths.
- Profile names containing spaces, slashes, punctuation, delimiters, and
  Unicode.
- Long valid inputs without exceeding the account limit.
- Tuple-boundary cases that would collide under naive string concatenation.
- Existing login, plaintext migration, token resolution, auth diagnostics,
  rename, logout, rollback, and real secure-store lifecycle tests.

After implementation, run:

```text
bun run format
bun run lint
bun run typecheck
bun test
bun run build
```
