import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveUserHome } from "../src/user-home";
import { cliLogFiles } from "./integration/jenkins/harness";

afterEach(() => setSystemTime());

test("finds both sides of UTC midnight without reading unrelated files", () => {
  const home = resolveUserHome();
  const directory = join(home, ".config", "jenkins-cli");
  mkdirSync(directory, { recursive: true });
  const logs = ["api-2026-01-01.log", "api-2026-01-02.log"];
  for (const file of [...logs, "error-2026-01-02.log", "api.log"])
    writeFileSync(join(directory, file), "synthetic log");
  setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
  expect(cliLogFiles(home, "api")).toEqual(
    logs.map((file) => join(directory, file)),
  );
});
