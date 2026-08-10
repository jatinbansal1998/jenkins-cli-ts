/**
 * Repo-specific lint guards for patterns oxlint cannot express.
 *
 * - `mock.restore()` is global in Bun and destroys other test files' spies and
 *   module mocks (tests share one process), so it is banned everywhere.
 * - Bare `.toLocaleString()` renders locale-dependent numeric dates such as
 *   8/7/2026 that misread across locales. Pass a locale and options, or use
 *   the helpers in src/status-format.ts.
 */
import { Glob } from "bun";

type Guard = {
  pattern: RegExp;
  message: string;
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
