#!/usr/bin/env bun

/**
 * Local single-platform build.
 *
 * Compiles jenkins-cli for the current platform, injecting the build target
 * at compile time via the `define` option.
 *
 * Usage:  bun scripts/build-local.ts
 */

import { mkdir } from "node:fs/promises";

const ENTRY = "./src/index.ts";
const DIST = "./dist";

await mkdir(DIST, { recursive: true });

const target = `bun-${process.platform}-${process.arch}` as const;

const result = await Bun.build({
  entrypoints: [ENTRY],
  compile: { outfile: `${DIST}/jenkins-cli` },
  define: { __BUILD_TARGET__: JSON.stringify(target) },
});

if (!result.success) {
  console.error("❌ Build failed:", result.logs);
  process.exit(1);
}

console.log(`✅ ${DIST}/jenkins-cli (${target})`);
