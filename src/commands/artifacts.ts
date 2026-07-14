import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isCancel, multiselect, text } from "../clack";
import { CliError, printHint, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { normalizeJobUrl } from "../job-url";
import type { ArtifactEntry } from "../types/jenkins";
import { ensureValidUrl, resolveJobTarget } from "./ops-helpers";

type ArtifactsOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  buildUrl?: string;
  build?: number;
  download?: boolean;
  dest?: string;
  artifact?: string[];
  force?: boolean;
  nonInteractive: boolean;
};

export async function runArtifacts(options: ArtifactsOptions): Promise<void> {
  validateArtifactsOptions(options);

  const { buildUrl, label } = await resolveBuildTarget(options);
  const { artifacts } = await options.client.listArtifacts(buildUrl);

  if (artifacts.length === 0) {
    printOk(`no artifacts for ${label}`);
    return;
  }

  renderArtifactsTable(artifacts);
  printOk(
    `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} for ${label}.`,
  );

  const selection = await resolveArtifactsToDownload(options, artifacts);
  if (!selection) {
    return;
  }

  await downloadArtifacts({
    client: options.client,
    buildUrl,
    artifacts: selection.artifacts,
    dest: selection.dest,
    force: Boolean(options.force),
  });
}

function validateArtifactsOptions(options: ArtifactsOptions): void {
  if (options.job && options.jobUrl) {
    throw new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
  }
  if (options.buildUrl && (options.job || options.jobUrl)) {
    throw new CliError(
      "When --build-url is provided, do not pass --job or --job-url.",
      ["Use a single build target at a time."],
    );
  }
  if (options.buildUrl && typeof options.build === "number") {
    throw new CliError("When --build-url is provided, do not pass --build.", [
      "Use a single build target at a time.",
    ]);
  }
  if (
    typeof options.build === "number" &&
    (!Number.isFinite(options.build) || options.build <= 0)
  ) {
    throw new CliError("Invalid --build value.", [
      "Provide a positive build number (e.g. --build 184).",
    ]);
  }
}

async function resolveBuildTarget(
  options: ArtifactsOptions,
): Promise<{ buildUrl: string; label: string }> {
  const providedBuildUrl = options.buildUrl?.trim() ?? "";
  if (providedBuildUrl) {
    ensureValidUrl(providedBuildUrl, "build-url");
    return { buildUrl: providedBuildUrl, label: providedBuildUrl };
  }

  const target = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive: options.nonInteractive,
  });

  if (typeof options.build === "number") {
    const buildUrl = `${normalizeJobUrl(target.jobUrl)}/${options.build}/`;
    return {
      buildUrl,
      label: `${target.jobLabel} #${options.build}`,
    };
  }

  const completed = await options.client.getLastCompletedBuild(target.jobUrl);
  if (!completed) {
    throw new CliError(`No completed builds found for ${target.jobLabel}.`, [
      "Trigger a build first, or pass --build <number> or --build-url <url>.",
    ]);
  }
  return {
    buildUrl: completed.buildUrl,
    label: `${target.jobLabel} #${completed.buildNumber ?? "?"}`,
  };
}

async function resolveArtifactsToDownload(
  options: ArtifactsOptions,
  artifacts: ArtifactEntry[],
): Promise<{ artifacts: ArtifactEntry[]; dest: string } | null> {
  const requested = (options.artifact ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (options.download) {
    const selected =
      requested.length > 0 ? filterArtifacts(artifacts, requested) : artifacts;
    return {
      artifacts: selected,
      dest: normalizeDest(options.dest),
    };
  }

  // A restricting flag was given without --download; treat it as a download
  // request so scripted callers do not silently just list.
  if (requested.length > 0) {
    return {
      artifacts: filterArtifacts(artifacts, requested),
      dest: normalizeDest(options.dest),
    };
  }

  if (options.nonInteractive) {
    return null;
  }

  const chosen = await promptForArtifacts(artifacts);
  if (chosen.length === 0) {
    printOk("No artifacts selected.");
    return null;
  }
  const dest = await promptForDest(options.dest);
  return { artifacts: chosen, dest };
}

function filterArtifacts(
  artifacts: ArtifactEntry[],
  requested: string[],
): ArtifactEntry[] {
  const selected: ArtifactEntry[] = [];
  const unknown: string[] = [];
  for (const value of requested) {
    const match = artifacts.find(
      (entry) => entry.relativePath === value || entry.fileName === value,
    );
    if (!match) {
      unknown.push(value);
      continue;
    }
    if (!selected.includes(match)) {
      selected.push(match);
    }
  }
  if (unknown.length > 0) {
    throw new CliError(
      `Requested artifact${unknown.length === 1 ? "" : "s"} not found: ${unknown.join(", ")}.`,
      ["Run `artifacts` without --download to list available artifacts."],
    );
  }
  return selected;
}

async function promptForArtifacts(
  artifacts: ArtifactEntry[],
): Promise<ArtifactEntry[]> {
  const response = await multiselect({
    message: "Select artifacts to download",
    options: artifacts.map((entry) => ({
      value: entry.relativePath,
      label: entry.relativePath,
    })),
    required: false,
  });
  if (isCancel(response)) {
    return [];
  }
  const values = new Set(Array.isArray(response) ? response.map(String) : []);
  return artifacts.filter((entry) => values.has(entry.relativePath));
}

async function promptForDest(destOption: string | undefined): Promise<string> {
  const fallback = normalizeDest(destOption);
  const response = await text({
    message: "Destination directory",
    initialValue: fallback,
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  const value = String(response).trim();
  return value ? path.resolve(value) : fallback;
}

function normalizeDest(destOption: string | undefined): string {
  const value = destOption?.trim();
  return value ? path.resolve(value) : process.cwd();
}

async function downloadArtifacts(options: {
  client: JenkinsClient;
  buildUrl: string;
  artifacts: ArtifactEntry[];
  dest: string;
  force: boolean;
}): Promise<void> {
  let downloaded = 0;
  let skipped = 0;
  for (const artifact of options.artifacts) {
    const destPath = resolveArtifactDestPath(options.dest, artifact);
    if (!options.force && (await Bun.file(destPath).exists())) {
      printHint(
        `Skipped ${artifact.relativePath} (already exists; pass --force to overwrite).`,
      );
      skipped += 1;
      continue;
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    const bytes = await options.client.downloadArtifact(
      options.buildUrl,
      artifact.relativePath,
      destPath,
    );
    printOk(
      `Downloaded ${artifact.relativePath} -> ${destPath} (${bytes} bytes)`,
    );
    downloaded += 1;
  }

  const summary =
    skipped > 0
      ? `Downloaded ${downloaded} artifact${downloaded === 1 ? "" : "s"} to ${options.dest} (${skipped} skipped).`
      : `Downloaded ${downloaded} artifact${downloaded === 1 ? "" : "s"} to ${options.dest}.`;
  printOk(summary);
}

function resolveArtifactDestPath(
  dest: string,
  artifact: ArtifactEntry,
): string {
  const relativePath = artifact.relativePath.trim();
  const normalizedRelativePath = relativePath.replaceAll("\\", "/");
  const segments = normalizedRelativePath.split("/");
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    segments.some((segment) => segment === "..")
  ) {
    throw new CliError(`Unsafe artifact path: ${artifact.relativePath}.`, [
      "Jenkins returned an artifact path that would write outside the destination directory.",
    ]);
  }

  const destRoot = path.resolve(dest);
  const destPath = path.resolve(destRoot, normalizedRelativePath);
  const relativeToDest = path.relative(destRoot, destPath);
  if (
    relativeToDest === "" ||
    relativeToDest.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToDest)
  ) {
    throw new CliError(`Unsafe artifact path: ${artifact.relativePath}.`, [
      "Jenkins returned an artifact path that would write outside the destination directory.",
    ]);
  }
  return destPath;
}

function renderArtifactsTable(artifacts: ArtifactEntry[]): void {
  const rows = [
    ["File", "Relative Path"],
    ...artifacts.map((entry) => [entry.fileName, entry.relativePath]),
  ];
  const widths = rows[0]?.map((_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  ) ?? [1, 1];
  const table = rows
    .map((row) =>
      row
        .map((cell, cellIndex) => cell.padEnd(widths[cellIndex] ?? cell.length))
        .join("  "),
    )
    .map((line, index) =>
      index === 1 ? `${"-".repeat(line.length)}\n${line}` : line,
    )
    .join("\n");
  console.log(table);
}
