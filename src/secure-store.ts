/**
 * OS-native secure storage for Jenkins API tokens.
 *
 * Secret persistence is delegated to cross-keychain. On macOS the CLI also
 * asks `security` whether the default keychain can be written without a GUI
 * prompt. cross-keychain reports that backend as present whenever the
 * `security` binary exists, including when the login keychain is locked.
 */
import {
  deletePassword,
  getPassword,
  listBackends,
  setPassword,
  type BackendInfo,
} from "cross-keychain";
import { normalizeUrl } from "./jenkins-url";

/** Keychain / keyring service name used for all entries. */
const SECURE_STORE_SERVICE = "jenkins-cli";

type SecureStoreKeychain = {
  getPassword: typeof getPassword;
  setPassword: typeof setPassword;
  deletePassword: typeof deletePassword;
  listBackends: typeof listBackends;
};

/** Injectable dependencies (real implementations used unless overridden). */
export type SecureStoreDeps = {
  keychain?: Partial<SecureStoreKeychain>;
  /**
   * macOS only. When omitted, the CLI runs `/usr/bin/security`. Tests pass a
   * stub so a locked login keychain does not require a Mac. The exit code is
   * the only signal used: 0 means the default keychain answered without a
   * prompt. A missing or non-zero exit means the store is not usable.
   */
  runSecurity?: (
    args: readonly string[],
  ) => { exitCode: number } | Promise<{ exitCode: number }>;
};

/** Error raised when the keychain is reachable but the operation failed. */
export class SecureStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureStoreError";
  }
}

const OS_BACKEND_LABELS: Record<string, string> = {
  "native-macos": "macOS Keychain",
  macos: "macOS Keychain",
  "native-linux": "Freedesktop Secret Service",
  "secret-service": "Freedesktop Secret Service",
  "native-windows": "Windows Credential Manager",
  windows: "Windows Credential Manager",
};

function resolveKeychain(deps: SecureStoreDeps = {}): SecureStoreKeychain {
  return {
    getPassword: deps.keychain?.getPassword ?? getPassword,
    setPassword: deps.keychain?.setPassword ?? setPassword,
    deletePassword: deps.keychain?.deletePassword ?? deletePassword,
    listBackends: deps.keychain?.listBackends ?? listBackends,
  };
}

/**
 * Builds a stable, versioned account identifier for keychain entries.
 * The fixed-length digest keeps all supported profile names and controller
 * URLs within cross-keychain's account constraints without exposing them.
 */
export function buildSecureStoreAccount(
  profileName: string,
  jenkinsUrl: string,
): string {
  const name = profileName.trim() || "default";
  const canonicalPayload = JSON.stringify([name, normalizeUrl(jenkinsUrl)]);
  const digest = new Bun.CryptoHasher("sha256")
    .update(canonicalPayload)
    .digest("base64url");
  return `v1.${digest}`;
}

/**
 * Returns true when cross-keychain detects an OS-native secure store that
 * can accept a write without prompting. File and null fallback backends do
 * not count: this CLI keeps its plaintext fallback when no OS credential
 * manager can be written.
 *
 * A locked macOS login keychain still advertises a backend. Writing to it
 * waits out cross-keychain's 10s `security` timeout (`User interaction is
 * not allowed`) and then fails. Automatic migration runs before every
 * command, so a profile that stays plaintext pays that timeout on every
 * invocation.
 *
 * `security show-keychain-info` with no keychain argument calls
 * `SecKeychainCopySettings(NULL)`, which is the user-domain default keychain:
 * the same keychain a `security` write with no keychain argument uses, and
 * the keychain `security default-keychain -s` points at. On a locked keychain
 * outside a GUI session it returns immediately with a non-zero status
 * (`errSecInteractionNotAllowed`) instead of waiting for a prompt. A missing
 * binary is the same answer: the store cannot be written.
 */
export async function isSecureStoreAvailable(
  deps: SecureStoreDeps = {},
): Promise<boolean> {
  try {
    const backends = await resolveKeychain(deps).listBackends();
    const backend = preferredOsBackend(backends);
    if (!backend) {
      return false;
    }
    if (isMacOsBackend(backend.id) && !(await macOsKeychainIsWritable(deps))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isMacOsBackend(id: string): boolean {
  return id === "native-macos" || id === "macos";
}

/**
 * True only when the default keychain can be read without a GUI prompt.
 * Any other result, including a missing `security` binary, means a later
 * write would hang or fail, so the store is not usable.
 */
async function macOsKeychainIsWritable(
  deps: SecureStoreDeps,
): Promise<boolean> {
  const runSecurity = deps.runSecurity ?? runSecurityCommand;
  const result = await runSecurity(["show-keychain-info"]);
  return result.exitCode === 0;
}

function runSecurityCommand(args: readonly string[]): { exitCode: number } {
  const result = Bun.spawnSync({
    cmd: ["/usr/bin/security", ...args],
    stdout: "ignore",
    stderr: "ignore",
  });
  return { exitCode: result.exitCode ?? 1 };
}

/** Human-readable name of the backing secure store for the current platform. */
export async function secureStoreLabel(
  deps: SecureStoreDeps = {},
): Promise<string> {
  try {
    const backends = await resolveKeychain(deps).listBackends();
    const backend = preferredOsBackend(backends);
    if (backend) {
      return OS_BACKEND_LABELS[backend.id] ?? backend.name;
    }
  } catch {
    // Fall through to the generic label.
  }
  return "OS secure store";
}

/** Stores (or updates) a token for the given account. */
export async function setToken(
  account: string,
  token: string,
  deps: SecureStoreDeps = {},
): Promise<void> {
  try {
    await resolveKeychain(deps).setPassword(
      SECURE_STORE_SERVICE,
      account,
      token,
    );
  } catch (error) {
    throw new SecureStoreError(describeFailure("store the token", error));
  }
}

/** Retrieves a token for the given account, or null when none is stored. */
export async function getToken(
  account: string,
  deps: SecureStoreDeps = {},
): Promise<string | null> {
  try {
    return await resolveKeychain(deps).getPassword(
      SECURE_STORE_SERVICE,
      account,
    );
  } catch (error) {
    throw new SecureStoreError(describeFailure("read the token", error));
  }
}

/**
 * Deletes a token for the given account. Best-effort: returns true when an
 * entry was removed, false otherwise, and never throws for missing items.
 */
export async function deleteToken(
  account: string,
  deps: SecureStoreDeps = {},
): Promise<boolean> {
  try {
    await resolveKeychain(deps).deletePassword(SECURE_STORE_SERVICE, account);
    return true;
  } catch {
    return false;
  }
}

function preferredOsBackend(backends: BackendInfo[]): BackendInfo | undefined {
  return backends
    .filter((backend) => backend.id in OS_BACKEND_LABELS)
    .toSorted((a, b) => b.priority - a.priority)[0];
}

function describeFailure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail ? `Failed to ${action}: ${detail}` : `Failed to ${action}.`;
}
