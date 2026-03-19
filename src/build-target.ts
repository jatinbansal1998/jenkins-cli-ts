/**
 * Compile-time build target identifier.
 *
 * When compiled via `scripts/build.ts` or `bun build --compile`, the bundler
 * replaces the bare `__BUILD_TARGET__` identifier with a string literal such as
 * `"bun-darwin-arm64"` using the `define` option.
 *
 * When running from source (`bun run src/index.ts`), the identifier is never
 * replaced, so the declared fallback value `"source"` is used instead.
 */

declare const __BUILD_TARGET__: string | undefined;

/**
 * The platform target this binary was built for.
 *
 * Examples: `"bun-darwin-arm64"`, `"bun-linux-x64-musl"`, `"source"`.
 */
export const BUILD_TARGET: string =
  typeof __BUILD_TARGET__ !== "undefined" ? __BUILD_TARGET__ : "source";
