/**
 * OS-native secure storage for Jenkins API tokens.
 *
 * Secret persistence is delegated to cross-keychain so the CLI can use the
 * platform credential manager across macOS, Linux, and Windows without
 * maintaining shell-command implementations here.
 */
import {
  deletePassword,
  getPassword,
  listBackends,
  setPassword,
  type BackendInfo,
} from "cross-keychain";

/** Keychain / keyring service name used for all entries. */
export const SECURE_STORE_SERVICE = "jenkins-cli";

export type SecureStoreKeychain = {
  getPassword: typeof getPassword;
  setPassword: typeof setPassword;
  deletePassword: typeof deletePassword;
  listBackends: typeof listBackends;
};

/** Injectable dependencies (real implementations used unless overridden). */
export type SecureStoreDeps = {
  keychain?: Partial<SecureStoreKeychain>;
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
 * Returns true when cross-keychain detects an OS-native secure store. The
 * package may also expose file/null fallback backends, but this CLI keeps its
 * existing plaintext fallback behavior when no OS credential manager exists.
 */
export async function isSecureStoreAvailable(
  deps: SecureStoreDeps = {},
): Promise<boolean> {
  try {
    const backends = await resolveKeychain(deps).listBackends();
    return backends.some((backend) => backend.id in OS_BACKEND_LABELS);
  } catch {
    return false;
  }
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
    .sort((a, b) => b.priority - a.priority)[0];
}

function describeFailure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail ? `Failed to ${action}: ${detail}` : `Failed to ${action}.`;
}
