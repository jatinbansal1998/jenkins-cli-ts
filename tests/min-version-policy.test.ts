import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import { GITHUB_VERSION_POLICY_URL } from "../src/github-constants";

const runUpdateMock = mock(async () => undefined);
const getPreferredUpdateCommandMock = mock(() => "jenkins-cli update");

let updateState: Record<string, unknown> = {};

const readUpdateStateMock = mock(async () => ({ ...updateState }));
const writeUpdateStateMock = mock(
  async (nextState: Record<string, unknown>) => {
    updateState = { ...nextState };
  },
);

mock.module("../src/commands/update", () => ({
  runUpdate: runUpdateMock,
}));

mock.module("../src/update", () => ({
  compareVersions,
  getPreferredUpdateCommand: getPreferredUpdateCommandMock,
  normalizeVersionTag,
  readUpdateState: readUpdateStateMock,
  writeUpdateState: writeUpdateStateMock,
}));

const realFetch = globalThis.fetch;
const realStdinIsTTY = process.stdin.isTTY;
const realStdoutIsTTY = process.stdout.isTTY;

beforeEach(() => {
  runUpdateMock.mockClear();
  getPreferredUpdateCommandMock.mockClear();
  readUpdateStateMock.mockClear();
  writeUpdateStateMock.mockClear();
});

afterEach(() => {
  updateState = {};
  globalThis.fetch = realFetch;
  (process.stdin as { isTTY?: boolean }).isTTY = realStdinIsTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = realStdoutIsTTY;
  mock.restore();
});

describe("minimum version policy", () => {
  test("cache miss allows execution", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.6.2",
        rawArgs: ["list"],
      }),
    ).resolves.toBeUndefined();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  test("cached minimum below current allows execution", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");
    updateState = { minAllowedVersion: "v0.6.0" };

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.6.2",
        rawArgs: ["list"],
      }),
    ).resolves.toBeUndefined();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  test("cached minimum above current triggers interactive auto update", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");
    updateState = { minAllowedVersion: "v9.9.9" };
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.6.2",
        rawArgs: ["list"],
      }),
    ).resolves.toBeUndefined();
    expect(runUpdateMock).toHaveBeenCalledTimes(1);
  });

  test("cached minimum above current fails in non-interactive mode", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");
    updateState = { minAllowedVersion: "v9.9.9" };

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.6.2",
        rawArgs: ["list", "--non-interactive"],
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  test("update command bypasses gate", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");
    updateState = { minAllowedVersion: "v9.9.9" };

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.6.2",
        rawArgs: ["update"],
      }),
    ).resolves.toBeUndefined();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  test("option value named update does not bypass gate", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");
    updateState = { minAllowedVersion: "v9.9.9" };

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.6.2",
        rawArgs: ["list", "--profile", "update", "--non-interactive"],
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  test("global options before update command still bypass gate", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");
    updateState = { minAllowedVersion: "v9.9.9" };

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.6.2",
        rawArgs: ["--profile", "default", "update"],
      }),
    ).resolves.toBeUndefined();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  test("refresh skips network call when cached policy is still fresh", async () => {
    const { kickOffMinimumVersionRefresh } =
      await import("../src/min-version-policy");
    updateState = {
      minAllowedVersion: "v0.6.2",
      minAllowedFetchedAt: new Date().toISOString(),
    };
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    kickOffMinimumVersionRefresh({ currentVersion: "0.6.2" });
    await flushBackgroundTasks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeUpdateStateMock).not.toHaveBeenCalled();
  });

  test("refresh stores latest valid policy", async () => {
    const { kickOffMinimumVersionRefresh } =
      await import("../src/min-version-policy");
    updateState = {
      minAllowedVersion: "v0.6.2",
      minAllowedFetchedAt: new Date(
        Date.now() - 2 * 60 * 60 * 1000,
      ).toISOString(),
    };
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            minVersion: "1.2.3",
            message: "Update is required.",
            updatedAt: "2026-02-12T00:00:00.000Z",
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    kickOffMinimumVersionRefresh({ currentVersion: "0.6.2" });
    await flushBackgroundTasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateState.minAllowedVersion).toBe("v1.2.3");
    expect(updateState.minAllowedMessage).toBe("Update is required.");
    expect(typeof updateState.minAllowedFetchedAt).toBe("string");
    expect(updateState.minAllowedSourceUrl).toBe(GITHUB_VERSION_POLICY_URL);
  });

  test("refresh failure preserves existing cached policy", async () => {
    const { kickOffMinimumVersionRefresh } =
      await import("../src/min-version-policy");
    updateState = {
      minAllowedVersion: "v7.7.7",
      minAllowedFetchedAt: new Date(
        Date.now() - 2 * 60 * 60 * 1000,
      ).toISOString(),
      minAllowedMessage: "Existing policy",
    };
    const previousState = { ...updateState };
    const fetchMock = mock(async () => new Response("{}", { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    kickOffMinimumVersionRefresh({ currentVersion: "0.6.2" });
    await flushBackgroundTasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writeUpdateStateMock).not.toHaveBeenCalled();
    expect(updateState).toEqual(previousState);
  });
});

function normalizeVersionTag(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function compareVersions(a: string, b: string): number | null {
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);
  if (!aParts || !bParts) {
    return null;
  }
  const length = Math.max(aParts.length, bParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const left = aParts[index] ?? 0;
    const right = bParts[index] ?? 0;
    if (left > right) {
      return 1;
    }
    if (left < right) {
      return -1;
    }
  }
  return 0;
}

function parseVersionParts(value: string): number[] | null {
  const cleaned = value.trim().replace(/^v/i, "");
  if (!cleaned) {
    return null;
  }
  const [main] = cleaned.split("-");
  if (!main) {
    return null;
  }
  const parts = main.split(".");
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    numbers.push(Number(part));
  }
  return numbers;
}

async function flushBackgroundTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
