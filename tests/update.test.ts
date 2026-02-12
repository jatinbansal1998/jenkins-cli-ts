import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../src/cli";
import { GITHUB_REPO_URL } from "../src/github-constants";
import {
  clearPendingUpdateState,
  compareVersions,
  downloadAndInstall,
  fetchLatestRelease,
  getPreferredUpdateCommand,
  getDeferredUpdatePromptVersion,
  isHomebrewManagedPath,
  normalizeVersionTag,
  resolveAssetUrl,
  resolveExecutablePath,
  withPendingUpdateState,
} from "../src/update";

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe("update version helpers", () => {
  test("normalizeVersionTag adds v prefix", () => {
    expect(normalizeVersionTag("0.2.4")).toBe("v0.2.4");
  });

  test("normalizeVersionTag keeps v prefix", () => {
    expect(normalizeVersionTag("v0.2.4")).toBe("v0.2.4");
  });

  test("compareVersions detects newer version", () => {
    expect(compareVersions("v0.2.4", "0.2.3")).toBe(1);
  });

  test("compareVersions detects older version", () => {
    expect(compareVersions("0.2.3", "v0.2.4")).toBe(-1);
  });

  test("compareVersions detects equal versions", () => {
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  test("compareVersions returns null for invalid version", () => {
    expect(compareVersions("v1.0.0", "latest")).toBeNull();
  });
});

describe("update helpers", () => {
  test("resolveAssetUrl returns the jenkins-cli asset", () => {
    const url = resolveAssetUrl({
      tag_name: "v1.2.3",
      assets: [
        {
          name: "jenkins-cli",
          browser_download_url: "https://example.com/jenkins-cli",
        },
      ],
    });
    expect(url).toBe("https://example.com/jenkins-cli");
  });

  test("resolveAssetUrl throws if asset is missing", () => {
    expect(() => resolveAssetUrl({ tag_name: "v1.2.3", assets: [] })).toThrow(
      CliError,
    );
  });

  test("resolveExecutablePath throws for source runs", () => {
    const prevArgv = process.argv[1];
    process.argv[1] = "/tmp/src/index.ts";
    try {
      expect(() => resolveExecutablePath()).toThrow(CliError);
    } finally {
      if (prevArgv === undefined) {
        process.argv.splice(1, 1);
      } else {
        process.argv[1] = prevArgv;
      }
    }
  });

  test("resolveExecutablePath returns resolved path for binaries", () => {
    const prevArgv = process.argv[1];
    process.argv[1] = "/tmp/jenkins-cli";
    try {
      expect(resolveExecutablePath()).toBe(path.resolve("/tmp/jenkins-cli"));
    } finally {
      if (prevArgv === undefined) {
        process.argv.splice(1, 1);
      } else {
        process.argv[1] = prevArgv;
      }
    }
  });

  test("isHomebrewManagedPath detects Homebrew cellar path", () => {
    expect(
      isHomebrewManagedPath(
        "/opt/homebrew/Cellar/jenkins-cli/0.6.0/bin/jenkins-cli",
      ),
    ).toBeTrue();
  });

  test("isHomebrewManagedPath ignores non-Homebrew paths", () => {
    expect(
      isHomebrewManagedPath("/Users/dev/.bun/bin/jenkins-cli"),
    ).toBeFalse();
  });

  test("getPreferredUpdateCommand returns brew command for cellar install", () => {
    const prevArgv = process.argv[1];
    process.argv[1] = "/usr/local/Cellar/jenkins-cli/0.6.0/bin/jenkins-cli";
    try {
      expect(getPreferredUpdateCommand()).toBe("brew upgrade jenkins-cli");
    } finally {
      if (prevArgv === undefined) {
        process.argv.splice(1, 1);
      } else {
        process.argv[1] = prevArgv;
      }
    }
  });

  test("getPreferredUpdateCommand returns self-update for standalone install", () => {
    const prevArgv = process.argv[1];
    process.argv[1] = "/Users/dev/.bun/bin/jenkins-cli";
    try {
      expect(getPreferredUpdateCommand()).toBe("jenkins-cli update");
    } finally {
      if (prevArgv === undefined) {
        process.argv.splice(1, 1);
      } else {
        process.argv[1] = prevArgv;
      }
    }
  });
});

describe("deferred update state helpers", () => {
  test("withPendingUpdateState sets pending version metadata", () => {
    const nowIso = "2026-01-01T00:00:00.000Z";
    const next = withPendingUpdateState({}, "v1.2.3", nowIso);
    expect(next.pendingVersion).toBe("v1.2.3");
    expect(next.pendingDetectedAt).toBe(nowIso);
  });

  test("withPendingUpdateState clears dismissal for a new version", () => {
    const next = withPendingUpdateState(
      {
        pendingVersion: "v1.2.3",
        pendingDetectedAt: "2026-01-01T00:00:00.000Z",
        dismissedVersion: "v1.2.3",
      },
      "v1.2.4",
      "2026-01-02T00:00:00.000Z",
    );
    expect(next.dismissedVersion).toBeUndefined();
  });

  test("clearPendingUpdateState removes pending and dismissed metadata", () => {
    const cleared = clearPendingUpdateState({
      pendingVersion: "v1.2.3",
      pendingDetectedAt: "2026-01-01T00:00:00.000Z",
      dismissedVersion: "v1.2.3",
      autoUpdate: true,
    });
    expect(cleared.pendingVersion).toBeUndefined();
    expect(cleared.pendingDetectedAt).toBeUndefined();
    expect(cleared.dismissedVersion).toBeUndefined();
    expect(cleared.autoUpdate).toBeTrue();
  });

  test("getDeferredUpdatePromptVersion returns pending newer version", () => {
    const pending = getDeferredUpdatePromptVersion(
      { pendingVersion: "v1.2.3" },
      "v1.2.2",
    );
    expect(pending).toBe("v1.2.3");
  });

  test("getDeferredUpdatePromptVersion returns null for dismissed version", () => {
    const pending = getDeferredUpdatePromptVersion(
      {
        pendingVersion: "v1.2.3",
        dismissedVersion: "v1.2.3",
      },
      "v1.2.2",
    );
    expect(pending).toBeNull();
  });

  test("getDeferredUpdatePromptVersion returns null for non-newer version", () => {
    const pending = getDeferredUpdatePromptVersion(
      { pendingVersion: "v1.2.3" },
      "v1.2.3",
    );
    expect(pending).toBeNull();
  });
});

describe("GitHub headers", () => {
  test("fetchLatestRelease sends a versioned user agent", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
      return new Response(
        JSON.stringify({
          tag_name: "v1.2.3",
          assets: [],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchLatestRelease({ currentVersion: "0.6.2" });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(readHeader(requestInit, "User-Agent")).toBe(
      `jenkins-cli/0.6.2 (+${GITHUB_REPO_URL}; platform=${process.platform}; arch=${process.arch})`,
    );
    expect(readHeader(requestInit, "Accept")).toBe(
      "application/vnd.github+json",
    );
  });

  test("downloadAndInstall sends a versioned user agent", async () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), "jenkins-cli-update-test-"),
    );
    const targetPath = path.join(tempDir, "jenkins-cli");
    const fetchMock = mock(
      async (_input: FetchInput, _init?: FetchInit) =>
        new Response("binary", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await downloadAndInstall(
        "https://github.com/jatinbansal1998/jenkins-cli-ts/releases/download/v1.2.3/jenkins-cli",
        targetPath,
        "0.6.2",
      );
      expect(readFileSync(targetPath, "utf8")).toBe("binary");
      const requestInit = fetchMock.mock.calls[0]?.[1] as
        | RequestInit
        | undefined;
      expect(readHeader(requestInit, "User-Agent")).toBe(
        `jenkins-cli/0.6.2 (+${GITHUB_REPO_URL}; platform=${process.platform}; arch=${process.arch})`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function readHeader(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const entries = headers as Array<[string, string]>;
    const lower = name.toLowerCase();
    const entry = entries.find(([key]) => key.toLowerCase() === lower);
    return entry?.[1];
  }
  const objectHeaders = headers as Record<string, string | readonly string[]>;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(objectHeaders)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return undefined;
}
