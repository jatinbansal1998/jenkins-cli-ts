import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import fs from "node:fs";
import type { EnvConfig } from "../src/env";
import { getJobCachePath } from "../src/jobs";

const realFsPromises = await import("node:fs/promises");

// Import fresh per test (cache-busting) so rerun-core.test.ts's
// mock.module("../src/branches", ...) does not leak its stubs into this file.
let branchesModule = await loadFreshBranchesModule();

async function loadFreshBranchesModule(): Promise<
  typeof import("../src/branches")
> {
  return import(`../src/branches?branches-test=${crypto.randomUUID()}`);
}

const files = new Map<string, string>();

const mkdirMock = mock(fs.promises.mkdir);
const renameMock = mock(fs.promises.rename);
const rmMock = mock(fs.promises.rm);

mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  mkdir: mkdirMock,
  rename: renameMock,
  rm: rmMock,
}));

const env: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "ci-user",
  jenkinsApiToken: "test-token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 3,
};

const jobUrl = "https://jenkins.example.com/job/api";
const cachePath = getJobCachePath(env.jenkinsUrl);

function seedCache(options: {
  branches?: unknown[];
  user?: string;
  jobs?: Array<{ name: string; url: string; branches?: unknown[] }>;
}): void {
  const jobs = options.jobs ?? [
    { name: "api", url: jobUrl, branches: options.branches },
  ];
  files.set(
    cachePath,
    JSON.stringify({
      jenkinsUrl: env.jenkinsUrl,
      user: options.user ?? env.jenkinsUser,
      fetchedAt: "2026-07-01T00:00:00.000Z",
      jobs,
    }),
  );
}

function readSeededBranches(): unknown {
  const raw = files.get(cachePath);
  if (!raw) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as {
    jobs: Array<{ url: string; branches?: string[] }>;
  };
  return parsed.jobs.find((job) => job.url === jobUrl)?.branches;
}

let bunFileSpy = spyOn(Bun, "file");

describe("branch selection cache", () => {
  beforeEach(async () => {
    branchesModule = await loadFreshBranchesModule();
    files.clear();
    bunFileSpy = spyOn(Bun, "file");
    bunFileSpy.mockImplementation(((filePath: string | URL) => {
      const resolvedPath =
        typeof filePath === "string" ? filePath : filePath.toString();
      return {
        text: async () => {
          const value = files.get(resolvedPath);
          if (value !== undefined) {
            return value;
          }
          throw createErrno("ENOENT");
        },
        write: async (data: string) => {
          files.set(resolvedPath, data);
          return data.length;
        },
      } as Bun.BunFile;
    }) as typeof Bun.file);

    mkdirMock.mockImplementation(async () => undefined);
    renameMock.mockImplementation(async (fromPath, toPath) => {
      const from = String(fromPath);
      const to = String(toPath);
      const value = files.get(from);
      if (value === undefined) {
        throw createErrno("ENOENT");
      }
      files.set(to, value);
      files.delete(from);
    });
    rmMock.mockImplementation(async (filePath) => {
      files.delete(String(filePath));
    });
  });

  afterEach(() => {
    // Restore the spy so subsequent test files get the real Bun.file back.
    bunFileSpy.mockRestore();
    // Reset leaked module mocks back to the real fs so later test files that
    // import node:fs/promises do not inherit our in-memory cache shim.
    mkdirMock.mockImplementation(fs.promises.mkdir);
    renameMock.mockImplementation(fs.promises.rename);
    rmMock.mockImplementation(fs.promises.rm);
    files.clear();
  });

  describe("loadCachedBranches", () => {
    test("prepends cached history to the default branches without duplicates", async () => {
      seedCache({ branches: ["feature-x", "Staging", "hotfix-1"] });

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

    test("ignores a cache written for another user", async () => {
      seedCache({ branches: ["feature-x"], user: "someone-else" });

      const branches = await branchesModule.loadCachedBranches({ env, jobUrl });
      expect(branches).toEqual(["development", "staging", "master"]);
    });
  });

  describe("loadCachedBranchHistory", () => {
    test("filters defaults and blanks, dedupes case-insensitively", async () => {
      seedCache({
        branches: ["Feature-X", " feature-x ", "", "   ", "master", "hotfix"],
      });

      const history = await branchesModule.loadCachedBranchHistory({
        env,
        jobUrl,
      });
      expect(history).toEqual(["Feature-X", "hotfix"]);
    });

    test("matches job URLs regardless of trailing slash", async () => {
      seedCache({ branches: ["feature-x"] });

      const history = await branchesModule.loadCachedBranchHistory({
        env,
        jobUrl: `${jobUrl}/`,
      });
      expect(history).toEqual(["feature-x"]);
    });

    test("returns empty history for an unknown job", async () => {
      seedCache({ branches: ["feature-x"] });

      const history = await branchesModule.loadCachedBranchHistory({
        env,
        jobUrl: "https://jenkins.example.com/job/unknown",
      });
      expect(history).toEqual([]);
    });
  });

  describe("recordBranchSelection", () => {
    test("moves the selected branch to the front and dedupes case-insensitively", async () => {
      seedCache({ branches: ["Feature-X", "hotfix"] });

      await branchesModule.recordBranchSelection({
        env,
        jobUrl,
        branch: "feature-x",
      });

      expect(readSeededBranches()).toEqual(["feature-x", "hotfix"]);
    });

    test("caps stored branches at 10 entries", async () => {
      const existing = Array.from({ length: 10 }, (_, i) => `branch-${i}`);
      seedCache({ branches: existing });

      await branchesModule.recordBranchSelection({
        env,
        jobUrl,
        branch: "newest",
      });

      const stored = readSeededBranches() as string[];
      expect(stored).toHaveLength(10);
      expect(stored[0]).toBe("newest");
      expect(stored).not.toContain("branch-9");
    });

    test("ignores blank branch names", async () => {
      seedCache({ branches: ["feature-x"] });
      const before = files.get(cachePath);

      await branchesModule.recordBranchSelection({
        env,
        jobUrl,
        branch: "   ",
      });

      expect(files.get(cachePath)).toBe(before);
    });

    test("does not write when the cache belongs to another Jenkins user", async () => {
      seedCache({ branches: ["feature-x"], user: "someone-else" });
      const before = files.get(cachePath);

      await branchesModule.recordBranchSelection({
        env,
        jobUrl,
        branch: "new-branch",
      });

      expect(files.get(cachePath)).toBe(before);
    });

    test("is a no-op for a job that is not in the cache", async () => {
      seedCache({ branches: ["feature-x"] });
      const before = files.get(cachePath);

      await branchesModule.recordBranchSelection({
        env,
        jobUrl: "https://jenkins.example.com/job/unknown",
        branch: "new-branch",
      });

      expect(files.get(cachePath)).toBe(before);
    });
  });

  describe("removeCachedBranch", () => {
    test("removes a branch case-insensitively and persists the change", async () => {
      seedCache({ branches: ["Feature-X", "hotfix"] });

      const removed = await branchesModule.removeCachedBranch({
        env,
        jobUrl,
        branch: "feature-x",
      });

      expect(removed).toBeTrue();
      expect(readSeededBranches()).toEqual(["hotfix"]);
    });

    test("refuses to remove default branches", async () => {
      seedCache({ branches: ["feature-x"] });

      const removed = await branchesModule.removeCachedBranch({
        env,
        jobUrl,
        branch: "master",
      });

      expect(removed).toBeFalse();
      expect(readSeededBranches()).toEqual(["feature-x"]);
    });

    test("returns false when the branch is not cached", async () => {
      seedCache({ branches: ["feature-x"] });

      const removed = await branchesModule.removeCachedBranch({
        env,
        jobUrl,
        branch: "missing",
      });

      expect(removed).toBeFalse();
    });
  });
});

function createErrno(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
