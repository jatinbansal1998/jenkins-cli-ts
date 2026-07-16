import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { browserCommand, openInBrowser } from "../src/browser";
import { runDeps } from "../src/commands/run-deps";
import { runRunningBuilds, setRunDepsForTesting } from "../src/commands/run";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";

const builds = [
  {
    jobName: "api",
    fullJobName: "apps/api",
    jobUrl: "https://jenkins.example.com/job/apps/job/api/",
    buildNumber: 42,
    buildUrl: "https://jenkins.example.com/job/apps/job/api/42/",
  },
];

afterEach(() => {
  setRunDepsForTesting();
});

function clientWithRunningBuilds(
  listRunningBuilds: () => Promise<typeof builds>,
): JenkinsClient {
  return { listRunningBuilds } as JenkinsClient;
}

describe("runRunningBuilds", () => {
  test("opens the interactively selected exact build URL", async () => {
    const open = mock(async () => undefined);
    setRunDepsForTesting({
      ...runDeps,
      select: mock(async () => builds[0]!.buildUrl) as typeof runDeps.select,
      openInBrowser: open,
    });

    await runRunningBuilds({
      client: clientWithRunningBuilds(async () => builds),
      env: {} as EnvConfig,
      nonInteractive: false,
    });

    expect(open).toHaveBeenCalledWith(builds[0]!.buildUrl);
  });

  test("prints all running builds without launching in non-interactive mode", async () => {
    const logSpy = spyOn(console, "log");
    const open = mock(async () => undefined);
    setRunDepsForTesting({ ...runDeps, openInBrowser: open });
    try {
      await runRunningBuilds({
        client: clientWithRunningBuilds(async () => builds),
        env: {} as EnvConfig,
        nonInteractive: true,
      });
      expect(logSpy).toHaveBeenCalledWith(
        "apps/api #42: https://jenkins.example.com/job/apps/job/api/42/",
      );
      expect(open).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  test("prints the empty success message", async () => {
    const logSpy = spyOn(console, "log");
    try {
      await runRunningBuilds({
        client: clientWithRunningBuilds(async () => []),
        env: {} as EnvConfig,
        nonInteractive: false,
      });
      expect(logSpy).toHaveBeenCalledWith("OK: no running builds");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("returns without opening when selection is cancelled", async () => {
    const open = mock(async () => undefined);
    setRunDepsForTesting({
      ...runDeps,
      select: mock(async () => "cancel") as typeof runDeps.select,
      isCancel: ((value: unknown) =>
        value === "cancel") as unknown as typeof runDeps.isCancel,
      openInBrowser: open,
    });
    await runRunningBuilds({
      client: clientWithRunningBuilds(async () => builds),
      env: {} as EnvConfig,
      nonInteractive: false,
    });
    expect(open).not.toHaveBeenCalled();
  });

  test("prints the URL and hint when browser launch fails", async () => {
    const logSpy = spyOn(console, "log");
    const errorSpy = spyOn(console, "error");
    setRunDepsForTesting({
      ...runDeps,
      select: mock(async () => builds[0]!.buildUrl) as typeof runDeps.select,
      openInBrowser: mock(async () => {
        throw new Error("missing launcher");
      }),
    });
    try {
      await runRunningBuilds({
        client: clientWithRunningBuilds(async () => builds),
        env: {} as EnvConfig,
        nonInteractive: false,
      });
      expect(logSpy).toHaveBeenCalledWith(builds[0]!.buildUrl);
      expect(errorSpy).toHaveBeenCalledWith(
        "HINT: Could not open the browser. Open the build URL manually.",
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("browser launcher", () => {
  test("uses the platform-specific command", async () => {
    expect(browserCommand("https://example.com", "darwin")).toEqual([
      "open",
      "https://example.com",
    ]);
    expect(browserCommand("https://example.com", "linux")).toEqual([
      "xdg-open",
      "https://example.com",
    ]);
    expect(browserCommand("https://example.com", "win32")).toEqual([
      "cmd",
      "/c",
      "start",
      "",
      "https://example.com",
    ]);
  });

  test("surfaces a non-zero launcher exit", async () => {
    await expect(
      openInBrowser("https://example.com", async () => 1, "linux"),
    ).rejects.toThrow("Browser launcher exited with code 1.");
  });
});
