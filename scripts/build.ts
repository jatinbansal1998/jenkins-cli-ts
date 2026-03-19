#!/usr/bin/env bun

/**
 * Cross-compile jenkins-cli for all supported platforms in parallel
 * and (optionally) prepare release artifacts.
 *
 * Usage:
 *   bun scripts/build.ts            — build all platform binaries
 *   bun scripts/build.ts --release  — build + package tarballs, checksums, Homebrew formula
 *
 * Environment:
 *   TAG_NAME  — git tag (e.g. "v0.7.12"). Required when --release is set.
 */

import { copyFile, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const ENTRY = "./src/index.ts";
const DIST = "./dist";
const RELEASE = process.argv.includes("--release");

const REPO_SLUG = "jatinbansal1998/jenkins-cli-ts";

interface Target {
  target: string;
  outfile: string;
}

const COMPILE_TARGETS: Target[] = [
  { target: "bun-linux-x64", outfile: "jenkins-cli-linux-x64" },
  {
    target: "bun-linux-x64-baseline",
    outfile: "jenkins-cli-linux-x64-baseline",
  },
  { target: "bun-linux-x64-musl", outfile: "jenkins-cli-linux-x64-musl" },
  {
    target: "bun-linux-x64-musl-baseline",
    outfile: "jenkins-cli-linux-x64-musl-baseline",
  },
  { target: "bun-linux-arm64", outfile: "jenkins-cli-linux-arm64" },
  { target: "bun-linux-arm64-musl", outfile: "jenkins-cli-linux-arm64-musl" },
  { target: "bun-darwin-x64", outfile: "jenkins-cli-darwin-x64" },
  { target: "bun-darwin-arm64", outfile: "jenkins-cli-darwin-arm64" },
  { target: "bun-windows-x64", outfile: "jenkins-cli-windows-x64.exe" },
  {
    target: "bun-windows-x64-baseline",
    outfile: "jenkins-cli-windows-x64-baseline.exe",
  },
];

/** Platforms that get Homebrew-compatible tarballs. */
const TARBALL_PLATFORMS = [
  "linux-x64",
  "linux-x64-baseline",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256(filePath: string): Promise<string> {
  const data = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(data)).digest("hex");
}

async function tar(srcFile: string, destTarGz: string): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "jenkins-cli-"));
  const tmpBin = join(tmpDir, "jenkins-cli");
  await copyFile(srcFile, tmpBin);
  await Bun.$`tar -czf ${destTarGz} jenkins-cli`.cwd(tmpDir).quiet();
  await rm(tmpDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 1. Build
// ---------------------------------------------------------------------------

await mkdir(DIST, { recursive: true });

// JS bundle (legacy fallback for users with Bun installed)
const bundleStart = performance.now();
const bundleResult = await Bun.build({
  entrypoints: [ENTRY],
  outdir: DIST,
  naming: "jenkins-cli-bundle",
  target: "bun",
  define: { __BUILD_TARGET__: JSON.stringify("bun-bundle") },
});

if (!bundleResult.success) {
  console.error("❌ Bundle build failed:", bundleResult.logs);
  process.exit(1);
}
console.log(`✅ bundle  (${(performance.now() - bundleStart).toFixed(0)}ms)`);

// Cross-compile all platform executables in parallel
const results = await Promise.allSettled(
  COMPILE_TARGETS.map(async ({ target, outfile }) => {
    const start = performance.now();
    const outpath = join(DIST, outfile);

    const result = await Bun.build({
      entrypoints: [ENTRY],
      // @ts-expect-error -- Bun compile targets are valid at runtime
      compile: { target, outfile: outpath },
      define: { __BUILD_TARGET__: JSON.stringify(target) },
    });

    if (!result.success) {
      throw new Error(`${target}: ${result.logs.join("\n")}`);
    }

    const elapsed = (performance.now() - start).toFixed(0);
    console.log(`✅ ${target.padEnd(28)} → ${outfile}  (${elapsed}ms)`);
  }),
);

const failures = results.filter(
  (r): r is PromiseRejectedResult => r.status === "rejected",
);

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} build(s) failed:\n`);
  for (const f of failures) {
    console.error(` • ${f.reason}`);
  }
  process.exit(1);
}

console.log(`\n🎉 All ${COMPILE_TARGETS.length + 1} builds complete`);

if (!RELEASE) process.exit(0);

// ---------------------------------------------------------------------------
// 2. Release packaging  (only when --release is passed)
// ---------------------------------------------------------------------------

console.log("\n📦 Preparing release artifacts…\n");

// Validate tag vs package.json version
const tagName = process.env.TAG_NAME;
if (!tagName) {
  console.error("❌ TAG_NAME environment variable is required with --release");
  process.exit(1);
}

const tagVersion = tagName.replace(/^v/, "");
const pkg = await Bun.file("package.json").json();
if (pkg.version !== tagVersion) {
  console.error(
    `❌ Tag ${tagName} does not match package.json version ${pkg.version}`,
  );
  process.exit(1);
}

// Legacy cross-platform bundle (old update clients look for "jenkins-cli")
await copyFile(join(DIST, "jenkins-cli-bundle"), join(DIST, "jenkins-cli"));
await chmod(join(DIST, "jenkins-cli"), 0o755);

// Make all platform binaries executable
for (const { outfile } of COMPILE_TARGETS) {
  if (!outfile.endsWith(".exe")) {
    await chmod(join(DIST, outfile), 0o755);
  }
}

// Per-platform tarballs (each contains "jenkins-cli" for Homebrew)
const tarballSha: Record<string, string> = {};

for (const platform of TARBALL_PLATFORMS) {
  const src = join(DIST, `jenkins-cli-${platform}`);
  const dest = join(DIST, `jenkins-cli-${platform}.tar.gz`);
  await tar(src, dest);
  tarballSha[platform] = await sha256(dest);
  console.log(
    `  📁 ${platform}.tar.gz  sha256:${tarballSha[platform].slice(0, 12)}…`,
  );
}

// Homebrew formula — uses array join to avoid escaping Ruby's #{bin} interpolation
const rubyTestCmd = "#{bin}/jenkins-cli --help";
const formula = [
  "class JenkinsCli < Formula",
  `  desc "Minimal Jenkins CLI for listing jobs, triggering builds, and checking status"`,
  `  homepage "https://github.com/${REPO_SLUG}"`,
  `  version "${tagVersion}"`,
  "",
  "  on_macos do",
  "    on_arm do",
  `      url "https://github.com/${REPO_SLUG}/releases/download/${tagName}/jenkins-cli-darwin-arm64.tar.gz"`,
  `      sha256 "${tarballSha["darwin-arm64"]}"`,
  "    end",
  "",
  "    on_intel do",
  `      url "https://github.com/${REPO_SLUG}/releases/download/${tagName}/jenkins-cli-darwin-x64.tar.gz"`,
  `      sha256 "${tarballSha["darwin-x64"]}"`,
  "    end",
  "  end",
  "",
  "  on_linux do",
  "    on_arm do",
  `      url "https://github.com/${REPO_SLUG}/releases/download/${tagName}/jenkins-cli-linux-arm64.tar.gz"`,
  `      sha256 "${tarballSha["linux-arm64"]}"`,
  "    end",
  "",
  "    on_intel do",
  `      url "https://github.com/${REPO_SLUG}/releases/download/${tagName}/jenkins-cli-linux-x64-baseline.tar.gz"`,
  `      sha256 "${tarballSha["linux-x64-baseline"]}"`,
  "    end",
  "  end",
  "",
  "  def install",
  '    bin.install "jenkins-cli"',
  "  end",
  "",
  "  test do",
  `    assert_match "Usage: jenkins-cli", shell_output("${rubyTestCmd}")`,
  "  end",
  "end",
  "",
].join("\n");

await writeFile(join(DIST, "homebrew-jenkins-cli.rb"), formula);
console.log("  🍺 homebrew-jenkins-cli.rb");

// Checksums for every release artifact
const checksumFiles = [
  ...COMPILE_TARGETS.map((t) => t.outfile),
  ...TARBALL_PLATFORMS.map((p) => `jenkins-cli-${p}.tar.gz`),
  "jenkins-cli",
  "homebrew-jenkins-cli.rb",
];

const checksumLines: string[] = [];
for (const file of checksumFiles) {
  const hash = await sha256(join(DIST, file));
  checksumLines.push(`${hash}  ${file}`);
}

await writeFile(join(DIST, "checksums.txt"), checksumLines.join("\n") + "\n");
console.log("  🔒 checksums.txt");

console.log("\n✅ Release artifacts ready");
