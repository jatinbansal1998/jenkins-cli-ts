import { resolveBuildSelector } from "../build-selector";
import { CliError } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import { runJsonCommand, type JsonWrite } from "../json-output";
import { formatTable, truncateCell } from "../table";
import type {
  BuildCause,
  BuildChange,
  BuildChangesReport,
} from "../types/jenkins";

export const DEFAULT_CHANGES_LIMIT = 20;
const MAX_CHANGES_LIMIT = 1_000;
const SUBJECT_WIDTH = 72;

type ChangesOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  build?: number;
  buildUrl?: string;
  limit?: number;
  paths?: boolean;
  nonInteractive: boolean;
  json?: boolean;
  write?: JsonWrite;
};

const defaultWrite: JsonWrite = (text) => {
  process.stdout.write(text);
};

export async function runChanges(options: ChangesOptions): Promise<void> {
  if (options.json) {
    await runJsonCommand(
      "changes",
      async () => toJsonChanges(await loadChanges(options)),
      { write: options.write },
    );
    return;
  }

  const report = await loadChanges(options);
  (options.write ?? defaultWrite)(renderChanges(report));
}

async function loadChanges(
  options: ChangesOptions,
): Promise<BuildChangesReport> {
  const limit = parseLimit(options.limit);
  const target = await resolveBuildSelector({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    build: options.build,
    buildUrl: options.buildUrl,
    nonInteractive: options.nonInteractive,
  });
  const buildUrl =
    target.kind === "build"
      ? target.buildUrl
      : (await resolveLastBuild(options.client, target)).buildUrl;
  return await options.client.getBuildChanges(buildUrl, {
    limit,
    includePaths: Boolean(options.paths),
  });
}

async function resolveLastBuild(
  client: JenkinsClient,
  target: { kind: string; jobUrl?: string; jobLabel: string },
): Promise<{ buildUrl: string }> {
  if (target.kind !== "job" || !target.jobUrl) {
    throw new CliError("Changes require a build or job target.");
  }
  const lastBuild = await client.getLastBuild(target.jobUrl);
  if (!lastBuild) {
    throw new CliError(
      `No builds found for ${target.jobLabel}.`,
      ["Trigger a build first, or pass --build <number> or --build-url <url>."],
      "NO_BUILDS",
    );
  }
  return lastBuild;
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CHANGES_LIMIT;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CHANGES_LIMIT) {
    throw new CliError(
      "Invalid --limit value.",
      [`Provide a positive integer up to ${MAX_CHANGES_LIMIT}.`],
      "INVALID_LIMIT",
    );
  }
  return value;
}

function toJsonChanges(report: BuildChangesReport): object {
  return {
    build: {
      number: report.buildNumber,
      url: report.buildUrl,
    },
    causes: report.causes,
    changes: report.changes,
    pagination: {
      limit: report.limit,
      returned: report.returned,
      total: report.total,
      truncated: report.truncated,
    },
  };
}

function renderChanges(report: BuildChangesReport): string {
  const build = report.buildNumber ? `#${report.buildNumber}` : report.buildUrl;
  const lines = [`Build: ${build} (${report.buildUrl})`];

  if (report.causes.length === 0) {
    lines.push("Caused by: unknown");
  } else {
    lines.push("Caused by:");
    lines.push(...report.causes.map((cause) => `  ${renderCause(cause)}`));
  }

  lines.push("");
  if (report.changes.length === 0) {
    lines.push("No changes in this build.");
  } else {
    const count = report.truncated
      ? `first ${report.returned}`
      : `${report.returned}`;
    lines.push(`Changes (${count}):`);
    lines.push(
      formatTable([
        ["ID", "AUTHOR", "DATE", "SUBJECT"],
        ...report.changes.map(renderChangeRow),
      ]),
    );
    // Paths are only present when --paths was requested.
    const withPaths = report.changes.filter((change) => change.paths?.length);
    if (withPaths.length > 0) {
      lines.push("");
      lines.push("Affected paths:");
      for (const change of withPaths) {
        lines.push(`  ${change.id ? change.id.slice(0, 12) : "-"}:`);
        lines.push(...(change.paths ?? []).map((path) => `    ${path}`));
        if (change.pathsTruncated) {
          lines.push(
            `    (more paths exist; showing the first ${change.paths?.length}; see the build's changes in Jenkins)`,
          );
        }
      }
    }
  }
  if (report.truncated) {
    lines.push("");
    lines.push(
      `More changes exist; showing the first ${report.limit}. Raise --limit to see more.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderCause(cause: BuildCause): string {
  const summary =
    cause.summary ??
    (cause.type === "upstream" && cause.upstreamJob
      ? `Upstream ${cause.upstreamJob} #${cause.upstreamBuild ?? "?"}`
      : undefined);
  return summary ? `${cause.type}: ${summary}` : cause.type;
}

function renderChangeRow(change: BuildChange): string[] {
  const subject = change.message?.split("\n", 1)[0] ?? "";
  return [
    // Short-SHA style: cut without an ellipsis, the prefix stays usable.
    change.id ? change.id.slice(0, 12) : "-",
    change.author ?? "-",
    formatChangeTimestamp(change.timestampMs),
    truncateCell(subject, SUBJECT_WIDTH) || "-",
  ];
}

function formatChangeTimestamp(timestampMs: number | undefined): string {
  if (typeof timestampMs !== "number" || timestampMs <= 0) {
    return "-";
  }
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
