import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli";
import { runCreate } from "../src/commands/create";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { CreateItemOptions } from "../src/types/jenkins";

const env = { jenkinsUrl: "https://jenkins.example.com" } as EnvConfig;

function clientWith(
  createItem: (options: CreateItemOptions) => Promise<string>,
): JenkinsClient {
  return { createItem } as unknown as JenkinsClient;
}

describe("create command", () => {
  let tempDir: string;

  beforeEach(() => {
    process.exitCode = 0;
    tempDir = mkdtempSync(join(tmpdir(), "jenkins-cli-create-"));
  });

  afterEach(() => {
    process.exitCode = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rejects when neither --config nor --copy-from is passed", async () => {
    await expect(
      runCreate({
        client: clientWith(async () => ""),
        env,
        name: "new-job",
        nonInteractive: true,
      }),
    ).rejects.toThrow("Provide exactly one of --config <file> or --copy-from");
  });

  test("rejects when both --config and --copy-from are passed", async () => {
    await expect(
      runCreate({
        client: clientWith(async () => ""),
        env,
        name: "new-job",
        configPath: "config.xml",
        copyFrom: "api",
        nonInteractive: true,
      }),
    ).rejects.toThrow("Provide exactly one of --config <file> or --copy-from");
  });

  test("rejects item names containing a slash", async () => {
    await expect(
      runCreate({
        client: clientWith(async () => ""),
        env,
        name: "team/new-job",
        configPath: "config.xml",
        nonInteractive: true,
      }),
    ).rejects.toThrow("Item names cannot contain '/'");
  });

  test("rejects a missing config file", async () => {
    await expect(
      runCreate({
        client: clientWith(async () => ""),
        env,
        name: "new-job",
        configPath: join(tempDir, "missing.xml"),
        nonInteractive: true,
      }),
    ).rejects.toThrow("Config file not found");
  });

  test("blocks creation on a read-only profile", async () => {
    await expect(
      runCreate({
        client: clientWith(async () => ""),
        env: { ...env, protectedProfileName: "prod" },
        name: "new-job",
        configPath: join(tempDir, "config.xml"),
        nonInteractive: true,
      }),
    ).rejects.toThrow('Profile "prod" is read-only.');
  });

  test("posts the config file and emits a JSON receipt", async () => {
    const configPath = join(tempDir, "config.xml");
    writeFileSync(configPath, "<project/>");
    const calls: CreateItemOptions[] = [];
    const chunks: string[] = [];

    await runCreate({
      client: clientWith(async (options) => {
        calls.push(options);
        return "https://jenkins.example.com/job/new-job/";
      }),
      env,
      name: "new-job",
      configPath,
      nonInteractive: true,
      json: true,
      write: (chunk) => chunks.push(chunk),
    });

    expect(calls).toEqual([{ name: "new-job", configXml: "<project/>" }]);
    expect(chunks.join("")).toBe(
      `${JSON.stringify({
        ok: true,
        command: "create",
        data: {
          name: "new-job",
          url: "https://jenkins.example.com/job/new-job/",
        },
      })}\n`,
    );
  });

  test("copies from a job URL using its root-anchored full name", async () => {
    const calls: CreateItemOptions[] = [];
    const chunks: string[] = [];

    await runCreate({
      client: clientWith(async (options) => {
        calls.push(options);
        return "https://jenkins.example.com/job/team/job/api-copy/";
      }),
      env,
      name: "api-copy",
      copyFrom: "https://jenkins.example.com/job/team/job/api/",
      folderUrl: "https://jenkins.example.com/job/team/",
      nonInteractive: true,
      json: true,
      write: (chunk) => chunks.push(chunk),
    });

    expect(calls).toEqual([
      {
        name: "api-copy",
        copyFrom: "/team/api",
        parentUrl: "https://jenkins.example.com/job/team",
      },
    ]);
    expect(chunks.join("")).toContain('"copiedFrom":"team/api"');
  });

  test("rejects a --copy-from URL on another controller", async () => {
    await expect(
      runCreate({
        client: clientWith(async () => ""),
        env,
        name: "api-copy",
        copyFrom: "https://other.example.com/job/api/",
        nonInteractive: true,
      }),
    ).rejects.toThrow(CliError);
  });
});
