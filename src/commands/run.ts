import { CliError, printHint, printOk } from "../cli";
import type { JenkinsClient } from "../jenkins/client";
import type { RunningBuildSummary } from "../types/jenkins";
import {
  jsonRunningBuild,
  runJsonCommand,
  type JsonWrite,
} from "../json-output";
import { runDeps } from "./run-deps";

type RunOptions = {
  client: JenkinsClient;
  nonInteractive: boolean;
  json?: boolean;
  write?: JsonWrite;
};

let activeRunDeps = runDeps;

export function setRunDepsForTesting(overrides?: typeof runDeps): void {
  activeRunDeps = overrides ?? runDeps;
}

export async function runRunningBuilds(options: RunOptions): Promise<void> {
  if (options.json) {
    await runJsonCommand(
      "run",
      async () =>
        (await options.client.listRunningBuilds()).map(jsonRunningBuild),
      { write: options.write },
    );
    return;
  }
  const builds = await options.client.listRunningBuilds();
  if (builds.length === 0) {
    printOk("no running builds");
    return;
  }

  if (options.nonInteractive) {
    for (const build of builds) {
      console.log(`${formatRunningBuildLabel(build)}: ${build.buildUrl}`);
    }
    return;
  }

  const deps = activeRunDeps;
  const selection = await deps.select({
    message: "Select a running build",
    options: builds.map((build) => ({
      value: build.buildUrl,
      label: formatRunningBuildLabel(build),
    })),
  });
  if (deps.isCancel(selection)) {
    return;
  }

  const selected = builds.find((build) => build.buildUrl === selection);
  if (!selected) {
    throw new CliError("Selected running build is no longer available.");
  }

  try {
    await deps.openInBrowser(selected.buildUrl);
  } catch {
    console.log(selected.buildUrl);
    printHint("Could not open the browser. Open the build URL manually.");
  }
}

function formatRunningBuildLabel(build: RunningBuildSummary): string {
  const jobName = build.fullJobName?.trim() || build.jobName;
  return `${jobName} #${build.buildNumber}`;
}
