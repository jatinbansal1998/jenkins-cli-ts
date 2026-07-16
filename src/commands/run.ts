import { CliError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import type { RunningBuildSummary } from "../types/jenkins";
import { withPromptTarget } from "../tui-target";
import { runDeps } from "./run-deps";

type RunOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  nonInteractive: boolean;
};

let activeRunDeps = runDeps;

export function setRunDepsForTesting(overrides?: typeof runDeps): void {
  activeRunDeps = overrides ?? runDeps;
}

export async function runRunningBuilds(options: RunOptions): Promise<void> {
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
    message: withPromptTarget("Select a running build", options.env),
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

export function formatRunningBuildLabel(build: RunningBuildSummary): string {
  const jobName = build.fullJobName?.trim() || build.jobName;
  return `${jobName} #${build.buildNumber}`;
}
