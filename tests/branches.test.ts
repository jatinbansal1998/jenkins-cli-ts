import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvConfig } from "../src/env";

// Keep the cache inside the per-file test home even when the runner sets one.
process.env.XDG_CACHE_HOME = join(process.env.HOME ?? "", ".cache");
process.env.LOCALAPPDATA = join(process.env.HOME ?? "", "AppData", "Local");

const { getJobCacheDir, getJobStatePath } = await import("../src/jobs");

// Import fresh per test (cache-busting) so rerun-core.test.ts's
// mock.module("../src/branches", ...) does not leak its stubs into this file.
let branchesModule = await loadFreshBranchesModule();

async function loadFreshBranchesModule(): Promise<
  typeof import("../src/branches")
> {
  return import(`../src/branches?branches-test=${crypto.randomUUID()}`);
}

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

const jobUrl = "https://jenkins.example.com/job/api";
const statePath = getJobStatePath(env.jenkinsUrl);

/** Pretty-printed on purpose: any rewrite would come back compact. */
async function seedState(branches: unknown[]): Promise<string> {
  const raw = JSON.stringify({ branches: { [jobUrl]: branches } }, null, 2);
  await writeFile(statePath, raw);
  return raw;
}

async function readStoredBranches(): Promise<unknown> {
  const parsed = JSON.parse(await Bun.file(statePath).text()) as {
    branches: Record<string, string[]>;
  };
  return parsed.branches[jobUrl];
}

describe("branch selection cache", () => {
  beforeEach(async () => {
    branchesModule = await loadFreshBranchesModule();
    await rm(getJobCacheDir(), { recursive: true, force: true });
    await mkdir(getJobCacheDir(), { recursive: true });
  });

  describe("loadCachedBranches", () => {
    test("prepends cached history to the default branches without duplicates", async () => {
      await seedState(["feature-x", "Staging", "hotfix-1"]);

      const branches = await branchesModule.loadCachedBranches({ env, jobUrl });
      expect(branches).toEqual([
        "feature-x",
        "hotfix-1",
        "development",
        "staging",
        "master",
      ]);
    });

    test("returns only defaults when there is no cache", async () => {
      const branches = await branchesModule.loadCachedBranches({ env, jobUrl });
      expect(branches).toEqual(["development", "staging", "master"]);
    });
  });

  describe("loadCachedBranchHistory", () => {
    test("filters defaults and blanks, dedupes case-insensitively", async () => {
      await seedState([
        "Feature-X",
        " feature-x ",
        "",
        "   ",
        "master",
        "hotfix",
        42,
      ]);

      const history = await branchesModule.loadCachedBranchHistory({
        env,
        jobUrl,
      });
      expect(history).toEqual(["Feature-X", "hotfix"]);
    });

    test("matches job URLs regardless of trailing slash or case", async () => {
      await seedState(["feature-x"]);

      const history = await branchesModule.loadCachedBranchHistory({
        env,
        jobUrl: "https://JENKINS.example.com/job/api/",
      });
      expect(history).toEqual(["feature-x"]);
    });

    test("returns empty history for an unknown job", async () => {
      await seedState(["feature-x"]);

      const history = await branchesModule.loadCachedBranchHistory({
        env,
        jobUrl: "https://jenkins.example.com/job/unknown",
      });
      expect(history).toEqual([]);
    });
  });

  describe("recordBranchSelection", () => {
    test("moves the selected branch to the front and dedupes case-insensitively", async () => {
      await seedState(["Feature-X", "hotfix"]);

      await branchesModule.recordBranchSelection({
        env,
        jobUrl,
        branch: "feature-x",
      });

      expect(await readStoredBranches()).toEqual(["feature-x", "hotfix"]);
    });

    test("records history for a job with no state yet", async () => {
      await branchesModule.recordBranchSelection({
        env,
        jobUrl: `${jobUrl}/`,
        branch: " feature-x ",
      });

      expect(await readStoredBranches()).toEqual(["feature-x"]);
    });

    test("caps stored branches at 10 entries", async () => {
      await seedState(Array.from({ length: 10 }, (_, i) => `branch-${i}`));

      await branchesModule.recordBranchSelection({
        env,
        jobUrl,
        branch: "newest",
      });

      const stored = (await readStoredBranches()) as string[];
      expect(stored).toHaveLength(10);
      expect(stored[0]).toBe("newest");
      expect(stored).not.toContain("branch-9");
    });

    test("ignores blank branch names", async () => {
      const seeded = await seedState(["feature-x"]);

      await branchesModule.recordBranchSelection({
        env,
        jobUrl,
        branch: "   ",
      });

      expect(await Bun.file(statePath).text()).toBe(seeded);
    });

    test("skips the write when the branch is already first", async () => {
      const seeded = await seedState(["feature-x", "hotfix"]);

      await branchesModule.recordBranchSelection({
        env,
        jobUrl,
        branch: "feature-x",
      });

      expect(await Bun.file(statePath).text()).toBe(seeded);
    });
  });

  describe("removeCachedBranch", () => {
    test("removes a branch case-insensitively and persists the change", async () => {
      await seedState(["Feature-X", "hotfix"]);

      const removed = await branchesModule.removeCachedBranch({
        env,
        jobUrl,
        branch: "feature-x",
      });

      expect(removed).toBeTrue();
      expect(await readStoredBranches()).toEqual(["hotfix"]);
    });

    test("refuses to remove default branches", async () => {
      await seedState(["feature-x"]);

      const removed = await branchesModule.removeCachedBranch({
        env,
        jobUrl,
        branch: "master",
      });

      expect(removed).toBeFalse();
      expect(await readStoredBranches()).toEqual(["feature-x"]);
    });

    test("returns false and skips the write when the branch is not cached", async () => {
      const seeded = await seedState(["feature-x"]);

      const removed = await branchesModule.removeCachedBranch({
        env,
        jobUrl,
        branch: "missing",
      });

      expect(removed).toBeFalse();
      expect(await Bun.file(statePath).text()).toBe(seeded);
    });
  });
});
