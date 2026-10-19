import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJobConfig } from "../src/commands/job-config";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";

const env = { jenkinsUrl: "https://jenkins.example.com" } as EnvConfig;
const jobUrl = "https://jenkins.example.com/job/api";

type Update = { jobUrl: string; configXml: string };

function recordingClient(updates: Update[]): JenkinsClient {
  return {
    updateJobConfigXml: async (url: string, configXml: string) => {
      updates.push({ jobUrl: url, configXml });
    },
  } as unknown as JenkinsClient;
}

describe("config --apply", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    process.exitCode = 0;
    tempDir = mkdtempSync(join(tmpdir(), "jenkins-cli-config-"));
    configPath = join(tempDir, "config.xml");
    writeFileSync(configPath, "<flow-definition/>");
  });

  afterEach(() => {
    process.exitCode = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("posts the file to the job and emits a JSON receipt", async () => {
    const updates: Update[] = [];
    const chunks: string[] = [];

    await runJobConfig({
      client: recordingClient(updates),
      env,
      jobUrl,
      apply: configPath,
      nonInteractive: true,
      json: true,
      write: (chunk) => chunks.push(chunk),
    });

    expect(updates).toEqual([{ jobUrl, configXml: "<flow-definition/>" }]);
    expect(chunks.join("")).toBe(
      `${JSON.stringify({ ok: true, command: "config", data: { url: jobUrl } })}\n`,
    );
  });

  test("blocks the update on a read-only profile", async () => {
    const updates: Update[] = [];

    await expect(
      runJobConfig({
        client: recordingClient(updates),
        env: { ...env, protectedProfileName: "prod" },
        jobUrl,
        apply: configPath,
        nonInteractive: true,
      }),
    ).rejects.toThrow('Profile "prod" is read-only.');
    expect(updates).toEqual([]);
  });

  test("rejects an empty file before contacting Jenkins", async () => {
    writeFileSync(configPath, "  \n");
    const updates: Update[] = [];

    await expect(
      runJobConfig({
        client: recordingClient(updates),
        env,
        jobUrl,
        apply: configPath,
        nonInteractive: true,
      }),
    ).rejects.toThrow(`Config file ${configPath} is empty.`);
    expect(updates).toEqual([]);
  });

  test("reports an unreadable file as invalid usage", async () => {
    chmodSync(configPath, 0o000);
    const updates: Update[] = [];

    await expect(
      runJobConfig({
        client: recordingClient(updates),
        env,
        jobUrl,
        apply: configPath,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({
      message: `Cannot read config file ${configPath}.`,
      code: "INVALID_USAGE",
    });
    expect(updates).toEqual([]);
  });

  test("rejects --json without --apply", async () => {
    await expect(
      runJobConfig({
        client: recordingClient([]),
        env,
        jobUrl,
        nonInteractive: true,
        json: true,
      }),
    ).rejects.toThrow("--json only works with --apply");
  });
});
