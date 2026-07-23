import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  integrationEnabled,
  jenkinsUrl,
  parseJson,
  runCli,
  withCliHome,
} from "./jenkins/harness";

describe.skipIf(!integrationEnabled)("Jenkins client mutation contract", () => {
  test("protects the critical authenticated build API contract", async () => {
    await withCliHome(async (home) => {
      const jobUrl = `${jenkinsUrl}/job/cli-smoke/`;
      const marker = `mutation-contract-${Date.now()}`;

      expect((await runCli(home, ["auth", "status"])).output).toContain(
        "Authenticated:    Yes",
      );

      const build = await runCli(home, [
        "build",
        "--job-url",
        jobUrl,
        "--param",
        `MESSAGE=${marker}`,
        "--watch",
      ]);
      expect(build.output).toMatch(/Build (?:queued|started)/);
      expect(build.output).toContain("SUCCESS");

      const status = parseJson<{
        data: { build: { result: string; number: number; url: string } };
      }>(await runCli(home, ["status", "--job-url", jobUrl, "--json"]));
      expect(status.data.build.result).toBe("SUCCESS");

      const history = parseJson<{
        data: Array<{ result: string; number: number }>;
      }>(await runCli(home, ["history", "--job-url", jobUrl, "--json"]));
      expect(history.data[0]).toMatchObject({
        result: "SUCCESS",
        number: status.data.build.number,
      });

      const logs = await runCli(home, [
        "logs",
        "--build-url",
        status.data.build.url,
        "--no-follow",
      ]);
      expect(logs.output).toContain(`cli-integration:${marker}`);

      const artifactDir = join(home, "contract-artifacts");
      await runCli(home, [
        "artifacts",
        "--build-url",
        status.data.build.url,
        "--artifact",
        "reports/values.txt",
        "--dest",
        artifactDir,
      ]);
      expect(
        await Bun.file(join(artifactDir, "reports", "values.txt")).text(),
      ).toContain(`message=${marker}`);
    });
  }, 120_000);
});
