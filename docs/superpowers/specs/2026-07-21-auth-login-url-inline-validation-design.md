# Auth Login URL Inline Validation

## Goal

Keep the interactive `Jenkins URL` prompt open when the entered value is
invalid so the user can correct it immediately instead of restarting
`jenkins-cli auth login`.

## Behavior

- Interactive login validates a non-empty URL with the existing `normalizeUrl`
  function inside the prompt's `validate` callback.
- A valid `http://` or `https://` URL proceeds through the existing login flow.
- A malformed URL or unsupported protocol displays the existing `CliError`
  message and first hint inline, then waits for another value.
- An empty value remains `Value required.` unless an existing profile URL is
  available.
- Existing profile fallback remains valid when the prompt is submitted empty.
- `--url` and `--non-interactive` behavior remain unchanged: invalid values fail
  immediately through the existing post-resolution `normalizeUrl` call.
- The CLI does not silently add `https://` because local Jenkins controllers may
  intentionally use `http://`.

## Implementation

Add a small URL-prompt validation helper in `src/commands/login.ts` and use it
from `resolveUrl`. The helper calls `normalizeUrl`, returns no message for a
valid value, and converts a `CliError` into one concise inline message. The
existing normalization after `resolveUrl` remains the authoritative value used
for browser opening and profile persistence.

## Tests

Add focused unit coverage for:

- a URL without a scheme returning the full-URL guidance;
- an unsupported protocol returning the HTTP(S) guidance;
- valid HTTP(S) URLs passing validation;
- empty input with and without an existing profile URL.

Run formatting, linting, type checking, the focused test file, the full test
suite, and the build because the change affects compiled CLI behavior.
