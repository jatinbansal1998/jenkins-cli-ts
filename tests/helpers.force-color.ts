import { afterAll, beforeAll } from "bun:test";

/**
 * Keeps `util.styleText` emitting escape codes for the calling test file.
 *
 * Bun 1.4 implements Node's stream check in `styleText`, which strips styling
 * when stdout is not a TTY. Under the test runner it never is, but the prompt
 * renderers only ever draw to a real terminal, so their tests need the styled
 * output. `NO_COLOR` is cleared alongside because leaving it set next to
 * `FORCE_COLOR` makes Bun warn on stderr.
 */
export function forceColorForFile(): void {
  let previousNoColor: string | undefined;
  let previousForceColor: string | undefined;

  beforeAll(() => {
    previousNoColor = process.env.NO_COLOR;
    previousForceColor = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
  });

  afterAll(() => {
    restore("NO_COLOR", previousNoColor);
    restore("FORCE_COLOR", previousForceColor);
  });
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
