import { describe, expect, test } from "bun:test";
import path from "node:path";
import { CliError } from "../src/cli";
import {
  compareVersions,
  normalizeVersionTag,
  resolveAssetUrl,
  resolveExecutablePath,
} from "../src/update";

describe("update version helpers", () => {
  test("normalizeVersionTag adds v prefix", () => {
    expect(normalizeVersionTag("0.2.4")).toBe("v0.2.4");
  });

  test("normalizeVersionTag keeps v prefix", () => {
    expect(normalizeVersionTag("v0.2.4")).toBe("v0.2.4");
  });

  test("compareVersions detects newer version", () => {
    expect(compareVersions("v0.2.4", "0.2.3")).toBe(1);
  });

  test("compareVersions detects older version", () => {
    expect(compareVersions("0.2.3", "v0.2.4")).toBe(-1);
  });

  test("compareVersions detects equal versions", () => {
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  test("compareVersions returns null for invalid version", () => {
    expect(compareVersions("v1.0.0", "latest")).toBeNull();
  });
});

describe("update helpers", () => {
  test("resolveAssetUrl returns the jenkins-cli asset", () => {
    const url = resolveAssetUrl({
      tag_name: "v1.2.3",
      assets: [
        {
          name: "jenkins-cli",
          browser_download_url: "https://example.com/jenkins-cli",
        },
      ],
    });
    expect(url).toBe("https://example.com/jenkins-cli");
  });

  test("resolveAssetUrl throws if asset is missing", () => {
    expect(() => resolveAssetUrl({ tag_name: "v1.2.3", assets: [] })).toThrow(
      CliError,
    );
  });

  test("resolveExecutablePath throws for source runs", () => {
    const prevArgv = process.argv[1];
    process.argv[1] = "/tmp/src/index.ts";
    try {
      expect(() => resolveExecutablePath()).toThrow(CliError);
    } finally {
      process.argv[1] = prevArgv;
    }
  });

  test("resolveExecutablePath returns resolved path for binaries", () => {
    const prevArgv = process.argv[1];
    process.argv[1] = "/tmp/jenkins-cli";
    try {
      expect(resolveExecutablePath()).toBe(path.resolve("/tmp/jenkins-cli"));
    } finally {
      process.argv[1] = prevArgv;
    }
  });
});
