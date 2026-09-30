import { afterEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import {
  MIN_CHUNK_INTERVAL_MS,
  runLogs,
  setLogsDependenciesForTesting,
  type LogCancellationSignal,
} from "../src/commands/logs";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { BuildStatus } from "../src/types/jenkins";

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

/** Serves an ASCII log from any offset, like progressiveText on a finished build. */
function serveFrom(log: string) {
  return mock(async (_url: string, offset: number) => ({
    text: log.slice(offset),
    nextStart: log.length,
    hasMore: false,
  }));
}

/** wfapi stages of a finished Build stage followed by a Test stage. */
function buildAndTestStages(testStatus: string) {
  return [
    {
      id: "10",
      name: "Build",
      status: "SUCCESS",
      _links: { self: { href: "/node/10/wfapi/describe" } },
    },
    {
      id: "20",
      name: "Test",
      status: testStatus,
      _links: { self: { href: "/node/20/wfapi/describe" } },
    },
  ];
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
      client: client({
        getBuildStatus,
        getConsoleChunk,
        getConsoleTextSize: mock(async () => Buffer.byteLength(existing)),
      }),
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

  test("follow asks for build status only after Jenkins closes the log", async () => {
    const output: string[] = [];
    const getBuildStatus = mock()
      .mockResolvedValueOnce({ buildNumber: 9, buildUrl, building: true })
      .mockResolvedValueOnce({
        buildNumber: 9,
        buildUrl,
        building: false,
        result: "SUCCESS",
      });
    const chunks = [
      { text: "a\n", nextStart: 2, hasMore: true },
      { text: "", nextStart: 2, hasMore: true },
      { text: "", nextStart: 2, hasMore: true },
      { text: "b\n", nextStart: 4, hasMore: true },
      { text: "", nextStart: 4, hasMore: false },
    ];
    const getConsoleChunk = mock(async () => chunks.shift()!);

    await runLogs({
      client: client({ getBuildStatus, getConsoleChunk }),
      env,
      buildUrl,
      follow: true,
      plain: true,
      poll: "1ms",
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("a\nb\n");
    expect(getConsoleChunk).toHaveBeenCalledTimes(5);
    // One status read to start, one once the log closed; none per poll.
    expect(getBuildStatus).toHaveBeenCalledTimes(2);
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
          stages: [
            {
              id: "10",
              name: "Test",
              status: "SUCCESS",
              _links: { self: { href: "/node/10/wfapi/describe" } },
            },
          ],
        })),
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
          stages: [
            {
              id: "10",
              name: "Test",
              status: "SUCCESS",
              _links: { self: { href: "/node/10/wfapi/describe" } },
            },
          ],
        })),
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
      getBuildStatus: mock(async () => ({
        buildNumber: 9,
        buildUrl,
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

  test("reads only the selected stage's wfapi node", async () => {
    const output: string[] = [];
    const getPipelineNodeDescription = mock(async (href: string) => {
      const id = href.match(/\/node\/(\d+)\//)![1]!;
      return {
        id,
        status: "SUCCESS",
        stageFlowNodes: [
          {
            id: `${id}1`,
            name: "Shell Script",
            status: "SUCCESS",
            parentNodes: [id],
            _links: { log: { href: `/node/${id}1/wfapi/log` } },
          },
        ],
      };
    });
    const getPipelineNodeLog = mock(async (href: string) => ({
      hasMore: false,
      consoleUrl: href.replace("/wfapi/log", "/log"),
    }));

    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: false,
          result: "SUCCESS",
          stages: ["10", "20", "30"].map((id) => ({
            id,
            name: `Stage ${id}`,
            status: "SUCCESS",
            _links: { self: { href: `/node/${id}/wfapi/describe` } },
          })),
        })),
        getPipelineNodeDescription,
        getPipelineNodeLog,
        getPipelineNodeConsoleChunk: mock(async (consoleUrl: string) => ({
          text: `${consoleUrl}\n`,
          nextStart: consoleUrl.length + 1,
          hasMore: false,
        })),
      }),
      env,
      buildUrl,
      stage: "Stage 20",
      follow: false,
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("/node/201/log\n");
    expect(getPipelineNodeDescription.mock.calls).toEqual([
      ["/node/20/wfapi/describe"],
    ]);
    expect(getPipelineNodeLog).toHaveBeenCalledTimes(1);
  });

  test("finds a --stage-id step inside any stage, six reads at a time", async () => {
    const output: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const getPipelineNodeDescription = mock(async (href: string) => {
      const id = href.match(/\/node\/(\d+)\//)![1]!;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(1);
      inFlight--;
      return {
        id,
        status: "SUCCESS",
        stageFlowNodes: [
          {
            id: `${id}1`,
            name: "Shell Script",
            status: "SUCCESS",
            parentNodes: [id],
            _links: { log: { href: `/node/${id}1/wfapi/log` } },
          },
        ],
      };
    });

    await runLogs({
      client: client({
        getBuildStatus: mock(async () => ({
          buildNumber: 9,
          buildUrl,
          building: false,
          result: "SUCCESS",
          stages: Array.from({ length: 10 }, (_, index) => {
            const id = String((index + 1) * 10);
            return {
              id,
              name: `Stage ${id}`,
              status: "SUCCESS",
              _links: { self: { href: `/node/${id}/wfapi/describe` } },
            };
          }),
        })),
        getPipelineNodeDescription,
        getPipelineNodeLog: mock(async (href: string) => ({
          hasMore: false,
          consoleUrl: href.replace("/wfapi/log", "/log"),
        })),
        getPipelineNodeConsoleChunk: mock(async (consoleUrl: string) => ({
          text: `${consoleUrl}\n`,
          nextStart: consoleUrl.length + 1,
          hasMore: false,
        })),
      }),
      env,
      buildUrl,
      stageId: "201",
      follow: false,
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("/node/201/log\n");
    expect(getPipelineNodeDescription).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBe(6);
  });

  test("follows a running stage without re-reading what already finished", async () => {
    const output: string[] = [];
    type Phase = {
      status: Partial<BuildStatus>;
      steps: Record<string, string>;
      logs: Record<string, string>;
    };
    // Each status poll moves the build one step forward.
    const phases: Phase[] = [
      {
        status: { building: true, stages: buildAndTestStages("IN_PROGRESS") },
        steps: { "21": "SUCCESS", "22": "IN_PROGRESS" },
        logs: { "21": "one\n", "22": "two\n" },
      },
      {
        status: { building: true, stages: buildAndTestStages("IN_PROGRESS") },
        steps: { "21": "SUCCESS", "22": "SUCCESS", "23": "IN_PROGRESS" },
        logs: { "21": "one\n", "22": "two\nmore\n", "23": "three\n" },
      },
      {
        status: {
          building: false,
          result: "SUCCESS",
          stages: buildAndTestStages("SUCCESS"),
        },
        steps: { "21": "SUCCESS", "22": "SUCCESS", "23": "SUCCESS" },
        logs: { "21": "one\n", "22": "two\nmore\n", "23": "three\nlast\n" },
      },
    ];
    let phase = -1;
    const current = () => phases[phase]!;
    const getBuildStatus = mock(async () => {
      phase++;
      return { buildNumber: 9, buildUrl, ...current().status };
    });
    const getPipelineNodeDescription = mock(async (_href: string) => ({
      id: "20",
      stageFlowNodes: Object.entries(current().steps).map(([id, status]) => ({
        id,
        name: `Step ${id}`,
        status,
        startTimeMillis: Number(id),
        parentNodes: ["20"],
        _links: { log: { href: `/node/${id}/wfapi/log` } },
      })),
    }));
    const getPipelineNodeLog = mock(async (href: string) => ({
      hasMore: false,
      consoleUrl: href.replace("/wfapi/log", "/log"),
    }));
    const getPipelineNodeConsoleChunk = mock(
      async (consoleUrl: string, offset: number) => {
        const id = consoleUrl.match(/\/node\/(\d+)\//)![1]!;
        const log = current().logs[id]!;
        return {
          text: log.slice(offset),
          nextStart: log.length,
          hasMore: false,
        };
      },
    );

    await runLogs({
      client: client({
        getBuildStatus,
        getPipelineNodeDescription,
        getPipelineNodeLog,
        getPipelineNodeConsoleChunk,
      }),
      env,
      buildUrl,
      stage: "Test",
      follow: true,
      poll: "1ms",
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    // "last" is written after the final running poll; the pass that runs
    // once status says done still reads it.
    expect(output.join("")).toBe("one\ntwo\nmore\nthree\nlast\n");
    expect(getBuildStatus).toHaveBeenCalledTimes(3);
    // The running stage is re-read each poll; the finished Build stage never.
    expect(getPipelineNodeDescription.mock.calls).toEqual([
      ["/node/20/wfapi/describe"],
      ["/node/20/wfapi/describe"],
      ["/node/20/wfapi/describe"],
    ]);
    // Console URLs are remembered, so each node's wfapi log is read once.
    expect(getPipelineNodeLog.mock.calls.map(([href]) => href)).toEqual([
      "/node/21/wfapi/log",
      "/node/22/wfapi/log",
      "/node/23/wfapi/log",
    ]);
    // Step 21 had finished before its first read, so it is read only once.
    expect(
      getPipelineNodeConsoleChunk.mock.calls.filter(([url]) =>
        url.includes("/21/"),
      ),
    ).toHaveLength(1);
  });

  test("keeps a finished stage's detail while the build still runs", async () => {
    const statuses = [true, true, false].map((building) => ({
      buildNumber: 9,
      buildUrl,
      building,
      result: building ? undefined : "SUCCESS",
      stages: [
        {
          id: "10",
          name: "Build",
          status: "SUCCESS",
          _links: { self: { href: "/node/10/wfapi/describe" } },
        },
      ],
    }));
    const getBuildStatus = mock(async () => statuses.shift()!);
    const getPipelineNodeDescription = mock(async () => ({
      id: "10",
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
    const output: string[] = [];

    await runLogs({
      client: client({
        getBuildStatus,
        getPipelineNodeDescription,
        getPipelineNodeLog: mock(async () => ({
          hasMore: false,
          consoleUrl: "/node/11/log",
        })),
        getPipelineNodeConsoleChunk: serveFrom("built\n"),
      }),
      env,
      buildUrl,
      stage: "Build",
      follow: true,
      poll: "1ms",
      nonInteractive: true,
      writeText: (value) => output.push(value),
    });

    expect(output.join("")).toBe("built\n");
    expect(getBuildStatus).toHaveBeenCalledTimes(3);
    expect(getPipelineNodeDescription).toHaveBeenCalledTimes(1);
  });

  test("does not keep a finished stage's detail while a step still runs", async () => {
    const statuses = [true, true, true, false].map((building) => ({
      buildNumber: 9,
      buildUrl,
      building,
      result: building ? undefined : "SUCCESS",
      stages: [
        {
          id: "10",
          name: "Build",
          status: "SUCCESS",
          _links: { self: { href: "/node/10/wfapi/describe" } },
        },
      ],
    }));
    // The stage list already says SUCCESS while the first detail read still
    // reports the step as running.
    const stepStatuses = ["IN_PROGRESS", "SUCCESS"];
    const getPipelineNodeDescription = mock(async () => ({
      id: "10",
      stageFlowNodes: [
        {
          id: "11",
          name: "Shell Script",
          status: stepStatuses.shift() ?? "SUCCESS",
          parentNodes: ["10"],
          _links: { log: { href: "/node/11/wfapi/log" } },
        },
      ],
    }));
    const getPipelineNodeConsoleChunk = serveFrom("built\n");

    await runLogs({
      client: client({
        getBuildStatus: mock(async () => statuses.shift()!),
        getPipelineNodeDescription,
        getPipelineNodeLog: mock(async () => ({
          hasMore: false,
          consoleUrl: "/node/11/log",
        })),
        getPipelineNodeConsoleChunk,
      }),
      env,
      buildUrl,
      stage: "Build",
      follow: true,
      poll: "1ms",
      nonInteractive: true,
      writeText: () => undefined,
    });

    // Re-read once the step settles, then kept; the step log stops being
    // polled after its first read as a finished step.
    expect(getPipelineNodeDescription).toHaveBeenCalledTimes(2);
    expect(getPipelineNodeConsoleChunk).toHaveBeenCalledTimes(2);
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

  test("paces reads of a log that always has more data", async () => {
    for (const tail of [undefined, 1]) {
      const callTimes: number[] = [];
      let size = 0;
      const getConsoleChunk = mock(async () => {
        callTimes.push(performance.now());
        size += 5;
        return {
          text: "busy\n",
          nextStart: size,
          hasMore: callTimes.length < 4,
        };
      });

      await runLogs({
        client: client({
          getBuildStatus: mock(async () => ({
            buildNumber: 9,
            buildUrl,
            building: false,
            result: "SUCCESS",
          })),
          getConsoleChunk,
          getConsoleTextSize: mock(async () => 0),
        }),
        env,
        buildUrl,
        tail,
        follow: false,
        nonInteractive: true,
        writeText: () => undefined,
      });

      // Covers both readers: the streaming one and the --tail snapshot.
      expect(callTimes).toHaveLength(4);
      for (let index = 1; index < callTimes.length; index++) {
        expect(
          callTimes[index]! - callTimes[index - 1]!,
        ).toBeGreaterThanOrEqual(MIN_CHUNK_INTERVAL_MS);
      }
    }
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
          getConsoleTextSize: mock(async () => 11),
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

  describe("snapshot reads", () => {
    type TimestampOptions = Parameters<
      JenkinsClient["getConsoleTimestamps"]
    >[1];
    type JsonlChunk = {
      type: string;
      text: string;
      offset: number;
      nextOffset: number;
      more: boolean;
    };
    const finished = mock(async () => ({
      buildNumber: 9,
      buildUrl,
      building: false,
      result: "SUCCESS",
    }));
    // 100-byte lines, so a line count maps to an exact byte count.
    const largeLog = Array.from(
      { length: 5_000 },
      (_, index) => `${`line-${index}`.padEnd(99, ".")}\n`,
    ).join("");

    async function readJsonlChunks(
      stubs: Partial<JenkinsClient>,
      options: { tail?: number; since?: string },
    ): Promise<JsonlChunk[]> {
      const written: string[] = [];
      await runLogs({
        client: client({ getBuildStatus: finished, ...stubs }),
        env,
        buildUrl,
        follow: false,
        nonInteractive: true,
        jsonl: true,
        write: (value) => written.push(value),
        ...options,
      });
      return written
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JsonlChunk)
        .filter((event) => event.type === "chunk");
    }

    test("reads a short tail from one window at the end of the log", async () => {
      const getConsoleChunk = serveFrom(largeLog);

      const chunks = await readJsonlChunks(
        {
          getConsoleChunk,
          getConsoleTextSize: mock(async () => largeLog.length),
        },
        { tail: 3 },
      );

      expect(getConsoleChunk.mock.calls.map((call) => call[1])).toEqual([
        largeLog.length - 64 * 1024,
      ]);
      expect(chunks).toEqual([
        {
          type: "chunk",
          text: largeLog.slice(-300),
          offset: largeLog.length - 300,
          nextOffset: largeLog.length,
          more: false,
        },
      ]);
    });

    test("grows the window until it holds every requested line", async () => {
      const getConsoleChunk = serveFrom(largeLog);

      const chunks = await readJsonlChunks(
        {
          getConsoleChunk,
          getConsoleTextSize: mock(async () => largeLog.length),
        },
        { tail: 1_000 },
      );

      expect(getConsoleChunk.mock.calls.map((call) => call[1])).toEqual([
        largeLog.length - 64 * 1024,
        largeLog.length - 256 * 1024,
      ]);
      expect(chunks.map(({ text, offset }) => ({ text, offset }))).toEqual([
        { text: largeLog.slice(-100_000), offset: largeLog.length - 100_000 },
      ]);
    });

    test("does not trust a window that opens exactly on a line start", async () => {
      // 64 KiB of 64-byte lines: the first window starts on a line boundary
      // but cannot tell, so asking for every line must fall back to offset 0.
      const aligned = Array.from(
        { length: 2_048 },
        (_, index) => `${`row-${index}`.padEnd(63, ".")}\n`,
      ).join("");
      const getConsoleChunk = serveFrom(aligned);

      const chunks = await readJsonlChunks(
        {
          getConsoleChunk,
          getConsoleTextSize: mock(async () => aligned.length),
        },
        { tail: 1_024 },
      );

      expect(getConsoleChunk.mock.calls.map((call) => call[1])).toEqual([
        aligned.length - 64 * 1024,
        0,
      ]);
      expect(chunks[0]?.text).toBe(aligned.slice(-64 * 1024));
      expect(chunks[0]?.offset).toBe(aligned.length - 64 * 1024);
    });

    test("filters a finished build by timestamps without downloading its log", async () => {
      const getConsoleChunk = mock();
      const pending: (() => void)[] = [];
      const getConsoleTimestamps = mock(
        (_url: string, options: TimestampOptions) =>
          new Promise<string>((resolve) => {
            pending.push(() =>
              resolve(
                options?.currentTime
                  ? "2026-08-01T12:10:00.000Z\n"
                  : [
                      "2026-08-01T11:00:00.000Z  old",
                      "  [Pipeline] echo",
                      "2026-08-01T12:05:00.000Z  new",
                      "",
                    ].join("\n"),
              ),
            );
          }),
      );
      const getConsoleTextSize = mock(async () => 4_321);
      const run = readJsonlChunks(
        { getConsoleChunk, getConsoleTimestamps, getConsoleTextSize },
        { since: "10m" },
      );
      while (getConsoleTimestamps.mock.calls.length < 2) {
        await Bun.sleep(1);
      }
      // Both timestamp requests are in flight before either one answers.
      for (const release of pending) {
        release();
      }

      expect(await run).toEqual([
        {
          type: "chunk",
          text: "new\n",
          offset: 0,
          nextOffset: 4_321,
          more: false,
        },
      ]);
      expect(getConsoleChunk).not.toHaveBeenCalled();
      expect(getConsoleTimestamps.mock.calls.map((call) => call[1])).toEqual([
        { currentTime: true },
        { appendLog: true },
      ]);
    });

    test("pins a running build's timestamps to the snapshot it follows from", async () => {
      const existing = "old\nnew\npartial";
      const getConsoleTimestamps = mock(
        async (_url: string, _options: TimestampOptions) =>
          [
            "2026-08-01T11:00:00.000Z  old",
            "2026-08-01T12:05:00.000Z  new",
            "",
          ].join("\n"),
      );

      const chunks = await readJsonlChunks(
        {
          getBuildStatus: mock(async () => ({
            buildNumber: 9,
            buildUrl,
            building: true,
          })),
          getConsoleChunk: serveFrom(existing),
          getConsoleTimestamps,
        },
        { since: "2026-08-01T12:00:00Z" },
      );

      expect(getConsoleTimestamps.mock.calls.map((call) => call[1])).toEqual([
        { endLine: 2, appendLog: true },
      ]);
      expect(
        chunks.map(({ text, nextOffset }) => ({ text, nextOffset })),
      ).toEqual([{ text: "new\n", nextOffset: existing.length }]);
    });
  });
});
