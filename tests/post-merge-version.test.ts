import { expect, test } from "bun:test";
import {
  bumpPatchVersion,
  buildPostMergePlan,
  isCodeRelatedPath,
} from "../scripts/post-merge-version";

test("post-merge version helpers > recognizes code-related paths", () => {
  expect(isCodeRelatedPath("src/index.ts")).toBe(true);
  expect(isCodeRelatedPath("tests/list.test.ts")).toBe(true);
  expect(isCodeRelatedPath("docs/homebrew.md")).toBe(false);
});

test("post-merge version helpers > bumps patch version", () => {
  expect(bumpPatchVersion("0.7.13")).toBe("0.7.14");
});

test("post-merge version helpers > skips bump on forks or non-code changes", () => {
  const forkPlan = buildPostMergePlan({
    currentVersion: "0.7.13",
    isFork: true,
    versionChanged: false,
    codeRelatedChanged: true,
  });

  expect(forkPlan.shouldBump).toBe(false);
  expect(forkPlan.newVersion).toBe("0.7.13");
  expect(forkPlan.commitMessage).toBe("chore: lint and format");

  const docsPlan = buildPostMergePlan({
    currentVersion: "0.7.13",
    isFork: false,
    versionChanged: false,
    codeRelatedChanged: false,
  });

  expect(docsPlan.shouldBump).toBe(false);
  expect(docsPlan.newVersion).toBe("0.7.13");
  expect(docsPlan.prTitle).toBe("chore: lint and format");
});

test("post-merge version helpers > bumps version for code changes", () => {
  const plan = buildPostMergePlan({
    currentVersion: "0.7.13",
    isFork: false,
    versionChanged: false,
    codeRelatedChanged: true,
  });

  expect(plan.shouldBump).toBe(true);
  expect(plan.newVersion).toBe("0.7.14");
  expect(plan.commitMessage).toBe(
    "chore: bump version to 0.7.14, lint and format",
  );
  expect(plan.prBody).toContain("Bumped patch version to 0.7.14");
});
