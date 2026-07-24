import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  integrationEnabled,
  invokeCliExecutable,
  jenkinsUrl,
  withCliHome,
} from "./jenkins/harness";

type ProbeResult = {
  scenario: string;
  status: number;
  xError: string | null;
  contentType: string | null;
  body: string;
};

const user = process.env.JENKINS_INTEGRATION_USER ?? "";
const token = process.env.JENKINS_INTEGRATION_TOKEN ?? "";
const authorization = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

describe.skipIf(!integrationEnabled)(
  "Jenkins build rejection reproduction",
  () => {
    test("captures raw responses and verifies compiled CLI messages", async () => {
      const jobUrl = `${jenkinsUrl}/job/demo-app-deploy`;
      const probes: ProbeResult[] = [];

      probes.push(
        await postForm(
          "existing branch",
          `${jobUrl}/buildWithParameters`,
          new URLSearchParams({ BRANCH_TAG: "main", Test: "false" }),
        ),
      );
      probes.push(
        await postForm(
          "nonexistent branch",
          `${jobUrl}/buildWithParameters`,
          new URLSearchParams({
            BRANCH_TAG: "no-such-branch",
            Test: "false",
          }),
        ),
      );
      probes.push(
        await postForm(
          "unknown parameter sent to a parameterized job",
          `${jenkinsUrl}/job/cli-smoke/buildWithParameters`,
          new URLSearchParams({ BRANCH_TAG: "main" }),
        ),
      );
      probes.push(
        await postForm(
          "unknown job",
          `${jenkinsUrl}/job/no-such-job/buildWithParameters`,
          new URLSearchParams({ BRANCH_TAG: "main" }),
        ),
      );

      const enabledScenarios = [
        {
          name: "existing branch",
          args: [
            "build",
            "--job-url",
            `${jobUrl}/`,
            "--param",
            "BRANCH_TAG=main",
            "--param",
            "Test=false",
          ],
          exitCode: 0,
          output: "Build ",
        },
        {
          name: "invalid branch",
          args: [
            "build",
            "--job-url",
            `${jobUrl}/`,
            "--param",
            "BRANCH_TAG=no-such-branch",
            "--param",
            "Test=false",
          ],
          exitCode: 1,
          output:
            "Jenkins returned HTTP 400 while trying to trigger build: Parameter BRANCH_TAG provided value 'no-such-branch' is invalid",
        },
        {
          name: "unknown parameter on a parameterized job",
          args: [
            "build",
            "--job-url",
            `${jenkinsUrl}/job/cli-smoke/`,
            "--param",
            "BRANCH_TAG=main",
          ],
          exitCode: 0,
          output: "Build ",
        },
        {
          name: "unknown job",
          args: [
            "build",
            "--job-url",
            `${jenkinsUrl}/job/no-such-job/`,
            "--without-params",
          ],
          exitCode: 1,
          output: "Jenkins returned HTTP 404 while trying to trigger build:",
        },
      ];
      const baselineExecutable =
        process.env.JENKINS_INTEGRATION_BEFORE_CLI?.trim();
      const currentExecutable = resolve(
        "dist",
        process.platform === "win32" ? "jenkins-cli.exe" : "jenkins-cli",
      );

      await withCliHome(async (home) => {
        for (const scenario of enabledScenarios) {
          await runCliComparison(
            home,
            scenario,
            baselineExecutable,
            currentExecutable,
          );
        }
      });

      await post("disable synthetic job", `${jobUrl}/disable`);
      try {
        probes.push(
          await postForm(
            "disabled job",
            `${jobUrl}/buildWithParameters`,
            new URLSearchParams({
              BRANCH_TAG: "main",
              Test: "false",
            }),
          ),
        );

        printProbeResults(probes);
        expect(probes[0]?.status).toBe(201);
        expect(probes[1]).toMatchObject({
          status: 400,
          xError:
            "Parameter BRANCH_TAG provided value 'no-such-branch' is invalid",
        });
        expect(probes[2]?.status).toBe(201);
        expect(probes[3]?.status).toBe(404);
        expect(probes[4]?.status).toBe(409);

        await withCliHome((home) =>
          runCliComparison(
            home,
            {
              name: "disabled job",
              args: [
                "build",
                "--job-url",
                `${jobUrl}/`,
                "--param",
                "BRANCH_TAG=main",
                "--param",
                "Test=false",
              ],
              exitCode: 1,
              output:
                "Jenkins returned HTTP 409 while trying to trigger build: demo-app-deploy is not buildable",
            },
            baselineExecutable,
            currentExecutable,
          ),
        );
      } finally {
        await post("enable synthetic job", `${jobUrl}/enable`);
      }
    }, 120_000);
  },
);

async function runCliComparison(
  home: string,
  scenario: {
    name: string;
    args: string[];
    exitCode: number;
    output: string;
  },
  baselineExecutable: string | undefined,
  currentExecutable: string,
): Promise<void> {
  if (baselineExecutable) {
    const baseline = await invokeCliExecutable(
      home,
      baselineExecutable,
      scenario.args,
    );
    console.log(
      `\nBEFORE — ${scenario.name} (exit ${baseline.exitCode})\n${baseline.output.trim()}`,
    );
  }
  const current = await invokeCliExecutable(
    home,
    currentExecutable,
    scenario.args,
  );
  console.log(
    `\nAFTER — ${scenario.name} (exit ${current.exitCode})\n${current.output.trim()}`,
  );
  expect(current.exitCode).toBe(scenario.exitCode);
  expect(current.output).toContain(scenario.output);
}

async function postForm(
  scenario: string,
  url: string,
  body: URLSearchParams,
): Promise<ProbeResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    redirect: "manual",
  });
  return {
    scenario,
    status: response.status,
    xError: response.headers.get("x-error"),
    contentType: response.headers.get("content-type"),
    body: normalizeBody(await response.text()),
  };
}

async function post(scenario: string, url: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: authorization },
    redirect: "manual",
  });
  expect(
    response.ok || (response.status >= 300 && response.status < 400),
    `${scenario}: HTTP ${response.status}`,
  ).toBeTrue();
}

function normalizeBody(body: string): string {
  return body
    .replace(/<style>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function printProbeResults(probes: ProbeResult[]): void {
  console.log("\nRAW JENKINS BUILD RESPONSE FINDINGS");
  for (const probe of probes) {
    console.log(
      [
        `\n${probe.scenario}: HTTP ${probe.status}`,
        `x-error: ${probe.xError ?? "<absent>"}`,
        `content-type: ${probe.contentType ?? "<absent>"}`,
        `body: ${probe.body || "<empty>"}`,
      ].join("\n"),
    );
  }
}
