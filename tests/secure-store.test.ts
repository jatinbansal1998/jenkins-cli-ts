import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildSecureStoreAccount,
  deleteToken,
  getToken,
  isSecureStoreAvailable,
  SecureStoreError,
  setToken,
  type SecureStoreCommandResult,
  type SecureStoreDeps,
} from "../src/secure-store";

type RecordedCall = { cmd: string[]; stdin?: string };

/**
 * Builds injectable deps with a fake command runner so unit tests never touch
 * the real OS keychain. The runner records calls and returns queued results.
 */
function makeDeps(
  platform: NodeJS.Platform,
  results: SecureStoreCommandResult[],
): { deps: SecureStoreDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const deps: SecureStoreDeps = {
    platform,
    hasBinary: () => true,
    run: async (cmd, stdin) => {
      calls.push({ cmd, stdin });
      const result = results[index] ?? { exitCode: 0, stdout: "", stderr: "" };
      index += 1;
      return result;
    },
  };
  return { deps, calls };
}

const OK: SecureStoreCommandResult = { exitCode: 0, stdout: "", stderr: "" };

describe("buildSecureStoreAccount", () => {
  test("combines profile name and host", () => {
    expect(
      buildSecureStoreAccount("work", "https://jenkins.example.com/ci"),
    ).toBe("work@jenkins.example.com");
  });

  test("falls back to default name and raw value for bad URLs", () => {
    expect(buildSecureStoreAccount("  ", "not a url")).toBe(
      "default@not a url",
    );
  });
});

describe("isSecureStoreAvailable", () => {
  test("darwin requires the security binary", () => {
    expect(
      isSecureStoreAvailable({ platform: "darwin", hasBinary: () => true }),
    ).toBeTrue();
    expect(
      isSecureStoreAvailable({ platform: "darwin", hasBinary: () => false }),
    ).toBeFalse();
  });

  test("linux requires secret-tool", () => {
    expect(
      isSecureStoreAvailable({
        platform: "linux",
        hasBinary: (name) => name === "secret-tool",
      }),
    ).toBeTrue();
    expect(
      isSecureStoreAvailable({ platform: "linux", hasBinary: () => false }),
    ).toBeFalse();
  });

  test("unsupported platforms are never available", () => {
    expect(
      isSecureStoreAvailable({ platform: "win32", hasBinary: () => true }),
    ).toBeFalse();
  });
});

describe("setToken", () => {
  test("darwin invokes security add-generic-password with the token on argv", async () => {
    const { deps, calls } = makeDeps("darwin", [OK]);
    await setToken("work@host", "secret-token", deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual([
      "security",
      "add-generic-password",
      "-U",
      "-s",
      "jenkins-cli",
      "-a",
      "work@host",
      "-w",
      "secret-token",
    ]);
  });

  test("linux invokes secret-tool store and passes the token via stdin", async () => {
    const { deps, calls } = makeDeps("linux", [OK]);
    await setToken("work@host", "secret-token", deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual([
      "secret-tool",
      "store",
      "--label",
      "jenkins-cli work@host",
      "service",
      "jenkins-cli",
      "account",
      "work@host",
    ]);
    // Token must not appear on argv; it is fed through stdin.
    expect(calls[0]?.cmd).not.toContain("secret-token");
    expect(calls[0]?.stdin).toBe("secret-token");
  });

  test("throws SecureStoreError on non-zero exit", async () => {
    const { deps } = makeDeps("linux", [
      { exitCode: 1, stdout: "", stderr: "keyring locked" },
    ]);
    await expect(setToken("work@host", "t", deps)).rejects.toBeInstanceOf(
      SecureStoreError,
    );
  });
});

describe("getToken", () => {
  test("darwin returns the token and trims the trailing newline", async () => {
    const { deps, calls } = makeDeps("darwin", [
      { exitCode: 0, stdout: "secret-token\n", stderr: "" },
    ]);
    const token = await getToken("work@host", deps);
    expect(token).toBe("secret-token");
    expect(calls[0]?.cmd).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "jenkins-cli",
      "-a",
      "work@host",
      "-w",
    ]);
  });

  test("darwin returns null when the item is not found (exit 44)", async () => {
    const { deps } = makeDeps("darwin", [
      { exitCode: 44, stdout: "", stderr: "not found" },
    ]);
    expect(await getToken("missing@host", deps)).toBeNull();
  });

  test("darwin throws on other failures", async () => {
    const { deps } = makeDeps("darwin", [
      { exitCode: 1, stdout: "", stderr: "keychain error" },
    ]);
    await expect(getToken("work@host", deps)).rejects.toBeInstanceOf(
      SecureStoreError,
    );
  });

  test("linux returns the stored token", async () => {
    const { deps, calls } = makeDeps("linux", [
      { exitCode: 0, stdout: "secret-token", stderr: "" },
    ]);
    expect(await getToken("work@host", deps)).toBe("secret-token");
    expect(calls[0]?.cmd).toEqual([
      "secret-tool",
      "lookup",
      "service",
      "jenkins-cli",
      "account",
      "work@host",
    ]);
  });

  test("linux returns null when absent (non-zero, empty stderr)", async () => {
    const { deps } = makeDeps("linux", [
      { exitCode: 1, stdout: "", stderr: "" },
    ]);
    expect(await getToken("missing@host", deps)).toBeNull();
  });

  test("linux throws when the backend reports an error", async () => {
    const { deps } = makeDeps("linux", [
      { exitCode: 1, stdout: "", stderr: "cannot create item: locked" },
    ]);
    await expect(getToken("work@host", deps)).rejects.toBeInstanceOf(
      SecureStoreError,
    );
  });
});

describe("deleteToken", () => {
  test("darwin issues delete-generic-password", async () => {
    const { deps, calls } = makeDeps("darwin", [OK]);
    expect(await deleteToken("work@host", deps)).toBeTrue();
    expect(calls[0]?.cmd).toEqual([
      "security",
      "delete-generic-password",
      "-s",
      "jenkins-cli",
      "-a",
      "work@host",
    ]);
  });

  test("linux issues secret-tool clear", async () => {
    const { deps, calls } = makeDeps("linux", [OK]);
    expect(await deleteToken("work@host", deps)).toBeTrue();
    expect(calls[0]?.cmd).toEqual([
      "secret-tool",
      "clear",
      "service",
      "jenkins-cli",
      "account",
      "work@host",
    ]);
  });

  test("returns false and never throws when deletion fails", async () => {
    const { deps } = makeDeps("linux", [
      { exitCode: 1, stdout: "", stderr: "no such item" },
    ]);
    expect(await deleteToken("missing@host", deps)).toBeFalse();
  });
});

/**
 * Integration probe: exercises the REAL platform tooling once to decide
 * whether the store is usable in this environment (tool present AND the
 * keyring/session unlocked). Skips otherwise. On Linux CI this is enabled by
 * running under `dbus-run-session` with an unlocked gnome-keyring.
 */
async function probeSecureStore(): Promise<boolean> {
  if (process.env.SKIP_KEYCHAIN_INTEGRATION === "1") {
    return false;
  }
  if (!isSecureStoreAvailable()) {
    return false;
  }
  const account = `__probe__${randomUUID()}`;
  try {
    await setToken(account, "probe-token");
    const got = await getToken(account);
    await deleteToken(account);
    return got === "probe-token";
  } catch {
    await deleteToken(account).catch(() => undefined);
    return false;
  }
}

const integrationAvailable = await probeSecureStore();

describe("secure store integration (real OS keychain)", () => {
  test.skipIf(!integrationAvailable)(
    "round-trips store -> lookup -> clear",
    async () => {
      const account = `jenkins-cli-test-${randomUUID()}`;
      const token = `tok-${randomUUID()}`;

      await setToken(account, token);
      expect(await getToken(account)).toBe(token);

      // Overwrite updates in place.
      const updated = `tok2-${randomUUID()}`;
      await setToken(account, updated);
      expect(await getToken(account)).toBe(updated);

      expect(await deleteToken(account)).toBeTrue();
      expect(await getToken(account)).toBeNull();
    },
  );
});
