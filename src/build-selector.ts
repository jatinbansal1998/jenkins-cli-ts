import { CliError } from "./cli";
import type { EnvConfig } from "./env";
import type { JenkinsClient } from "./jenkins/client";
import { normalizeControllerTargetUrl } from "./jenkins-target-url";
import { normalizeJobUrl } from "./job-url";
import { resolveJobTarget } from "./commands/ops-helpers";

type ResolvedBuildSelector =
  | {
      kind: "build";
      jobUrl: string;
      jobLabel: string;
      buildUrl: string;
      buildNumber: number;
    }
  | {
      kind: "queue";
      queueUrl: string;
      jobUrl?: string;
      jobLabel: string;
    }
  | {
      kind: "job";
      jobUrl: string;
      jobLabel: string;
    };

export async function resolveBuildSelector(options: {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  build?: number;
  buildUrl?: string;
  queueUrl?: string;
  nonInteractive: boolean;
  allowQueue?: boolean;
  allowQueueWithJob?: boolean;
  resolveJob?: typeof resolveJobTarget;
}): Promise<ResolvedBuildSelector> {
  validateSelectorCombinations(options);

  const directBuildUrl = options.buildUrl?.trim();
  if (directBuildUrl) {
    return resolveDirectBuildUrl(directBuildUrl, options.env);
  }

  const queueUrl = options.queueUrl?.trim();
  if (queueUrl) {
    const canonicalQueueUrl = normalizeControllerTargetUrl(
      queueUrl,
      options.env.jenkinsUrl,
      "queue-url",
    );
    if (options.job || options.jobUrl) {
      const target = await (options.resolveJob ?? resolveJobTarget)({
        client: options.client,
        env: options.env,
        job: options.job,
        jobUrl: options.jobUrl,
        nonInteractive: options.nonInteractive,
      });
      return {
        kind: "queue",
        queueUrl: `${canonicalQueueUrl}/`,
        jobUrl: target.jobUrl,
        jobLabel: target.jobLabel,
      };
    }
    return {
      kind: "queue",
      queueUrl: `${canonicalQueueUrl}/`,
      jobLabel: `${canonicalQueueUrl}/`,
    };
  }

  const target = await (options.resolveJob ?? resolveJobTarget)({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });

  if (options.build !== undefined) {
    const buildNumber = parseBuildNumber(options.build);
    return {
      kind: "build",
      jobUrl: target.jobUrl,
      jobLabel: target.jobLabel,
      buildNumber,
      buildUrl: `${normalizeJobUrl(target.jobUrl)}/${buildNumber}/`,
    };
  }

  return { kind: "job", ...target };
}

function parseBuildNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new CliError(
      "Invalid --build value.",
      ["Provide a positive integer build number (for example, --build 184)."],
      "INVALID_BUILD_NUMBER",
    );
  }
  return value;
}

function validateSelectorCombinations(options: {
  job?: string;
  jobUrl?: string;
  build?: number;
  buildUrl?: string;
  queueUrl?: string;
  allowQueue?: boolean;
  allowQueueWithJob?: boolean;
}): void {
  const hasJob = Boolean(options.job?.trim());
  const hasJobUrl = Boolean(options.jobUrl?.trim());
  const hasBuild = options.build !== undefined;
  const hasBuildUrl = Boolean(options.buildUrl?.trim());
  const hasQueueUrl = Boolean(options.queueUrl?.trim());

  if (hasJob && hasJobUrl) {
    invalidSelector("Provide either --job or --job-url, not both.");
  }
  if (hasBuildUrl && hasQueueUrl) {
    invalidSelector("Provide either --build-url or --queue-url, not both.");
  }
  if (hasBuildUrl && (hasJob || hasJobUrl)) {
    invalidSelector(
      "When --build-url is provided, do not pass --job or --job-url.",
    );
  }
  if (hasBuildUrl && hasBuild) {
    invalidSelector("When --build-url is provided, do not pass --build.");
  }
  if (hasBuild && hasQueueUrl) {
    invalidSelector("Provide either --build or --queue-url, not both.");
  }
  if (hasBuild && hasJob === hasJobUrl) {
    invalidSelector(
      "--build requires exactly one job selector: --job or --job-url.",
    );
  }
  if (hasQueueUrl && !options.allowQueue) {
    invalidSelector("--queue-url is not supported by this command.");
  }
  if (hasQueueUrl && (hasJob || hasJobUrl) && !options.allowQueueWithJob) {
    invalidSelector(
      "When --queue-url is provided, do not pass --job or --job-url.",
    );
  }
}

function resolveDirectBuildUrl(
  value: string,
  env: EnvConfig,
): Extract<ResolvedBuildSelector, { kind: "build" }> {
  const normalized = normalizeControllerTargetUrl(
    value,
    env.jenkinsUrl,
    "build-url",
  );
  const url = new URL(normalized);
  const segments = url.pathname.replace(/\/+$/, "").split("/");
  const rawBuildNumber = segments.pop() ?? "";
  if (!/^\d+$/.test(rawBuildNumber)) {
    throw new CliError(
      "Invalid --build-url value.",
      [
        "Provide a canonical numeric build URL such as https://jenkins.example.com/job/api/184/.",
      ],
      "INVALID_BUILD_NUMBER",
    );
  }
  const buildNumber = parseBuildNumber(Number(rawBuildNumber));
  url.pathname = segments.join("/") || "/";
  const jobUrl = url.toString().replace(/\/+$/, "");
  return {
    kind: "build",
    jobUrl,
    jobLabel: jobUrl,
    buildUrl: `${jobUrl}/${buildNumber}/`,
    buildNumber,
  };
}

function invalidSelector(message: string): never {
  throw new CliError(
    message,
    [
      "Use one exact build target, or omit it to keep the command's latest-build behavior.",
    ],
    "INVALID_BUILD_SELECTOR",
  );
}
