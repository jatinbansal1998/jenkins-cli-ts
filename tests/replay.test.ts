import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli";
import type { EnvConfig } from "../src/env";
import type { ErrorCode } from "../src/error-codes";
import type { JenkinsClient } from "../src/jenkins/client";
import type {
  PostSubmission,
  ReplayScripts,
  TriggerBuildResult,
} from "../src/types/jenkins";

const realRecentJobs = await import("../src/recent-jobs");
const recordRecentJobMock = mock(async () => undefined);
void mock.module("../src/recent-jobs", () => ({
  ...realRecentJobs,
  recordRecentJob: recordRecentJobMock,
}));

const { runReplay } = await import("../src/commands/replay");

const JENKINS_URL = "https://jenkins.example.com";
const JOB_URL = `${JENKINS_URL}/job/deploy`;
const BUILD_URL = `${JOB_URL}/12/`;

const env: EnvConfig = {
  jenkinsUrl: JENKINS_URL,
  jenkinsUser: "ci",
  jenkinsApiToken: "token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

const ORIGINAL: ReplayScripts = {
  mainScript: "echo 'original'\n",
  loadedScripts: { Script1: "return this", Script2: "return null" },
};

type FakeClient = {
  getReplayScripts: ReturnType<typeof mock>;
  getLastBuild: ReturnType<typeof mock>;
  listQueueItems: ReturnType<typeof mock>;
  replayBuild: ReturnType<typeof mock>;
  findReplayedBuild: ReturnType<typeof mock>;
};

function fakeClient(
  options: {
    submission?: PostSubmission;
    found?: (TriggerBuildResult | null)[];
  } = {},
): FakeClient {
  const found = [...(options.found ?? [])];
  return {
    getReplayScripts: mock(async () => ORIGINAL),
    getLastBuild: mock(async () => ({
      buildUrl: `${JOB_URL}/13/`,
      buildNumber: 13,
      building: false,
      result: "SUCCESS",
    })),
    listQueueItems: mock(async () => [
      { id: 30, queueUrl: `${JENKINS_URL}/queue/item/30/` },
      { id: 31, queueUrl: `${JENKINS_URL}/queue/item/31/` },
    ]),
    replayBuild: mock(
      async () => options.submission ?? { outcome: "accepted" },
    ),
    findReplayedBuild: mock(async () =>
      found.length > 1 ? found.shift() : (found[0] ?? null),
    ),
  };
}

let dir: string;
let output: string[];
let stdoutSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let stderrSpy: ReturnType<typeof spyOn>;
let sleepSpy: ReturnType<typeof spyOn>;
let nowSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-test-"));
  output = [];
  recordRecentJobMock.mockClear();
  stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    },
  );
  logSpy = spyOn(console, "log").mockImplementation((text: unknown) => {
    output.push(`${String(text)}\n`);
  });
  stderrSpy = spyOn(console, "error").mockImplementation(() => {});
  // The build lookup polls for seconds; run its clock instantly.
  let clock = 0;
  nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
  sleepSpy = spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    clock += Number(ms);
  });
  process.exitCode = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  logSpy.mockRestore();
  stderrSpy.mockRestore();
  sleepSpy.mockRestore();
  nowSpy.mockRestore();
  process.exitCode = 0;
});

async function writeScript(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, text);
  return path;
}

function replay(
  client: FakeClient,
  options: Partial<Parameters<typeof runReplay>[0]> = {},
): Promise<void> {
  return runReplay({
    client: client as unknown as JenkinsClient,
    env,
    buildUrl: BUILD_URL,
    loaded: [],
    printScript: false,
    follow: false,
    nonInteractive: true,
    ...options,
  });
}

async function captureError(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to throw.");
}

describe("replay usage", () => {
  test("needs a script to run or a script to print", async () => {
    const client = fakeClient();
    const error = await captureError(() => replay(client));
    expect(error.code).toBe("INVALID_USAGE");
    expect(client.getReplayScripts).not.toHaveBeenCalled();
  });

  test("needs an exact build, never the latest one", async () => {
    const client = fakeClient();
    const error = await captureError(() =>
      replay(client, {
        buildUrl: undefined,
        jobUrl: JOB_URL,
        printScript: true,
      }),
    );
    expect(error.code).toBe("INVALID_USAGE");
    expect(error.message).toContain("exact build");
    expect(client.getReplayScripts).not.toHaveBeenCalled();
  });

  test("does not mix printing with running", async () => {
    const client = fakeClient();
    for (const options of [
      { printScript: true, script: "Jenkinsfile" },
      { printScript: true, printLoaded: "Script1" },
      { printScript: true, follow: true },
      { printLoaded: "Script1", json: true },
    ]) {
      const error = await captureError(() => replay(client, options));
      expect(error.code).toBe("INVALID_USAGE");
    }
  });

  test("rejects a malformed --loaded value", async () => {
    const error = await captureError(() =>
      replay(fakeClient(), { loaded: ["Script1"] }),
    );
    expect(error.code).toBe("INVALID_USAGE");
    expect(error.message).toContain("NAME=file");
  });

  test("refuses an empty script, which Jenkins would run as a no-op", async () => {
    const client = fakeClient();
    const error = await captureError(async () =>
      replay(client, { script: await writeScript("Jenkinsfile", " \n") }),
    );
    expect(error.code).toBe("INVALID_USAGE");
    expect(error.message).toContain("is empty");
    expect(client.getReplayScripts).not.toHaveBeenCalled();
  });

  test("fails on a missing script file before contacting Jenkins", async () => {
    const client = fakeClient();
    const error = await captureError(() =>
      replay(client, { script: join(dir, "missing") }),
    );
    expect(error.code).toBe("INVALID_USAGE");
    expect(client.getReplayScripts).not.toHaveBeenCalled();
  });
});

describe("replay --print-script", () => {
  test("writes the main script exactly", async () => {
    const client = fakeClient();
    await replay(client, { printScript: true });
    expect(output.join("")).toBe(ORIGINAL.mainScript);
    expect(client.getReplayScripts).toHaveBeenCalledWith(BUILD_URL);
  });

  test("writes one loaded script", async () => {
    await replay(fakeClient(), { printLoaded: "Script2" });
    expect(output.join("")).toBe("return null");
  });

  test("names the loaded scripts when one is missing", async () => {
    const error = await captureError(() =>
      replay(fakeClient(), { printLoaded: "Script9" }),
    );
    expect(error.code).toBe("REPLAY_SCRIPT_NOT_FOUND");
    expect(error.hints).toEqual(["Loaded scripts: Script1, Script2."]);
  });

  test("works on a read-only profile because it only reads", async () => {
    await replay(fakeClient(), {
      env: { ...env, protectedProfileName: "prod" },
      printScript: true,
    });
    expect(output.join("")).toBe(ORIGINAL.mainScript);
  });
});

describe("replay", () => {
  test("is blocked on a read-only profile", async () => {
    const client = fakeClient();
    const error = await captureError(() =>
      replay(client, {
        env: { ...env, protectedProfileName: "prod" },
        script: "-",
      }),
    );
    expect(error.code).toBe("PROFILE_PROTECTED");
    expect(client.getReplayScripts).not.toHaveBeenCalled();
  });

  test("submits the edited script with the original loaded scripts and reports the build", async () => {
    const client = fakeClient({
      found: [
        null,
        {
          jobUrl: JOB_URL,
          buildUrl: `${JOB_URL}/14/`,
          buildNumber: 14,
        },
      ],
    });
    const script = await writeScript("Jenkinsfile", "echo 'edited'\n");
    const helper = await writeScript("helper.groovy", "return 'edited'");
    const written: string[] = [];

    await replay(client, {
      script,
      loaded: ["Script1=" + helper],
      json: true,
      write: (text) => written.push(text),
    });

    expect(client.replayBuild).toHaveBeenCalledTimes(1);
    expect(client.replayBuild).toHaveBeenCalledWith({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts: {
        mainScript: "echo 'edited'\n",
        loadedScripts: { Script1: "return 'edited'", Script2: "return null" },
      },
    });
    expect(client.findReplayedBuild).toHaveBeenCalledWith({
      jobUrl: JOB_URL,
      sourceBuildNumber: 12,
      afterBuildNumber: 13,
      afterQueueId: 31,
    });
    expect(JSON.parse(written.join(""))).toEqual({
      ok: true,
      command: "replay",
      data: {
        source: { buildUrl: BUILD_URL, buildNumber: 12 },
        target: {
          jobUrl: `${JOB_URL}/`,
          buildUrl: `${JOB_URL}/14/`,
          buildNumber: 14,
        },
      },
    });
    expect(recordRecentJobMock).toHaveBeenCalledWith({ env, jobUrl: JOB_URL });
  });

  test("replaces only a loaded script when no main script is given", async () => {
    const client = fakeClient({
      found: [{ jobUrl: JOB_URL, queueUrl: `${JENKINS_URL}/queue/item/7/` }],
    });
    const helper = await writeScript("helper.groovy", "return 'edited'");

    await replay(client, { loaded: [`Script2=${helper}`] });

    expect(client.replayBuild.mock.calls[0]?.[0]).toMatchObject({
      scripts: {
        mainScript: ORIGINAL.mainScript,
        loadedScripts: { Script1: "return this", Script2: "return 'edited'" },
      },
    });
    expect(output.join("")).toContain("with edited scripts");
    expect(output.join("")).toContain(
      `Build queued at ${JENKINS_URL}/queue/item/7/.`,
    );
  });

  test("says when the scripts are unchanged", async () => {
    const script = await writeScript("Jenkinsfile", ORIGINAL.mainScript);
    await replay(
      fakeClient({
        found: [
          { jobUrl: JOB_URL, buildUrl: `${JOB_URL}/14/`, buildNumber: 14 },
        ],
      }),
      { script },
    );
    expect(output.join("")).toContain("with its original scripts");
    expect(output.join("")).toContain(`Build started at ${JOB_URL}/14/.`);
  });

  test("checks loaded script names before posting", async () => {
    const client = fakeClient();
    const helper = await writeScript("helper.groovy", "return 1");
    const error = await captureError(() =>
      replay(client, { loaded: [`Script9=${helper}`] }),
    );
    expect(error.code).toBe("REPLAY_SCRIPT_NOT_FOUND");
    expect(client.replayBuild).not.toHaveBeenCalled();
  });

  test("still succeeds when the build cannot be found in time", async () => {
    const client = fakeClient({ found: [null] });
    const script = await writeScript("Jenkinsfile", "echo 1");

    await replay(client, { script });

    expect(process.exitCode).toBe(0);
    expect(client.replayBuild).toHaveBeenCalledTimes(1);
    expect(client.findReplayedBuild.mock.calls.length).toBeGreaterThan(1);
    expect(stderrSpy.mock.calls.flat().join("\n")).toContain(
      "did not appear within 10s",
    );
  });

  test("an unconfirmed POST whose build appears is a success, never a resend", async () => {
    const client = fakeClient({
      submission: { outcome: "unconfirmed", reason: "socket hang up" },
      found: [{ jobUrl: JOB_URL, buildUrl: `${JOB_URL}/14/`, buildNumber: 14 }],
    });
    const script = await writeScript("Jenkinsfile", "echo 1");

    await replay(client, { script });

    expect(client.replayBuild).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain(`Build started at ${JOB_URL}/14/.`);
  });

  test("an unconfirmed POST without a build is REPLAY_OUTCOME_UNKNOWN", async () => {
    const client = fakeClient({
      submission: { outcome: "unconfirmed", reason: "socket hang up" },
      found: [null],
    });
    const script = await writeScript("Jenkinsfile", "echo 1");

    const error = await captureError(() => replay(client, { script }));

    expect(error.code).toBe("REPLAY_OUTCOME_UNKNOWN");
    expect(error.message).toContain("socket hang up");
    expect(error.hints.join(" ")).toContain(`history --job-url ${JOB_URL}`);
    expect(client.replayBuild).toHaveBeenCalledTimes(1);
  });

  test("maps Jenkins refusals to clear errors without looking for a build", async () => {
    const cases: [PostSubmission, ErrorCode][] = [
      [
        { outcome: "rejected", httpStatus: 403, kind: "http_error" },
        "REPLAY_PERMISSION_DENIED",
      ],
      [
        { outcome: "rejected", httpStatus: 404, kind: "http_error" },
        "REPLAY_UNAVAILABLE",
      ],
      [
        {
          outcome: "rejected",
          httpStatus: 400,
          kind: "http_error",
          detail: "Replay is not allowed when password parameters are used.",
        },
        "REPLAY_REJECTED",
      ],
    ];
    const script = await writeScript("Jenkinsfile", "echo 1");
    for (const [submission, code] of cases) {
      const client = fakeClient({ submission });
      const error = await captureError(() => replay(client, { script }));
      expect(error.code).toBe(code);
      expect(client.findReplayedBuild).not.toHaveBeenCalled();
    }
  });

  test("a rejection that is not a Jenkins 4xx is reconciled against the builds", async () => {
    const client = fakeClient({
      submission: {
        outcome: "rejected",
        httpStatus: 302,
        kind: "redirect",
        detail: "redirected to /login",
      },
      found: [null],
    });
    const script = await writeScript("Jenkinsfile", "echo 1");

    const error = await captureError(() => replay(client, { script }));

    expect(error.code).toBe("REPLAY_REJECTED");
    expect(error.message).toContain("redirected to /login");
    expect(client.findReplayedBuild).toHaveBeenCalled();
  });
});
