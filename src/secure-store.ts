/**
 * OS-native secure storage for Jenkins API tokens.
 *
 * This CLI ships as a Bun-compiled native binary, so native npm modules
 * (keytar, etc.) are not usable. Instead we shell out to the platform's
 * credential tooling:
 *   - macOS: the `security` CLI (login keychain)
 *   - Linux: libsecret's `secret-tool` (Secret Service / gnome-keyring)
 *
 * Tokens are passed via stdin where possible (Linux). On macOS the
 * `security add-generic-password -w <token>` argv form is the standard
 * approach and is accepted here.
 */

/** Keychain / keyring service name used for all entries. */
export const SECURE_STORE_SERVICE = "jenkins-cli";

/** Result of running a platform credential command. */
export type SecureStoreCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Runs an external command, optionally feeding `stdin`, and captures output. */
export type SecureStoreCommandRunner = (
  cmd: string[],
  stdin?: string,
) => Promise<SecureStoreCommandResult>;

/** Injectable dependencies (real implementations used unless overridden). */
export type SecureStoreDeps = {
  platform?: NodeJS.Platform;
  hasBinary?: (name: string) => boolean;
  run?: SecureStoreCommandRunner;
};

/** Error raised when the keychain is reachable but the operation failed. */
export class SecureStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureStoreError";
  }
}

// macOS `security` exits 44 when the requested item does not exist.
const MACOS_ITEM_NOT_FOUND_EXIT = 44;

const defaultRun: SecureStoreCommandRunner = async (cmd, stdin) => {
  const proc = Bun.spawn(cmd, {
    stdin: stdin !== undefined ? Buffer.from(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function resolvePlatform(deps: SecureStoreDeps): NodeJS.Platform {
  return deps.platform ?? process.platform;
}

function resolveHasBinary(deps: SecureStoreDeps): (name: string) => boolean {
  return deps.hasBinary ?? ((name: string) => Bun.which(name) !== null);
}

function resolveRun(deps: SecureStoreDeps): SecureStoreCommandRunner {
  return deps.run ?? defaultRun;
}

/**
 * Builds a stable, per-profile account identifier for keychain entries.
 * Uses the profile name and Jenkins host so the same profile name against
 * different hosts does not collide.
 */
export function buildSecureStoreAccount(
  profileName: string,
  jenkinsUrl: string,
): string {
  const name = profileName.trim() || "default";
  let host = jenkinsUrl.trim();
  try {
    host = new URL(jenkinsUrl).host || host;
  } catch {
    // Fall back to the raw value if it is not a parseable URL.
  }
  return `${name}@${host}`;
}

/**
 * Returns true when an OS-native secure store is present and usable on this
 * platform. Detection is based on the presence of the platform binary; a
 * locked keyring is only surfaced at set/get time.
 */
export function isSecureStoreAvailable(deps: SecureStoreDeps = {}): boolean {
  const platform = resolvePlatform(deps);
  const hasBinary = resolveHasBinary(deps);
  if (platform === "darwin") {
    return hasBinary("security");
  }
  if (platform === "linux") {
    return hasBinary("secret-tool");
  }
  return false;
}

/** Human-readable name of the backing secure store for the current platform. */
export function secureStoreLabel(deps: SecureStoreDeps = {}): string {
  const platform = resolvePlatform(deps);
  if (platform === "darwin") {
    return "macOS Keychain";
  }
  if (platform === "linux") {
    return "libsecret keyring";
  }
  return "OS secure store";
}

/** Stores (or updates) a token for the given account. */
export async function setToken(
  account: string,
  token: string,
  deps: SecureStoreDeps = {},
): Promise<void> {
  const platform = resolvePlatform(deps);
  const run = resolveRun(deps);

  if (platform === "darwin") {
    const result = await run([
      "security",
      "add-generic-password",
      "-U",
      "-s",
      SECURE_STORE_SERVICE,
      "-a",
      account,
      "-w",
      token,
    ]);
    if (result.exitCode !== 0) {
      throw new SecureStoreError(
        describeFailure("store the token in the macOS Keychain", result),
      );
    }
    return;
  }

  if (platform === "linux") {
    const result = await run(
      [
        "secret-tool",
        "store",
        "--label",
        `${SECURE_STORE_SERVICE} ${account}`,
        "service",
        SECURE_STORE_SERVICE,
        "account",
        account,
      ],
      token,
    );
    if (result.exitCode !== 0) {
      throw new SecureStoreError(
        describeFailure("store the token in the libsecret keyring", result),
      );
    }
    return;
  }

  throw new SecureStoreError(
    "Secure token storage is not supported on this platform.",
  );
}

/** Retrieves a token for the given account, or null when none is stored. */
export async function getToken(
  account: string,
  deps: SecureStoreDeps = {},
): Promise<string | null> {
  const platform = resolvePlatform(deps);
  const run = resolveRun(deps);

  if (platform === "darwin") {
    const result = await run([
      "security",
      "find-generic-password",
      "-s",
      SECURE_STORE_SERVICE,
      "-a",
      account,
      "-w",
    ]);
    if (result.exitCode === 0) {
      return stripTrailingNewline(result.stdout) || null;
    }
    if (result.exitCode === MACOS_ITEM_NOT_FOUND_EXIT) {
      return null;
    }
    throw new SecureStoreError(
      describeFailure("read the token from the macOS Keychain", result),
    );
  }

  if (platform === "linux") {
    const result = await run([
      "secret-tool",
      "lookup",
      "service",
      SECURE_STORE_SERVICE,
      "account",
      account,
    ]);
    if (result.exitCode === 0) {
      return stripTrailingNewline(result.stdout) || null;
    }
    // `secret-tool lookup` exits non-zero with no output when the item is
    // simply absent. A populated stderr indicates a real backend error.
    if (result.stderr.trim() === "") {
      return null;
    }
    throw new SecureStoreError(
      describeFailure("read the token from the libsecret keyring", result),
    );
  }

  throw new SecureStoreError(
    "Secure token storage is not supported on this platform.",
  );
}

/**
 * Deletes a token for the given account. Best-effort: returns true when an
 * entry was removed, false otherwise, and never throws for missing items.
 */
export async function deleteToken(
  account: string,
  deps: SecureStoreDeps = {},
): Promise<boolean> {
  const platform = resolvePlatform(deps);
  const run = resolveRun(deps);

  try {
    if (platform === "darwin") {
      const result = await run([
        "security",
        "delete-generic-password",
        "-s",
        SECURE_STORE_SERVICE,
        "-a",
        account,
      ]);
      return result.exitCode === 0;
    }
    if (platform === "linux") {
      const result = await run([
        "secret-tool",
        "clear",
        "service",
        SECURE_STORE_SERVICE,
        "account",
        account,
      ]);
      return result.exitCode === 0;
    }
  } catch {
    // Best-effort: ignore deletion failures.
  }
  return false;
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function describeFailure(
  action: string,
  result: SecureStoreCommandResult,
): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  const suffix = detail ? `: ${detail}` : ` (exit code ${result.exitCode}).`;
  return `Failed to ${action}${suffix}`;
}
