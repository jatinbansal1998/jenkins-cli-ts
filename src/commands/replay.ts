import { type BuildSelection, resolveBuildSelector } from "../build-selector";
import { CliError, printOk, printWarning, writeStdout } from "../cli";
import { EXIT_CODES } from "../error-codes";
import { assertProtectedMutationAllowed, type EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import {
  jsonTriggerTarget,
  type JsonReplayReceipt,
  type JsonWrite,
  runJsonCommand,
} from "../json-output";
import { recordRecentJob } from "../recent-jobs";
import type {
  PostSubmission,
  ReplayScripts,
  TriggerBuildResult,
} from "../types/jenkins";
import { DEFAULT_LOG_POLL_MS, runLogs, waitForQueuedBuild } from "./logs";
import { waitForBuild } from "./wait";

/** How long to look for the build a replay started before giving up. */
const LOCATE_TIMEOUT_MS = 10_000;
const LOCATE_POLL_MS = 500;

type ReplayOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  build?: BuildSelection;
  buildUrl?: string;
  /** Path to the edited main script; `-` reads stdin. */
  script?: string;
  /** `NAME=path` replacements for scripts the build loaded with `load`. */
  loaded: string[];
  printScript: boolean;
  printLoaded?: string;
  follow: boolean;
  nonInteractive: boolean;
  json?: boolean;
  write?: JsonWrite;
};

type ReplayTarget = {
  jobUrl: string;
  jobLabel: string;
  buildUrl: string;
  buildNumber: number;
};

type ReplayResult = {
  source: ReplayTarget;
  edited: boolean;
  /** Where the new build is, or null when it could not be found in time. */
  started: TriggerBuildResult | null;
};

export async function runReplay(options: ReplayOptions): Promise<void> {
  validateOptions(options);
  if (options.printScript || options.printLoaded !== undefined) {
    await printScript(options);
    return;
  }
  if (options.json) {
    await runJsonCommand(
      "replay",
      async (): Promise<JsonReplayReceipt> => {
        const replay = await submitReplay({ ...options, nonInteractive: true });
        const source = {
          buildUrl: replay.source.buildUrl,
          buildNumber: replay.source.buildNumber,
        };
        if (!options.follow) {
          return {
            source,
            target: jsonTriggerTarget(
              replay.started ?? { jobUrl: replay.source.jobUrl },
            ),
          };
        }
        const finished = await waitForReplay(options, replay);
        return {
          source,
          target: jsonTriggerTarget(finished.target),
          result: finished.result,
        };
      },
      { write: options.write },
    );
    return;
  }

  const replay = await submitReplay(options);
  printReplayResult(replay);
  if (options.follow) {
    await followReplay(options, replay);
  }
}

function validateOptions(options: ReplayOptions): void {
  const printing = options.printScript || options.printLoaded !== undefined;
  const submitting = options.script !== undefined || options.loaded.length > 0;
  if (options.printScript && options.printLoaded !== undefined) {
    invalidUsage("Pass either --print-script or --print-loaded, not both.");
  }
  if (printing && submitting) {
    invalidUsage(
      "--print-script and --print-loaded only read; do not combine them with --script or --loaded.",
    );
  }
  if (printing && (options.follow || options.json)) {
    invalidUsage(
      "--print-script and --print-loaded write the raw script; do not combine them with --follow or --json.",
    );
  }
  if (!printing && !submitting) {
    invalidUsage(
      "Pass --script <file> to replay with an edited script, or --print-script to read the build's script.",
    );
  }
  if (options.build === undefined && !options.buildUrl?.trim()) {
    invalidUsage(
      "Replay needs an exact build: pass --build <n|alias> with the job, or --build-url.",
    );
  }
}

function invalidUsage(message: string): never {
  throw new CliError(
    message,
    [
      "Example: jenkins-cli replay --job api --build 25 --print-script > Jenkinsfile",
      "Then: jenkins-cli replay --job api --build 25 --script Jenkinsfile --follow",
    ],
    "INVALID_USAGE",
  );
}

async function printScript(options: ReplayOptions): Promise<void> {
  const target = await resolveReplayTarget(options);
  const scripts = await options.client.getReplayScripts(target.buildUrl);
  if (options.printLoaded === undefined) {
    writeStdout(scripts.mainScript);
    return;
  }
  writeStdout(loadedScript(scripts, options.printLoaded, target));
}

async function submitReplay(options: ReplayOptions): Promise<ReplayResult> {
  assertProtectedMutationAllowed(options.env);
  // Read local files before contacting Jenkins so a typo fails fast.
  const mainScript =
    options.script === undefined
      ? undefined
      : await readScriptFile(options.script, "--script");
  const replacements = await readLoadedReplacements(options.loaded);

  const source = await resolveReplayTarget(options);
  const original = await options.client.getReplayScripts(source.buildUrl);
  // Fail on a name the build never loaded, before anything is posted.
  for (const name of replacements.keys()) {
    loadedScript(original, name, source);
  }
  const scripts: ReplayScripts = {
    mainScript: mainScript ?? original.mainScript,
    loadedScripts: {
      ...original.loadedScripts,
      ...Object.fromEntries(replacements),
    },
  };
  const edited =
    scripts.mainScript !== original.mainScript ||
    [...replacements].some(
      ([name, text]) => original.loadedScripts[name] !== text,
    );

  // Build numbers and queue ids only grow, so anything newer than these
  // baselines was created after the POST.
  const [lastBuild, queueItems] = await Promise.all([
    options.client.getLastBuild(source.jobUrl),
    options.client.listQueueItems(),
  ]);
  const baseline = {
    afterBuildNumber: lastBuild?.buildNumber ?? source.buildNumber,
    afterQueueId: Math.max(0, ...queueItems.map((item) => item.id)),
  };
  const submission = await options.client.replayBuild({
    buildUrl: source.buildUrl,
    jobUrl: source.jobUrl,
    scripts,
  });
  const locate = () => locateReplayedBuild(options.client, source, baseline);

  let started: TriggerBuildResult | null;
  if (submission.outcome === "accepted") {
    started = await locate();
  } else if (
    submission.outcome === "rejected" &&
    submission.kind === "http_error" &&
    submission.httpStatus < 500
  ) {
    // A Jenkins-authored 4xx proves nothing was queued.
    throw rejectionError(submission, source);
  } else {
    // The replay may still have run; only its build proves it did.
    started = await locate();
    if (!started) {
      throw submission.outcome === "unconfirmed"
        ? unknownOutcomeError(submission, source)
        : rejectionError(submission, source);
    }
  }

  await recordRecentJob({ env: options.env, jobUrl: source.jobUrl });
  return { source, edited, started };
}

async function resolveReplayTarget(
  options: ReplayOptions,
): Promise<ReplayTarget> {
  const target = await resolveBuildSelector({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    build: options.build,
    buildUrl: options.buildUrl,
    nonInteractive: options.nonInteractive,
  });
  if (target.kind !== "build") {
    invalidUsage("Replay needs an exact build.");
  }
  return target;
}

async function readScriptFile(path: string, flag: string): Promise<string> {
  let script: string;
  try {
    script =
      path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  } catch (error) {
    throw new CliError(
      `Cannot read ${flag} file ${path}.`,
      [error instanceof Error ? error.message : String(error)],
      "INVALID_USAGE",
    );
  }
  // Jenkins would run an empty script as a build that does nothing.
  if (!script.trim()) {
    throw new CliError(
      `The ${flag} script ${path === "-" ? "from stdin" : path} is empty.`,
      ["Print the original with --print-script, edit it, and pass that file."],
      "INVALID_USAGE",
    );
  }
  return script;
}

async function readLoadedReplacements(
  values: string[],
): Promise<Map<string, string>> {
  const replacements = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    const name = value.slice(0, separator).trim();
    const path = value.slice(separator + 1).trim();
    if (separator < 0 || !name || !path) {
      invalidUsage(`Invalid --loaded value "${value}"; use NAME=file.`);
    }
    if (path === "-") {
      invalidUsage("--loaded cannot read stdin; pass a file path.");
    }
    replacements.set(name, await readScriptFile(path, "--loaded"));
  }
  return replacements;
}

function loadedScript(
  scripts: ReplayScripts,
  name: string,
  target: ReplayTarget,
): string {
  const script = scripts.loadedScripts[name];
  if (script !== undefined) {
    return script;
  }
  const names = Object.keys(scripts.loadedScripts);
  throw new CliError(
    `Build ${target.jobLabel} #${target.buildNumber} did not load a script named "${name}".`,
    [
      names.length > 0
        ? `Loaded scripts: ${names.join(", ")}.`
        : "The build loaded no scripts; only --script can be replaced.",
    ],
    "REPLAY_SCRIPT_NOT_FOUND",
  );
}

/**
 * Jenkins does not say which build a replay queued, so look for it: a build
 * or queue item newer than the baselines whose cause is a replay of `source`.
 */
async function locateReplayedBuild(
  client: JenkinsClient,
  source: ReplayTarget,
  baseline: { afterBuildNumber: number; afterQueueId: number },
): Promise<TriggerBuildResult | null> {
  const deadline = Date.now() + LOCATE_TIMEOUT_MS;
  while (true) {
    const found = await client.findReplayedBuild({
      jobUrl: source.jobUrl,
      sourceBuildNumber: source.buildNumber,
      ...baseline,
    });
    if (found || Date.now() >= deadline) {
      return found;
    }
    await Bun.sleep(LOCATE_POLL_MS);
  }
}

function rejectionError(
  submission: Extract<PostSubmission, { outcome: "rejected" }>,
  source: ReplayTarget,
): CliError {
  const label = `${source.jobLabel} #${source.buildNumber}`;
  const detail = submission.detail ? `: ${submission.detail}` : ".";
  if (submission.httpStatus === 403) {
    return new CliError(
      `Jenkins refused to replay ${label}${detail}`,
      [
        "Replay needs the Run/Replay permission, which Job/Configure implies. A Pipeline that runs outside the Groovy sandbox also needs Overall/Administer.",
      ],
      "REPLAY_PERMISSION_DENIED",
    );
  }
  if (submission.httpStatus === 404) {
    return new CliError(
      `Build ${label} has no Replay page.`,
      [
        "Replay works only for Pipeline builds, of a job that is enabled, with the Job/Build permission.",
      ],
      "REPLAY_UNAVAILABLE",
    );
  }
  return new CliError(
    `Jenkins rejected the replay of ${label} with HTTP ${submission.httpStatus}${detail}`,
    ["Nothing was queued. Fix the cause and run the replay again."],
    "REPLAY_REJECTED",
  );
}

function unknownOutcomeError(
  submission: Extract<PostSubmission, { outcome: "unconfirmed" }>,
  source: ReplayTarget,
): CliError {
  return new CliError(
    `The replay of ${source.jobLabel} #${source.buildNumber} could not be confirmed: ${submission.reason}`,
    [
      `No replayed build appeared within ${LOCATE_TIMEOUT_MS / 1000}s, but Jenkins may still start one. Check before replaying again: jenkins-cli history --job-url ${source.jobUrl}`,
    ],
    "REPLAY_OUTCOME_UNKNOWN",
  );
}

function printReplayResult(replay: ReplayResult): void {
  const { source, started } = replay;
  printOk(
    `Replaying ${source.jobLabel} #${source.buildNumber} with ${replay.edited ? "edited" : "its original"} scripts. Parameters are copied from #${source.buildNumber}.`,
  );
  if (started?.buildUrl) {
    printOk(`Build started at ${started.buildUrl}.`);
    return;
  }
  if (started?.queueUrl) {
    printOk(`Build queued at ${started.queueUrl}.`);
    return;
  }
  printWarning(
    `Jenkins accepted the replay, but its build did not appear within ${LOCATE_TIMEOUT_MS / 1000}s. Find it with: jenkins-cli history --job-url ${source.jobUrl}`,
  );
}

function notFoundToFollow(source: ReplayTarget): CliError {
  return new CliError(
    "The replayed build cannot be followed because it was not found.",
    [`Find it with: jenkins-cli history --job-url ${source.jobUrl}`],
    "NO_ACTIVE_BUILD",
  );
}

async function followReplay(
  options: ReplayOptions,
  replay: ReplayResult,
): Promise<void> {
  const { started } = replay;
  let buildUrl = started?.buildUrl;
  if (!buildUrl && started?.queueUrl) {
    buildUrl = await waitForQueuedBuild(
      options.client,
      started.queueUrl,
      DEFAULT_LOG_POLL_MS,
    );
  }
  if (!buildUrl) {
    throw notFoundToFollow(replay.source);
  }
  await runLogs({
    client: options.client,
    env: options.env,
    buildUrl,
    follow: true,
    nonInteractive: true,
  });
  const status = await options.client.getBuildStatus(buildUrl);
  if (status.building) {
    // Following stopped early; logs already set the exit code.
    return;
  }
  const result = status.result ?? "UNKNOWN";
  printOk(`Build #${status.buildNumber ?? "?"} finished: ${result}.`);
  if (result !== "SUCCESS") {
    process.exitCode = EXIT_CODES.FAILURE;
  }
}

async function waitForReplay(
  options: ReplayOptions,
  replay: ReplayResult,
): Promise<{ target: TriggerBuildResult; result: string }> {
  const { started } = replay;
  if (!started) {
    throw notFoundToFollow(replay.source);
  }
  const waited = await waitForBuild({
    client: options.client,
    env: options.env,
    jobUrl: replay.source.jobUrl,
    jobLabel: replay.source.jobLabel,
    buildUrl: started.buildUrl,
    buildNumber: started.buildNumber,
    queueUrl: started.queueUrl,
    nonInteractive: true,
    suppressOutput: true,
  });
  if (waited.result !== "SUCCESS") {
    process.exitCode = EXIT_CODES.FAILURE;
  }
  return {
    target: {
      ...started,
      buildUrl: waited.buildUrl ?? started.buildUrl,
      buildNumber: waited.buildNumber ?? started.buildNumber,
    },
    result: waited.result,
  };
}
