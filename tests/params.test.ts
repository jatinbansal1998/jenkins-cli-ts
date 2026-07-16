import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CliError } from "../src/cli";
import { formatJobParametersTable, runParams } from "../src/commands/params";
import type { EnvConfig } from "../src/env";
import type { JenkinsClient } from "../src/jenkins/client";
import type { JobParameterDefinition } from "../src/types/jenkins";

const env = { jenkinsUrl: "https://jenkins.example.com" } as EnvConfig;
const jobUrl = "https://jenkins.example.com/job/team/job/api/";
const definitions: JobParameterDefinition[] = [
  {
    name: "DEPLOY_ENV",
    type: "choice",
    description: "Target environment",
    defaultValue: "staging",
    choices: ["dev", "staging", "prod"],
    sensitive: false,
    jenkinsClass: "hudson.model.ChoiceParameterDefinition",
  },
  {
    name: "TOKEN",
    type: "password",
    description: "Deployment token",
    sensitive: true,
    jenkinsClass: "hudson.model.PasswordParameterDefinition",
  },
];

function clientWith(
  getJobParameterDefinitions: () => Promise<JobParameterDefinition[]>,
): JenkinsClient {
  return { getJobParameterDefinitions } as unknown as JenkinsClient;
}

describe("params command", () => {
  beforeEach(() => {
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  test("formats human-readable parameter metadata", () => {
    const output = formatJobParametersTable(definitions);
    expect(output).toContain("NAME");
    expect(output).toContain("DEPLOY_ENV");
    expect(output).toContain("staging");
    expect(output).toContain("dev, staging, prod");
    expect(output).toContain("Target environment");
    const tokenLine = output.split("\n").find((line) => line.includes("TOKEN"));
    expect(tokenLine).not.toContain("redacted");
  });

  test("emits exact JSON and omits sensitive defaults and Jenkins classes", async () => {
    const chunks: string[] = [];
    await runParams({
      client: clientWith(async () => definitions),
      env,
      jobUrl,
      nonInteractive: true,
      json: true,
      write: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join("")).toBe(
      `${JSON.stringify({
        ok: true,
        command: "params",
        data: [
          {
            name: "DEPLOY_ENV",
            type: "choice",
            description: "Target environment",
            defaultValue: "staging",
            choices: ["dev", "staging", "prod"],
            sensitive: false,
          },
          {
            name: "TOKEN",
            type: "password",
            description: "Deployment token",
            sensitive: true,
          },
        ],
      })}\n`,
    );
  });

  test("emits one JSON error envelope without human stdout", async () => {
    const chunks: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    await runParams({
      client: clientWith(async () => {
        throw new CliError("Not allowed.", [], "DENIED");
      }),
      env,
      jobUrl,
      nonInteractive: true,
      json: true,
      write: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0] as string)).toEqual({
      ok: false,
      error: { message: "Not allowed.", code: "DENIED" },
    });
    expect(logSpy).not.toHaveBeenCalled();
    process.exitCode = 0;
    logSpy.mockRestore();
  });
});
