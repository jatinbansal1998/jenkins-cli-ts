import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reporting helpers must never persist test errors in the developer's home.
const previousHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), "jenkins-cli-test-home-"));
process.env.HOME = testHome;
afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});
