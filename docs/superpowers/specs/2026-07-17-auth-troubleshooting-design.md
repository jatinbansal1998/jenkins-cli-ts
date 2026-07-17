# Authentication Troubleshooting Command Design

## Scope

Add an `auth` command group that helps users determine whether the CLI has the
right Jenkins credentials and whether Jenkins accepts them, without triggering
or modifying any build:

```text
jenkins-cli auth login
jenkins-cli auth status
jenkins-cli auth status --profile prod
jenkins-cli auth status --url <url> --user <user> --token <token>
```

`auth login` reuses the current login implementation and options. The existing
top-level `jenkins-cli login` command remains a supported compatibility alias,
while primary help and README examples make `auth login` the canonical form.

This scope covers authentication troubleshooting only. Broader controller,
plugin, permission, job-discovery, build, queue, and agent diagnostics belong
in future troubleshooting commands.

## Command architecture

Keep login credential persistence and authentication diagnosis as separate
operations:

- Both `auth login` and the legacy `login` alias route to the existing
  `runLogin` flow. They accept the same profile, URL, username, token,
  branch-parameter, keychain, and non-interactive options.
- `auth status` uses a dedicated read-only authentication diagnostics module.
  It does not use the normal command bootstrap path because missing tokens,
  keychain failures, rejected credentials, and malformed Jenkins responses are
  expected diagnostic outcomes that must not terminate the report early.
- The diagnostics module resolves the credential source, inspects token
  availability, performs one Jenkins probe, and returns a structured result.
  The command owns text rendering and exit behavior.

The diagnostic probe performs only a `GET` request. It never requests a crumb,
writes CLI configuration, changes keychain contents, or calls Jenkins build,
queue, cancellation, or administration endpoints.

## Credential resolution

`auth status` follows the CLI's existing credential precedence:

1. A complete `--url`, `--user`, and `--token` set is treated as direct
   command-line credentials, even when `--profile` is also present.
2. Otherwise, an explicit `--profile <name>` selects that configured profile
   and ignores environment credentials.
3. Otherwise, the configured default profile is used when one exists.
4. If no configured profile exists, environment credentials are used.

Unknown requested profiles and incomplete direct credentials are reported as
configuration failures with targeted remediation. Secrets are never included
in diagnostics, errors, analytics, or debug output.

For a configured profile, token inspection is separate from the network probe:

- A keychain-backed profile resolves the secure-store account using the
  existing profile-and-controller account key, reads the token through the
  existing secure-store adapter, and reports the selected secure-store label.
- A plaintext profile reports `Config file` storage and checks whether its
  configured token is non-empty.
- Direct command-line credentials report `Command line` storage.
- Environment credentials report `Environment variables` storage.

A missing token does not prevent the network request. The command probes the
controller anonymously so it can distinguish a reachable controller with
missing credentials from a DNS, TLS, timeout, or connection failure.

## Jenkins probe

Send one `GET` request to `<controller>/whoAmI/api/json` with Basic
authentication when a token is available. When the token is missing, omit the
Authorization header. Set redirect handling to `manual` so credentials are
never forwarded to an SSO or reverse-proxy login destination and so redirects
remain visible as diagnostic evidence.

Use an abort timeout consistent with the existing Jenkins client. The probe
collects:

- HTTP status and content type.
- The `Location` header for redirects, sanitized to origin and path so query
  parameters and fragments cannot leak.
- The `X-Jenkins` response header as the controller version when present.
- The `authenticated`, `anonymous`, and `name` fields from the Jenkins
  `whoAmI` JSON response.

Authentication succeeds only when Jenkins explicitly returns
`authenticated: true`, does not return `anonymous: true`, and provides a
non-empty effective username. An HTTP 200 response alone is not sufficient.
Contradictory or incomplete identity fields are treated as an unexpected
response rather than guessed into success.

## Output and exit behavior

On success, render a stable text report followed by a success summary:

```text
Profile:          work
Controller:       https://jenkins.company.com
Username:         jatin
Token storage:    macOS Keychain
Token present:    Yes
Authenticated:    Yes
Jenkins user:     jatin.bansal
Jenkins version:  2.516.1

OK: Authentication is working.
```

For direct command-line credentials, `Profile` is `Direct credentials`. For
environment credentials it is `Environment`. Unknown values use `Unknown`;
negative boolean results use `No`.

The command prints every field it can determine even when diagnosis fails. It
exits with status 0 only for explicit, non-anonymous authentication success.
All other outcomes end with a targeted error summary and exit status 1 so the
command is useful in scripts as well as interactively.

## Failure diagnosis

Map failures to specific, actionable conclusions:

- Missing token: report that no token was found, retain any anonymous
  reachability evidence, and recommend `jenkins-cli auth login`.
- Keychain read error: identify the secure store as inaccessible and recommend
  unlocking it or running `auth login` again; still attempt an anonymous
  controller probe.
- HTTP 401: Jenkins rejected the supplied credentials.
- HTTP 403: Jenkins denied the identity endpoint, so authentication could not
  be confirmed. Do not claim that the token is either valid or invalid.
- Redirect: report the sanitized destination and explain that SSO or a reverse
  proxy intercepted the Jenkins API request.
- HTTP 200 with `anonymous: true` or `authenticated: false`: explicitly state
  that Jenkins treated the request as anonymous.
- HTML, malformed JSON, or an unexpected identity shape: report an unexpected
  proxy, SSO, or Jenkins response.
- Timeout, DNS, TLS, or connection failure: state that the controller could not
  be reached and retain the configured profile and token-storage details.
- Missing `X-Jenkins`: authentication may still succeed; render Jenkins version
  as `Unknown` without failing an otherwise valid result.

Do not print token values, Basic authorization data, redirect query strings, or
raw response bodies. Normal debug logging must preserve the existing
authorization and cookie redaction behavior.

## Analytics

Track `auth:login`, legacy `login`, and `auth:status` as distinct command names
without recording controller URLs, usernames, profile names, token details,
redirect destinations, Jenkins users, or Jenkins versions. Existing coarse
command outcome and Jenkins API health fields may be reused.

## Testing and documentation

Add focused tests for:

- Default-profile, explicit-profile, direct command-line, and environment
  credential resolution.
- Unknown profiles and incomplete direct credentials.
- Keychain token present, missing, and read-error cases.
- Plaintext config, keychain, command-line, and environment storage labels.
- Authenticated, anonymous, HTTP 401, HTTP 403, redirect, HTML, malformed JSON,
  incomplete identity, timeout, and network-error probe results.
- Jenkins username and `X-Jenkins` version extraction.
- Redirect sanitization and the absence of token or query-string leakage.
- Complete report rendering and success/failure exit behavior.
- `auth login` and legacy `login` routing to the same implementation and
  options.
- Primary and command-specific help text.

Update the README quick start, credential setup, command reference, and
troubleshooting guidance. Document `auth login` as canonical, state that
top-level `login` remains supported, and include successful and failing
`auth status` examples.

After implementation, run `bun run format`, `bun run lint`,
`bun run typecheck`, `bun test`, and `bun run build`.
