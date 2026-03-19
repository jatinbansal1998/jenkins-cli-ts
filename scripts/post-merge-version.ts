#!/usr/bin/env bun

import { resolve } from "node:path";

const CODE_RELATED_PATHS = [
  /^src\//,
  /^tests\//,
  /^scripts\//,
  /^package\.json$/,
  /^bun\.lock$/,
  /^tsconfig\.json$/,
  /^version-policy\.json$/,
  /^install$/,
  /^setup\.sh$/,
];

type PostMergePlan = {
  currentVersion: string;
  newVersion: string;
  shouldBump: boolean;
  versionChanged: boolean;
  codeRelatedChanged: boolean;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  skipReason: string | null;
};

type PlanInputs = {
  currentVersion: string;
  isFork: boolean;
  versionChanged: boolean;
  codeRelatedChanged: boolean;
};

export function isCodeRelatedPath(path: string): boolean {
  return CODE_RELATED_PATHS.some((pattern) => pattern.test(path));
}

export function bumpPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

export function buildPostMergePlan(inputs: PlanInputs): PostMergePlan {
  const shouldBump =
    !inputs.isFork && !inputs.versionChanged && inputs.codeRelatedChanged;
  const newVersion = shouldBump
    ? bumpPatchVersion(inputs.currentVersion)
    : inputs.currentVersion;
  const commitMessage = shouldBump
    ? `chore: bump version to ${newVersion}, lint and format`
    : "chore: lint and format";
  const prTitle = commitMessage;
  const prBody = [
    "Automated changes:",
    ...(shouldBump ? [`- Bumped patch version to ${newVersion}`] : []),
    "- Applied oxlint --fix",
    "- Applied Prettier formatting",
  ].join("\n");

  let skipReason: string | null = null;
  if (inputs.isFork) {
    skipReason = "Running on fork - skipping version bump";
  } else if (inputs.versionChanged) {
    skipReason = "Version already changed in last commit; skipping auto-bump";
  } else if (!inputs.codeRelatedChanged) {
    skipReason = "Only non-code files changed; skipping auto-bump";
  }

  return {
    currentVersion: inputs.currentVersion,
    newVersion,
    shouldBump,
    versionChanged: inputs.versionChanged,
    codeRelatedChanged: inputs.codeRelatedChanged,
    commitMessage,
    prTitle,
    prBody,
    skipReason,
  };
}

async function readCurrentVersion(): Promise<string> {
  const pkg = await Bun.file("package.json").json();
  if (typeof pkg.version !== "string") {
    throw new Error("package.json is missing a string version field");
  }

  return pkg.version;
}

async function readChangedFiles(): Promise<string[]> {
  const result =
    await Bun.$`git diff --name-only --diff-filter=ACMR HEAD~1 HEAD`.text();
  return result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function packageVersionChanged(): Promise<boolean> {
  const diff = await Bun.$`git diff HEAD~1 HEAD -- package.json`.text();
  return diff.includes('"version"');
}

async function updatePackageJsonVersion(version: string): Promise<void> {
  const pkg = await Bun.file("package.json").json();
  pkg.version = version;
  await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
}

function parseOutputPath(args: string[]): string | null {
  const envOutput = process.env.GITHUB_OUTPUT;
  if (envOutput) {
    return envOutput;
  }

  const index = args.indexOf("--output");
  if (index >= 0) {
    return args[index + 1] ?? null;
  }

  const inline = args.find((arg) => arg.startsWith("--output="));
  if (inline) {
    return inline.slice("--output=".length);
  }

  return null;
}

async function writeOutputs(
  outputPath: string | null,
  plan: PostMergePlan,
): Promise<void> {
  const lines = [
    `new_version=${plan.newVersion}`,
    `commit_message=${plan.commitMessage}`,
    `pr_title=${plan.prTitle}`,
    `should_bump=${String(plan.shouldBump)}`,
    `version_changed=${String(plan.versionChanged)}`,
    `code_related_changed=${String(plan.codeRelatedChanged)}`,
  ];
  const bodyBlock = `pr_body<<PRBODY\n${plan.prBody}\nPRBODY`;
  const skipBlock = plan.skipReason
    ? `skip_reason=${plan.skipReason}`
    : "skip_reason=";
  const payload = [...lines, bodyBlock, skipBlock, ""].join("\n");

  if (outputPath) {
    const resolved = resolve(outputPath);
    const existing = await Bun.file(resolved)
      .text()
      .catch(() => "");
    await Bun.write(resolved, `${existing}${payload}`);
    return;
  }

  console.log(payload.trimEnd());
}

export async function main(
  args = process.argv.slice(2),
): Promise<PostMergePlan> {
  const outputPath = parseOutputPath(args);
  const isFork =
    process.env.GITHUB_EVENT_REPOSITORY_FORK === "true" ||
    process.env.IS_FORK === "true";
  const currentVersion = await readCurrentVersion();
  const versionChanged = await packageVersionChanged();
  const changedFiles = await readChangedFiles();
  const codeRelatedChanged = changedFiles.some(isCodeRelatedPath);

  const plan = buildPostMergePlan({
    currentVersion,
    isFork,
    versionChanged,
    codeRelatedChanged,
  });

  if (plan.shouldBump) {
    await updatePackageJsonVersion(plan.newVersion);
  }

  await writeOutputs(outputPath, plan);

  return plan;
}

if (import.meta.main) {
  await main();
}
