#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";

const outfile = "./dist/jenkins-cli-sentry-smoke";
await mkdir("./dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./scripts/verify-sentry.ts"],
  target: "bun",
  compile: { outfile },
  sourcemap: "linked",
  define: {
    __BUILD_TARGET__: JSON.stringify("bun-linux-x64-sentry-smoke"),
  },
});

if (!result.success) {
  console.error("Sentry smoke build failed:", result.logs);
  process.exit(1);
}

console.log(`Built ${outfile}`);
