import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cancelDeps } from "../src/commands/cancel-deps";
import {
  runCancel,
  setCancelDepsForTesting,
} from "../src/commands/cancel-core";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { RunningBuildSummary } from "../src/types/jenkins";

const builds: RunningBuildSummary[] = [
  {
    jobName: "api",
    fullJobName: "apps/api",
    jobUrl: "https://jenkins.example.com/job/apps/job/api/",
    buildNumber: 41,
    buildUrl: "https://jenkins.example.com/job/apps/job/api/41/",
  },
  {
    jobName: "web",
    jobUrl: "https://jenkins.example.com/job/web/",
    buildNumber: 9,
    buildUrl: "https://jenkins.example.com/job/web/9/",
  },
];

afterEach(() => {
  setCancelDepsForTesting();
});

function client(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

function setDeps(overrides: Partial<typeof cancelDeps>): void {
  setCancelDepsForTesting({ ...cancelDeps, ...overrides });
}

function options(clientValue: JenkinsClient) {
  return {
    client: clientValue,
    env: {} as EnvConfig,
    nonInteractive: false,
  };
}

describe("interactive targetless cancel", () => {
  test("cancels an individually selected running build", async () => {
    const stopBuild = mock(async () => undefined);
    const waitForBuild = mock(async () => ({ result: "ABORTED" }));
    const select = mock(
      async (_prompt: Parameters<typeof cancelDeps.select>[0]) =>
        builds[0]!.buildUrl,
    );
    setDeps({
      select: select as typeof cancelDeps.select,
      confirm: mock(async () => true) as typeof cancelDeps.confirm,
      waitForBuild: waitForBuild as unknown as typeof cancelDeps.waitForBuild,
    });

    await runCancel(
      options(
        client({
          listRunningBuilds: mock(async () => builds),
          stopBuild,
        }),
      ),
    );

    expect(stopBuild).toHaveBeenCalledWith(builds[0]!.buildUrl);
    expect(waitForBuild).toHaveBeenCalledTimes(1);
    const firstPrompt = select.mock.calls[0]?.[0] as
      { options: Array<{ label: string }> } | undefined;
    expect(firstPrompt).toBeDefined();
    const promptOptions = firstPrompt?.options ?? [];
    expect(promptOptions.map((entry) => entry.label)).toEqual([
      "apps/api #41",
      "web #9",
      "Select multiple running builds",
      "Select all running builds",
      "Search all jobs",
    ]);
  });

  test("selects multiple builds and requests every cancellation before waiting", async () => {
    const events: string[] = [];
    const stopBuild = mock(async (url: string) => {
      events.push(`stop:${url}`);
    });
    const waitForBuild = mock(async ({ buildUrl }: { buildUrl: string }) => {
      events.push(`wait:${buildUrl}`);
      return { result: "ABORTED" };
    });
    setDeps({
      select: mock(
        async () => "__jenkins_cli_cancel_multiple__",
      ) as typeof cancelDeps.select,
      multiselect: mock(async () =>
        builds.map((build) => build.buildUrl),
      ) as typeof cancelDeps.multiselect,
      confirm: mock(async () => true) as typeof cancelDeps.confirm,
      waitForBuild: waitForBuild as unknown as typeof cancelDeps.waitForBuild,
    });

    await runCancel(
      options(
        client({
          listRunningBuilds: mock(async () => builds),
          stopBuild,
        }),
      ),
    );

    expect(events).toEqual([
      `stop:${builds[0]!.buildUrl}`,
      `stop:${builds[1]!.buildUrl}`,
      `wait:${builds[0]!.buildUrl}`,
      `wait:${builds[1]!.buildUrl}`,
    ]);
  });

  test("returns to the first menu after an empty multi-selection", async () => {
    const select = mock(async () =>
      select.mock.calls.length === 1
        ? "__jenkins_cli_cancel_multiple__"
        : builds[0]!.buildUrl,
    );
    const stopBuild = mock(async () => undefined);
    setDeps({
      select: select as typeof cancelDeps.select,
      multiselect: mock(async () => []) as typeof cancelDeps.multiselect,
      confirm: mock(async () => true) as typeof cancelDeps.confirm,
      waitForBuild: mock(async () => ({
        result: "ABORTED",
      })) as unknown as typeof cancelDeps.waitForBuild,
    });

    await runCancel(
      options(
        client({
          listRunningBuilds: mock(async () => builds),
          stopBuild,
        }),
      ),
    );

    expect(select).toHaveBeenCalledTimes(2);
    expect(stopBuild).toHaveBeenCalledWith(builds[0]!.buildUrl);
  });

  test("select-all performs one confirmation and cancels the full list", async () => {
    const confirm = mock(
      async (_prompt: Parameters<typeof cancelDeps.confirm>[0]) => true,
    );
    const stopBuild = mock(async () => undefined);
    setDeps({
      select: mock(
        async () => "__jenkins_cli_cancel_all__",
      ) as typeof cancelDeps.select,
      confirm: confirm as typeof cancelDeps.confirm,
      waitForBuild: mock(async () => ({
        result: "ABORTED",
      })) as unknown as typeof cancelDeps.waitForBuild,
    });

    await runCancel(
      options(
        client({
          listRunningBuilds: mock(async () => builds),
          stopBuild,
        }),
      ),
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0].message).toBe("Cancel 2 running builds?");
    expect(stopBuild).toHaveBeenCalledTimes(2);
  });

  test("search enters the existing job target path", async () => {
    const resolveJobTarget = mock(async () => ({
      jobUrl: builds[0]!.jobUrl,
      jobLabel: "apps/api",
    }));
    const stopBuild = mock(async () => undefined);
    setDeps({
      select: mock(
        async () => "__jenkins_cli_cancel_search__",
      ) as typeof cancelDeps.select,
      resolveJobTarget: resolveJobTarget as typeof cancelDeps.resolveJobTarget,
      confirm: mock(async () => true) as typeof cancelDeps.confirm,
      waitForBuild: mock(async () => ({
        result: "ABORTED",
      })) as unknown as typeof cancelDeps.waitForBuild,
    });

    await runCancel(
      options(
        client({
          listRunningBuilds: mock(async () => builds),
          getJobStatus: mock(async () => ({
            building: true,
            lastBuildUrl: builds[0]!.buildUrl,
          })),
          stopBuild,
        }),
      ),
    );

    expect(resolveJobTarget).toHaveBeenCalledTimes(1);
    expect(stopBuild).toHaveBeenCalledWith(builds[0]!.buildUrl);
  });

  test("skips the running-build menu when none are running", async () => {
    const select = mock(async () => builds[0]!.buildUrl);
    const resolveJobTarget = mock(async () => ({
      jobUrl: builds[0]!.jobUrl,
      jobLabel: "apps/api",
    }));
    setDeps({
      select: select as typeof cancelDeps.select,
      resolveJobTarget: resolveJobTarget as typeof cancelDeps.resolveJobTarget,
      confirm: mock(async () => true) as typeof cancelDeps.confirm,
      waitForBuild: mock(async () => ({
        result: "ABORTED",
      })) as unknown as typeof cancelDeps.waitForBuild,
    });
    await runCancel(
      options(
        client({
          listRunningBuilds: mock(async () => []),
          getJobStatus: mock(async () => ({
            building: true,
            lastBuildUrl: builds[0]!.buildUrl,
          })),
          stopBuild: mock(async () => undefined),
        }),
      ),
    );
    expect(select).not.toHaveBeenCalled();
    expect(resolveJobTarget).toHaveBeenCalledTimes(1);
  });

  test("prints a hint and falls back to job search when discovery fails", async () => {
    const errorSpy = spyOn(console, "error");
    const resolveJobTarget = mock(async () => ({
      jobUrl: builds[0]!.jobUrl,
      jobLabel: "apps/api",
    }));
    setDeps({
      resolveJobTarget: resolveJobTarget as typeof cancelDeps.resolveJobTarget,
      confirm: mock(async () => true) as typeof cancelDeps.confirm,
      waitForBuild: mock(async () => ({
        result: "ABORTED",
      })) as unknown as typeof cancelDeps.waitForBuild,
    });
    try {
      await runCancel(
        options(
          client({
            listRunningBuilds: mock(async () => {
              throw new Error("offline");
            }),
            getJobStatus: mock(async () => ({
              building: true,
              lastBuildUrl: builds[0]!.buildUrl,
            })),
            stopBuild: mock(async () => undefined),
          }),
        ),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "HINT: Could not load running builds; searching all jobs instead.",
      );
      expect(resolveJobTarget).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

test("batch cancellation reports partial failure after attempting all builds", async () => {
  const logSpy = spyOn(console, "log");
  const errorSpy = spyOn(console, "error");
  const stopBuild = mock(async (url: string) => {
    if (url === builds[0]!.buildUrl) {
      throw new Error("permission denied");
    }
  });
  const waitForBuild = mock(async () => ({ result: "ABORTED" }));
  setDeps({
    select: mock(
      async () => "__jenkins_cli_cancel_all__",
    ) as typeof cancelDeps.select,
    confirm: mock(async () => true) as typeof cancelDeps.confirm,
    waitForBuild: waitForBuild as unknown as typeof cancelDeps.waitForBuild,
  });
  try {
    await expect(
      runCancel(
        options(
          client({
            listRunningBuilds: mock(async () => builds),
            stopBuild,
          }),
        ),
      ),
    ).rejects.toThrow("One or more running builds could not be cancelled.");
    expect(stopBuild).toHaveBeenCalledTimes(2);
    expect(waitForBuild).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "OK: Cancellation summary: 1 succeeded, 1 failed.",
    );
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("permission denied"),
      ),
    ).toBe(true);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
});
