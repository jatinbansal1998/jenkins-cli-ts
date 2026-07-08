import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import { GITHUB_VERSION_POLICY_URL } from "../src/github-constants";

const realUpdate = await import("../src/update");
const realUpdateCommand = await import("../src/commands/update");
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
  ...realUpdateCommand,
  runUpdate: runUpdateMock,
}));

mock.module("../src/update", () => ({
  ...realUpdate,
  getPreferredUpdateCommand: getPreferredUpdateCommandMock,
  readUpdateState: readUpdateStateMock,
  writeUpdateState: writeUpdateStateMock,
}));

const realFetch = globalThis.fetch;
const realStdinIsTTY = process.stdin.isTTY;
const realStdoutIsTTY = process.stdout.isTTY;

function setStreamIsTTY(
  stream: typeof process.stdin | typeof process.stdout,
  value: boolean | undefined,
) {
  Object.defineProperty(stream, "isTTY", {
    value,
    configurable: true,
  });
}

beforeEach(() => {
  runUpdateMock.mockClear();
  getPreferredUpdateCommandMock.mockClear();
  readUpdateStateMock.mockClear();
  writeUpdateStateMock.mockClear();
});

afterEach(() => {
  updateState = {};
  globalThis.fetch = realFetch;
  setStreamIsTTY(process.stdin, realStdinIsTTY);
  setStreamIsTTY(process.stdout, realStdoutIsTTY);
});

describe("minimum version policy", () => {
  test("cache miss allows execution", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.7.0",
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
        currentVersion: "0.7.0",
        rawArgs: ["list"],
      }),
    ).resolves.toBeUndefined();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  test("cached minimum above current triggers interactive auto update", async () => {
    const { enforceMinimumVersionFromCache } =
      await import("../src/min-version-policy");
    updateState = { minAllowedVersion: "v9.9.9" };
    setStreamIsTTY(process.stdin, true);
    setStreamIsTTY(process.stdout, true);

    await expect(
      enforceMinimumVersionFromCache({
        currentVersion: "0.7.0",
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
        currentVersion: "0.7.0",
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
        currentVersion: "0.7.0",
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
        currentVersion: "0.7.0",
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
        currentVersion: "0.7.0",
        rawArgs: ["--profile", "default", "update"],
      }),
    ).resolves.toBeUndefined();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  test("refresh skips network call when cached policy is still fresh", async () => {
    const { kickOffMinimumVersionRefresh } =
      await import("../src/min-version-policy");
    updateState = {
      minAllowedVersion: "v0.7.0",
      minAllowedFetchedAt: new Date().toISOString(),
    };
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    kickOffMinimumVersionRefresh({ currentVersion: "0.7.0" });
    await flushBackgroundTasks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeUpdateStateMock).not.toHaveBeenCalled();
  });

  test("refresh stores latest valid policy", async () => {
    const { kickOffMinimumVersionRefresh } =
      await import("../src/min-version-policy");
    updateState = {
      minAllowedVersion: "v0.7.0",
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

    kickOffMinimumVersionRefresh({ currentVersion: "0.7.0" });
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

    kickOffMinimumVersionRefresh({ currentVersion: "0.7.0" });
    await flushBackgroundTasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writeUpdateStateMock).not.toHaveBeenCalled();
    expect(updateState).toEqual(previousState);
  });
});

async function flushBackgroundTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
