import { afterEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import {
  runLogs,
  setLogsDependenciesForTesting,
  type LogCancellationSignal,
} from "../src/commands/logs";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci",
  jenkinsApiToken: "token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};
const buildUrl = "https://jenkins.example.com/job/api/9/";

function client(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

afterEach(() => {
  setLogsDependenciesForTesting(null);
  process.exitCode = 0;
});

describe("logs command", () => {
  test("prints a tail snapshot once and follows from the exact Jenkins offset", async () => {
    const existing = "one\ntwo\nthree\n";
    const next = "four\n";
    const output: string[] = [];
    const getBuildStatus = mock()
      .mockResolvedValueOnce({
        buildNumber: 9,
        buildUrl,
        building: true,
      })
      .mockResolvedValueOnce({ buildNumber: 9, buildUrl, building: true })
      .mockResolvedValueOnce({
        buildNumber: 9,
        buildUrl,
        building: false,
        result: "SUCCESS",
      });
    const getConsoleChunk = mock(async (_url: string, offset: number) => {
      if (offset === 0) {
        return {
          text: existing,
          nextStart: Buffer.byteLength(existing),
          hasMore: false,
        };
      }
      if (offset === Buffer.byteLength(existing)) {
        return {
          text: next,
          nextStart: Buffer.byteLength(existing + next),
          hasMore: false,
        };
      }
      return { text: "", nextStart: offset, hasMore: false };
    });

    await runLogs({
      client: client({ getBuildStatus, getConsoleChunk }),
      env,
      buildUrl,
      follow: true,
      tail: 2,
      poll: "1ms",
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("two\nthree\nfour\n");
    expect(getConsoleChunk.mock.calls.map((call) => call[1])).toEqual([
      0,
      Buffer.byteLength(existing),
    ]);
  });

  test("defaults redirected output to one snapshot", async () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const existing = "existing\n";
    const next = "new\n";
    const output: string[] = [];
    const getBuildStatus = mock()
      .mockResolvedValueOnce({ buildNumber: 9, buildUrl, building: true })
      .mockResolvedValueOnce({ buildNumber: 9, buildUrl, building: true })
      .mockResolvedValueOnce({
        buildNumber: 9,
        buildUrl,
        building: false,
        result: "SUCCESS",
      });
    const getConsoleChunk = mock(async (_url: string, offset: number) =>
      offset === 0
        ? {
            text: existing,
            nextStart: Buffer.byteLength(existing),
            hasMore: false,
          }
        : {
            text: next,
            nextStart: Buffer.byteLength(existing + next),
            hasMore: false,
          },
    );
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    try {
      await runLogs({
        client: client({ getBuildStatus, getConsoleChunk }),
        env,
        buildUrl,
        poll: "1ms",
        nonInteractive: true,
        writeText: (value) => output.push(value),
      });
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }

    expect(output.join("")).toBe(existing);
    expect(getConsoleChunk.mock.calls.map((call) => call[1])).toEqual([0]);
    expect(getBuildStatus).toHaveBeenCalledTimes(2);
  });

  test("keeps explicit no-follow authoritative on a terminal", async () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const getBuildStatus = mock(async () => ({
      buildNumber: 9,
      buildUrl,
      building: true,
    }));
    const getConsoleChunk = mock(async () => ({
      text: "existing\n",
      nextStart: 9,
      hasMore: false,
    }));
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await runLogs({
        client: client({ getBuildStatus, getConsoleChunk }),
        env,
        buildUrl,
        follow: false,
        nonInteractive: true,
        writeText: () => undefined,
      });
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }

    expect(getConsoleChunk).toHaveBeenCalledTimes(1);
    expect(getBuildStatus).toHaveBeenCalledTimes(2);
  });

  test("keeps stage diagnostics off stdout and streams raw node text", async () => {
    const output: string[] = [];
    const getPipelineDescription = mock(async () => ({
      stages: [
        {
          id: "10",
          name: "Test",
          status: "SUCCESS",
          _links: { self: { href: "/node/10/wfapi/describe" } },
        },
      ],
    }));
    const getPipelineNodeDescription = mock(async () => ({
      id: "10",
      name: "Test",
      status: "SUCCESS",
      stageFlowNodes: [
        {
          id: "11",
          name: "Shell Script",
          status: "SUCCESS",
          parentNodes: ["10"],
          _links: { log: { href: "/node/11/wfapi/log" } },
        },
      ],
    }));
    const getPipelineNodeLog = mock(async () => ({
      nodeId: "11",
      hasMore: false,
      consoleUrl: "/node/11/log",
    }));
    const getPipelineNodeConsoleChunk = mock(async () => ({
      text: "raw-stage-output\n",
      nextStart: 17,
      hasMore: false,
    }));

    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: false,
          result: "SUCCESS",
        })),
        getPipelineDescription,
        getPipelineNodeDescription,
        getPipelineNodeLog,
        getPipelineNodeConsoleChunk,
      }),
      env,
      buildUrl,
      stage: "Test",
      follow: false,
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("raw-stage-output\n");
  });

  test("composes plain, no-timestamps, grep, and context across chunks", async () => {
    const output: string[] = [];
    const first = [
      "[2026-08-10T12:00:00.000Z] [Pipeline] echo\n",
      "[2026-08-10T12:00:01.000Z] before\n",
      "[2026-08-10T12:00:02.000Z] \x1b[8mha:////metadata\x1b[0m\x1b[36mtar",
    ].join("");
    const second = [
      "get\x1b[0m\n",
      "[2026-08-10T12:00:03.000Z] after\n",
      "[2026-08-10T12:00:04.000Z] outside\n",
    ].join("");
    const getConsoleChunk = mock(async (_url: string, offset: number) =>
      offset === 0
        ? {
            text: first,
            nextStart: Buffer.byteLength(first),
            hasMore: true,
          }
        : {
            text: second,
            nextStart: Buffer.byteLength(first + second),
            hasMore: false,
          },
    );

    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: false,
          result: "SUCCESS",
        })),
        getConsoleChunk,
      }),
      env,
      buildUrl,
      follow: false,
      plain: true,
      noTimestamps: true,
      grep: "target",
      context: 1,
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("before\ntarget\nafter\n");
  });

  test("keeps a CRLF split across chunk boundaries as one line", async () => {
    const output: string[] = [];
    const first = "a\r\nb\r";
    const second = "\nhit\r\nc\r\nd\r\n";
    const getConsoleChunk = mock(async (_url: string, offset: number) =>
      offset === 0
        ? { text: first, nextStart: Buffer.byteLength(first), hasMore: true }
        : {
            text: second,
            nextStart: Buffer.byteLength(first + second),
            hasMore: false,
          },
    );

    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: false,
          result: "SUCCESS",
        })),
        getConsoleChunk,
      }),
      env,
      buildUrl,
      follow: false,
      grep: "hit",
      context: 1,
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("b\r\nhit\r\nc\r\n");
  });

  test("never merges an unterminated tail with the next Pipeline node's log", async () => {
    const output: string[] = [];
    const getPipelineDescription = mock(async () => ({
      stages: [
        {
          id: "10",
          name: "Test",
          status: "SUCCESS",
          _links: { self: { href: "/node/10/wfapi/describe" } },
        },
      ],
    }));
    const getPipelineNodeDescription = mock(async () => ({
      id: "10",
      name: "Test",
      status: "SUCCESS",
      stageFlowNodes: [
        {
          id: "11",
          name: "First Step",
          status: "SUCCESS",
          parentNodes: ["10"],
          _links: { log: { href: "/node/11/wfapi/log" } },
        },
        {
          id: "12",
          name: "Second Step",
          status: "SUCCESS",
          parentNodes: ["11"],
          _links: { log: { href: "/node/12/wfapi/log" } },
        },
      ],
    }));
    const getPipelineNodeLog = mock(async (href: string) =>
      href.includes("/11/")
        ? { nodeId: "11", hasMore: false, consoleUrl: "/node/11/log" }
        : { nodeId: "12", hasMore: false, consoleUrl: "/node/12/log" },
    );
    const getPipelineNodeConsoleChunk = mock(async (consoleUrl: string) =>
      consoleUrl.includes("/11/")
        ? { text: "keep\nno-newline-tail", nextStart: 21, hasMore: false }
        : { text: "ERROR: boom\nline3\n", nextStart: 18, hasMore: false },
    );

    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: false,
          result: "SUCCESS",
        })),
        getPipelineDescription,
        getPipelineNodeDescription,
        getPipelineNodeLog,
        getPipelineNodeConsoleChunk,
      }),
      env,
      buildUrl,
      stage: "Test",
      grep: "^ERROR",
      follow: false,
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("ERROR: boom\n");
  });

  test("flushes a buffered partial line when following is cancelled", async () => {
    const output: string[] = [];
    let cancelled = false;
    const getConsoleChunk = mock(async () => {
      cancelled = true;
      return { text: "tail without newline", nextStart: 20, hasMore: false };
    });

    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: true,
        })),
        getConsoleChunk,
      }),
      env,
      buildUrl,
      follow: true,
      plain: true,
      poll: "1ms",
      nonInteractive: true,
      cancelSignal: {
        isCancelled: () => cancelled,
        wait: new Promise<void>(() => undefined),
      },
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("tail without newline");
  });

  test("rejects --jsonl combined with post-processing filters", async () => {
    for (const options of [
      { plain: true },
      { noTimestamps: true },
      { grep: "x" },
    ]) {
      const written: string[] = [];
      await runLogs({
        client: client({}),
        env,
        buildUrl,
        follow: false,
        nonInteractive: true,
        jsonl: true,
        write: (value) => written.push(value),
        ...options,
      });
      const event = JSON.parse(written.join("")) as {
        type: string;
        error: { code?: string };
      };
      expect(event.type).toBe("error");
      expect(event.error.code).toBe("INVALID_USAGE");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    }
  });

  test("rejects invalid grep and context values before reading Jenkins", async () => {
    for (const options of [
      { grep: "[" },
      { grep: "value", context: -1 },
      { context: 2 },
    ]) {
      await expect(
        runLogs({
          client: client({}),
          env,
          buildUrl,
          follow: false,
          nonInteractive: true,
          writeText: () => undefined,
          ...options,
        }),
      ).rejects.toThrow(CliError);
    }
  });

  test("returns a stable ambiguity error for repeated stage names", async () => {
    const pipelineClient = client({
      getBuildStatus: mock(async () => ({ buildNumber: 9, buildUrl })),
      getPipelineDescription: mock(async () => ({
        stages: [
          { id: "10", name: "Test" },
          { id: "20", name: "Test" },
        ],
      })),
      getPipelineNodeDescription: mock(async () => null),
    });
    let error: unknown;
    try {
      await runLogs({
        client: pipelineClient,
        env,
        buildUrl,
        stage: "Test",
        follow: false,
        nonInteractive: true,
        writeText: () => undefined,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("AMBIGUOUS_STAGE_SELECTOR");
    expect((error as CliError).hints.join(" ")).toContain("id 10");
    expect((error as CliError).hints.join(" ")).toContain("id 20");
  });

  test("Ctrl+C cancellation never calls the Jenkins build mutation API", async () => {
    const stopBuild = mock(async () => undefined);
    const signal: LogCancellationSignal = {
      isCancelled: () => true,
      wait: Promise.resolve(),
    };
    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: true,
        })),
        getConsoleChunk: mock(async () => ({
          text: "should-not-print",
          nextStart: 16,
          hasMore: false,
        })),
        stopBuild,
      }),
      env,
      buildUrl,
      follow: true,
      nonInteractive: true,
      cancelSignal: signal,
      writeText: () => undefined,
    });

    expect(stopBuild).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
  });

  test("backs off when Jenkins reports more data without advancing the offset", async () => {
    const getConsoleChunk = mock(async () => ({
      text: "",
      nextStart: 0,
      hasMore: true,
    }));
    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: false,
          result: "SUCCESS",
        })),
        getConsoleChunk,
      }),
      env,
      buildUrl,
      nonInteractive: true,
      writeText: () => undefined,
    });

    expect(getConsoleChunk).toHaveBeenCalledTimes(1);
  });

  test("interactive cancellation stops before reading a selected build", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const cancelled = Symbol("cancelled");
    const getBuildStatus = mock(async () => ({ buildUrl, building: false }));
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setLogsDependenciesForTesting({
      select: mock(async () => cancelled),
      isCancel: (value) => value === cancelled,
    });
    try {
      await runLogs({
        client: client({
          listBuildHistory: mock(async () => ({
            builds: [
              {
                buildNumber: 9,
                buildUrl,
                result: "SUCCESS",
                building: false,
              },
            ],
            total: 1,
            offset: 0,
            limit: 10,
            hasNext: false,
            hasPrevious: false,
          })),
          getBuildStatus,
        }),
        env,
        jobUrl: "https://jenkins.example.com/job/api/",
        nonInteractive: false,
        writeText: () => undefined,
      });
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }

    expect(getBuildStatus).not.toHaveBeenCalled();
  });

  test("interactive logs select a running build, tail mode, and follow choice", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    const selections = [buildUrl, "tail"];
    const selectPrompt = mock(async () => selections.shift()!);
    const confirmPrompt = mock(async () => false);
    const output: string[] = [];
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    setLogsDependenciesForTesting({
      select: selectPrompt as never,
      text: mock(async () => "1"),
      confirm: confirmPrompt,
      isCancel: (_value): _value is symbol => false,
    });
    try {
      await runLogs({
        client: client({
          listBuildHistory: mock(async () => ({
            builds: [
              {
                buildNumber: 9,
                buildUrl,
                building: true,
              },
            ],
            total: 1,
            offset: 0,
            limit: 10,
            hasNext: false,
            hasPrevious: false,
          })),
          getBuildStatus: mock(async () => ({
            buildNumber: 9,
            buildUrl,
            building: true,
          })),
          getPipelineDescription: mock(async () => null),
          getConsoleChunk: mock(async () => ({
            text: "first\nlast\n",
            nextStart: 11,
            hasMore: false,
          })),
        }),
        env,
        jobUrl: "https://jenkins.example.com/job/api/",
        nonInteractive: false,
        writeText: (value) => output.push(value),
      });
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }

    expect(output.join("")).toBe("last\n");
    expect(selectPrompt).toHaveBeenCalledTimes(2);
    expect(confirmPrompt).toHaveBeenCalledTimes(1);
  });
});
