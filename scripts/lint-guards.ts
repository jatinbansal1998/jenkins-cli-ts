/**
 * Repo-specific lint guards for patterns oxlint cannot express.
 *
 * - `mock.restore()` is global in Bun and destroys other test files' spies and
 *   module mocks (tests share one process), so it is banned everywhere.
 * - Bare `.toLocaleString()` renders locale-dependent numeric dates such as
 *   8/7/2026 that misread across locales. Pass a locale and options, or use
 *   the helpers in src/status-format.ts.
 * - Command output must go through the helpers in src/cli.ts, or `--quiet`
 *   stops being quiet.
 */
import { Glob } from "bun";

type Guard = {
  pattern: RegExp;
  message: string;
  /** Limits the guard to matching paths; all scanned files otherwise. */
  paths?: RegExp;
};

const GUARDS: Guard[] = [
  {
    pattern: /\bmock\.restore\(\)/,
    message:
      "mock.restore() is global in Bun and breaks other test files' mocks. Restore individual spies with mockRestore() instead.",
  },
  {
    pattern: /\.toLocaleString\(\)/,
    message:
      "Bare toLocaleString() produces ambiguous numeric dates. Pass a locale and options, or use formatStatusDetails helpers.",
  },
  {
    pattern: /\bconsole\.(log|info|warn|error)\b|\bprocess\.stdout\.write\b/,
    message:
      "Write output with the helpers in src/cli.ts (printLine, printOk, printWarning, writeStdout, ...) so --quiet can suppress it.",
    paths: /^src\/(?!cli\.ts$)/,
  },
];

const glob = new Glob("{src,tests,scripts}/**/*.ts");
let failures = 0;

for await (const path of glob.scan(".")) {
  if (path.endsWith("lint-guards.ts")) {
    continue;
  }
  const lines = (await Bun.file(path).text()).split("\n");
  lines.forEach((line, index) => {
    for (const guard of GUARDS) {
      if (guard.paths && !guard.paths.test(path)) {
        continue;
      }
      if (guard.pattern.test(line)) {
        console.error(`${path}:${index + 1}: ${guard.message}`);
        failures += 1;
      }
    }
  });
}

if (failures > 0) {
  process.exit(1);
}
