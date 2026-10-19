import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { splitLogLines } from "../../src/log-filters";
import { JENKINS_READ_LIMIT } from "../../src/map-with-limit";
import {
  cliLogFiles,
  findJobCachePath,
  integrationEnabled,
  integrationRuntimeDir,
  invokeCli,
  invokeCliAndInterrupt,
  jenkinsUrl,
  parseJson,
  pollCli,
  runCli,
  runCliExpectFailure,
  observeInteractiveCli,
  waitForNewBuild,
  withCliHome,
} from "./jenkins/harness";

const keychainIntegrationRequired =
  process.env.REQUIRE_KEYCHAIN_INTEGRATION === "1";

/** GET URLs the CLI recorded in its `--debug` API log, in request order. */
async function apiRequestUrls(home: string): Promise<string[]> {
  const logs = await Promise.all(
    cliLogFiles(home, "api").map((file) => Bun.file(file).text()),
  );
  return logs
    .join("\n")
    .split("\n")
    .flatMap((line) => line.match(/ REQUEST GET (\S+)$/)?.[1] ?? []);
}

/** How many times each value occurs. */
function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** Run git with a fixed synthetic identity; fails loudly on a non-zero exit. */
async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: [
      "git",
      "-c",
      "user.name=Jenkins CLI Integration",
      "-c",
      "user.email=integration@example.invalid",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

describe.skipIf(!integrationEnabled)(
  "compiled CLI against real Jenkins profiles, Pipelines, SCM and logs",
  () => {
    test("persists and switches multiple live Jenkins profiles", async () => {
      await withCliHome(async (home) => {
        const withoutCredentialEnv = {
          JENKINS_URL: undefined,
          JENKINS_USER: undefined,
          JENKINS_API_TOKEN: undefined,
          JENKINS_BRANCH_PARAM: undefined,
        };
        const adminToken = process.env.JENKINS_INTEGRATION_TOKEN ?? "";
        const readerUser =
          process.env.JENKINS_INTEGRATION_READER_USER ?? "integration-reader";
        const readerToken = process.env.JENKINS_INTEGRATION_READER_TOKEN ?? "";

        const adminLogin = await runCli(
          home,
          [
            "auth",
            "login",
            "--profile",
            "admin",
            "--url",
            jenkinsUrl!,
            "--user",
            "integration-test",
            "--token",
            adminToken,
            "--no-keychain",
          ],
          withoutCredentialEnv,
        );
        expect(adminLogin.output).not.toContain(adminToken);
        expect(adminLogin.output).not.toContain("export");

        const readerLogin = await runCli(
          home,
          [
            "auth",
            "login",
            "--profile",
            "reader",
            "--url",
            jenkinsUrl!,
            "--user",
            readerUser,
            "--token",
            readerToken,
            "--no-keychain",
          ],
          withoutCredentialEnv,
        );
        expect(readerLogin.output).not.toContain(readerToken);
        expect(readerLogin.output).not.toContain("export");

        const profiles = await runCli(
          home,
          ["auth", "list"],
          withoutCredentialEnv,
        );
        expect(profiles.output).toContain("admin (default)");
        expect(profiles.output).toContain("reader");
        expect(profiles.output).toContain("plaintext");

        const readerStatus = await runCli(
          home,
          ["auth", "status", "--profile", "reader"],
          withoutCredentialEnv,
        );
        expect(readerStatus.output).toContain("Authenticated:    Yes");
        expect(readerStatus.output).toContain(
          "Jenkins user:     integration-reader",
        );
        const readerList = parseJson<{
          data: Array<{ name: string }>;
        }>(
          await runCli(
            home,
            ["list", "--refresh", "--json", "--profile", "reader"],
            withoutCredentialEnv,
          ),
        );
        expect(readerList.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "cli-smoke" }),
          ]),
        );
        const denied = await runCliExpectFailure(
          home,
          [
            "build",
            "--job",
            "cli-no-params",
            "--without-params",
            "--profile",
            "reader",
          ],
          withoutCredentialEnv,
        );
        expect(denied.output).toContain(
          "Jenkins returned HTTP 403 while trying to trigger build:",
        );
        expect(denied.output).not.toContain(readerToken);
        const errorLog = (
          await Promise.all(
            cliLogFiles(home, "error").map((file) => Bun.file(file).text()),
          )
        ).join("\n");
        expect(errorLog).toContain(
          "CliError: Jenkins returned HTTP 403 while trying to trigger build:",
        );
        expect(errorLog).toMatch(/\s+at .+:\d+:\d+/);
        expect(errorLog).not.toContain(readerToken);

        await runCli(home, ["auth", "use", "reader"], withoutCredentialEnv);
        expect(
          (await runCli(home, ["auth", "current"], withoutCredentialEnv))
            .output,
        ).toContain("Profile:          reader");
        await runCli(
          home,
          ["auth", "rename", "reader", "observer"],
          withoutCredentialEnv,
        );
        const renamed = await runCli(
          home,
          ["auth", "status", "--profile", "observer"],
          withoutCredentialEnv,
        );
        expect(renamed.output).toContain("Authenticated:    Yes");

        await runCli(home, ["auth", "use", "admin"], withoutCredentialEnv);
        const adminStatus = await runCli(
          home,
          ["auth", "status"],
          withoutCredentialEnv,
        );
        expect(adminStatus.output).toContain(
          "Jenkins user:     integration-test",
        );
      });
    }, 60_000);

    test.skipIf(!keychainIntegrationRequired || process.platform === "win32")(
      "stores and resolves a real Jenkins token through the OS keychain",
      async () => {
        await withCliHome(async (home) => {
          const profile = "default";
          const token = process.env.JENKINS_INTEGRATION_TOKEN ?? "";
          expect(token).not.toBe("");
          const withoutCredentialEnv = {
            JENKINS_URL: undefined,
            JENKINS_USER: undefined,
            JENKINS_API_TOKEN: undefined,
            TS_KEYRING_BACKEND: undefined,
          };
          const login = await runCli(
            home,
            [
              "auth",
              "login",
              "--profile",
              profile,
              "--url",
              jenkinsUrl ?? "",
              "--user",
              "integration-test",
              "--token",
              token,
            ],
            withoutCredentialEnv,
          );
          expect(login.exitCode, login.output).toBe(0);
          expect(login.output).toContain(`Saved profile "${profile}"`);
          expect(login.output).toContain("API token stored securely");
          expect(login.output).not.toContain(token);

          const config = (await Bun.file(
            join(home, ".config", "jenkins-cli", "jenkins-cli-config.json"),
          ).json()) as {
            profiles: Record<
              string,
              { jenkinsApiToken: string; tokenStorage?: string }
            >;
          };
          expect(config.profiles[profile]).toMatchObject({
            jenkinsApiToken: "@keychain",
            tokenStorage: "keychain",
          });

          const status = await runCli(
            home,
            ["auth", "status", "--profile", profile],
            withoutCredentialEnv,
          );
          expect(status.output).toContain("Authenticated:    Yes");
          expect(status.output).toContain("Jenkins user:     integration-test");
          expect(status.output).not.toContain(token);

          const jobs = parseJson<{ data: Array<{ name: string }> }>(
            await runCli(
              home,
              ["list", "--refresh", "--json", "--profile", profile],
              withoutCredentialEnv,
            ),
          );
          expect(jobs.data).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: "cli-smoke" }),
            ]),
          );

          // The null backend holds no token, so these runs prove which
          // commands read the keychain: a fresh-cache list must not.
          const withoutKeychain = {
            ...withoutCredentialEnv,
            TS_KEYRING_BACKEND: "null",
          };
          const cachedJobs = parseJson<{ data: Array<{ name: string }> }>(
            await runCli(
              home,
              ["list", "--json", "--profile", profile],
              withoutKeychain,
            ),
          );
          expect(cachedJobs.data.map((job) => job.name)).toEqual(
            jobs.data.map((job) => job.name),
          );
          const refresh = await runCliExpectFailure(
            home,
            ["list", "--refresh", "--profile", profile],
            withoutKeychain,
          );
          expect(refresh.output).toContain("No Jenkins API token found");

          await runCli(
            home,
            ["auth", "logout", "--profile", profile],
            withoutCredentialEnv,
          );
        });
      },
      90_000,
    );

    test("discovers multibranch branch jobs as repo/branch and builds one by name", async () => {
      await withCliHome(async (home) => {
        // Branch indexing runs asynchronously after controller startup.
        const listed = await pollCli(
          home,
          ["list", "--refresh", "--json"],
          (result) =>
            result.stdout.includes('"demo-app-multibranch/main"') &&
            result.stdout.includes('"demo-app-multibranch/feature-alpha"'),
          60_000,
        );
        const list = parseJson<{
          data: Array<{ name: string; fullName?: string; url: string }>;
        }>(listed);
        expect(list.data).toEqual(
          expect.arrayContaining([
            {
              name: "main",
              fullName: "demo-app-multibranch/main",
              url: `${jenkinsUrl}/job/demo-app-multibranch/job/main/`,
              disabled: false,
              lastBuild: null,
            },
            expect.objectContaining({
              name: "feature-alpha",
              fullName: "demo-app-multibranch/feature-alpha",
            }),
          ]),
        );
        expect(list.data.map((job) => job.name)).not.toContain(
          "demo-app-multibranch",
        );

        const built = await runCli(home, [
          "build",
          "--job",
          "demo-app-multibranch/main",
          "--without-params",
          "--watch",
        ]);
        expect(built.output).toContain("SUCCESS");
      });
    }, 120_000);

    test("discovers nested jobs and preserves branch parameters through reruns", async () => {
      await withCliHome(async (home) => {
        const list = parseJson<{
          data: Array<{ name: string; fullName?: string; url: string }>;
        }>(
          await runCli(home, [
            "list",
            "--refresh",
            "--json",
            "--folder-depth",
            "2",
          ]),
        );
        expect(list.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "nested smoke",
              fullName: "team/nested smoke",
            }),
          ]),
        );

        const nested = await runCli(home, [
          "build",
          "--job",
          "team/nested smoke",
          "--without-params",
          "--watch",
          "--folder-depth",
          "2",
        ]);
        expect(nested.output).toContain("SUCCESS");

        const branch = `feature/integration-${Date.now()}`;
        const branchBuild = await runCliExpectFailure(home, [
          "build",
          "--job",
          "cli-branch",
          "--branch",
          branch,
          "--param",
          "EXTRA=preserved",
          "--watch",
          "--folder-depth",
          "2",
        ]);
        expect(branchBuild.output).toContain("FAILURE");

        const branchJobUrl = `${jenkinsUrl}/job/cli-branch/`;
        const history = parseJson<{
          data: Array<{
            number: number;
            branch?: string;
            parameters?: Array<{ name: string; value: string }>;
          }>;
        }>(
          await runCli(home, ["history", "--job-url", branchJobUrl, "--json"]),
        );
        expect(history.data[0]?.branch).toBe(branch);
        expect(history.data[0]?.parameters).toEqual(
          expect.arrayContaining([
            { name: "BRANCH", value: branch },
            { name: "EXTRA", value: "preserved" },
          ]),
        );

        const beforeRerunNumber = history.data[0]?.number ?? 0;
        await runCli(home, ["rerun", "--job-url", branchJobUrl]);
        const rerunBuildUrl = await waitForNewBuild(
          home,
          branchJobUrl,
          beforeRerunNumber,
        );
        await runCliExpectFailure(home, [
          "wait",
          "--build-url",
          rerunBuildUrl,
          "--interval",
          "250ms",
          "--timeout",
          "30s",
        ]);
        const rerunLogs = await runCli(home, [
          "logs",
          "--build-url",
          rerunBuildUrl,
          "--no-follow",
        ]);
        expect(rerunLogs.output).toContain(`branch=${branch}`);
        expect(rerunLogs.output).toContain("extra=preserved");
      });
    }, 120_000);

    test("reports job activity metadata in listings and filters with --active-only", async () => {
      type ListedJob = {
        name: string;
        fullName?: string;
        url: string;
        disabled?: boolean;
        lastBuild?: {
          number: number;
          url: string;
          result?: string | null;
          building?: boolean;
          timestampMs?: number;
          durationMs?: number;
          estimatedDurationMs?: number;
        } | null;
      };

      await withCliHome(async (home) => {
        const listJobs = async (
          args: string[],
        ): Promise<Map<string, ListedJob>> => {
          const listed = parseJson<{ data: ListedJob[] }>(
            await runCli(home, ["list", ...args, "--json"]),
          );
          return new Map(
            listed.data.map((job) => [job.fullName ?? job.name, job]),
          );
        };

        const discovered = await listJobs(["--refresh"]);
        const nestedJobUrl = discovered.get("team/nested smoke")?.url;
        expect(nestedJobUrl).toBeString();

        for (const jobUrl of [
          `${jenkinsUrl}/job/cli-activity/`,
          String(nestedJobUrl),
        ]) {
          await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--without-params",
            "--watch",
          ]);
        }

        const jobs = await listJobs(["--refresh"]);

        const built = jobs.get("cli-activity");
        expect(built?.disabled).toBe(false);
        expect(built?.lastBuild).toMatchObject({
          result: "SUCCESS",
          building: false,
        });
        expect(built?.lastBuild?.number).toBeGreaterThan(0);
        expect(built?.lastBuild?.url).toContain("/job/cli-activity/");
        expect(built?.lastBuild?.timestampMs).toBeNumber();
        expect(built?.lastBuild?.durationMs).toBeNumber();

        const nested = jobs.get("team/nested smoke");
        expect(nested?.name).toBe("nested smoke");
        expect(nested?.disabled).toBe(false);
        expect(nested?.lastBuild?.number).toBeGreaterThan(0);

        expect(jobs.get("cli-pipeline-disabled")).toMatchObject({
          name: "cli-pipeline-disabled",
          disabled: true,
          lastBuild: null,
        });
        expect(jobs.get("cli-never-built")).toMatchObject({
          name: "cli-never-built",
          disabled: false,
          lastBuild: null,
        });

        const active = await listJobs(["--active-only"]);
        expect(active.has("cli-activity")).toBe(true);
        expect(active.has("team/nested smoke")).toBe(true);
        expect(active.has("cli-pipeline-disabled")).toBe(false);
        expect(active.has("cli-never-built")).toBe(false);

        const plain = await runCli(home, ["list"]);
        expect(plain.output).toContain("cli-pipeline-disabled [disabled]");
        expect(plain.output).toContain(
          `cli-activity  ${jenkinsUrl}/job/cli-activity`,
        );
        expect(plain.output).not.toContain("cli-never-built [disabled]");
      });
    }, 180_000);

    test("reports real Pipeline stages and failure details", async () => {
      await withCliHome(async (home) => {
        const pipelineUrl = `${jenkinsUrl}/job/cli-pipeline/`;
        const built = await runCli(home, [
          "build",
          "--job-url",
          pipelineUrl,
          "--branch",
          "release/integration",
          "--watch",
        ]);
        expect(built.output).toContain("SUCCESS");

        const status = parseJson<{
          data: {
            build: {
              branch: string;
              durationMs: number;
              overheadMs: number;
              stages: Array<{
                name: string;
                status: string;
                durationMs: number;
              }>;
            };
          };
        }>(await runCli(home, ["status", "--job-url", pipelineUrl, "--json"]));
        expect(status.data.build.branch).toBe("release/integration");
        expect(status.data.build.stages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "Prepare", status: "SUCCESS" }),
            expect.objectContaining({ name: "Verify", status: "SUCCESS" }),
          ]),
        );
        const stageDurationMs = status.data.build.stages.reduce(
          (total, stage) => total + stage.durationMs,
          0,
        );
        expect(status.data.build.overheadMs).toBe(
          Math.max(0, status.data.build.durationMs - stageDurationMs),
        );

        const failureUrl = `${jenkinsUrl}/job/cli-pipeline-failure/`;
        const failed = await runCliExpectFailure(home, [
          "build",
          "--job-url",
          failureUrl,
          "--without-params",
          "--watch",
        ]);
        expect(failed.output).toContain("FAILURE");
        const failedStatus = parseJson<{
          data: {
            build: {
              stages: Array<{ name: string; status: string }>;
            };
          };
        }>(await runCli(home, ["status", "--job-url", failureUrl, "--json"]));
        expect(failedStatus.data.build.stages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "Deploy", status: "FAILED" }),
          ]),
        );
        const history = await runCli(home, [
          "history",
          "--job-url",
          failureUrl,
        ]);
        expect(history.output).toContain("pipeline-deploy-failure");
      });
    }, 120_000);

    test("keeps recent jobs, branches, and stage totals out of the job list", async () => {
      await withCliHome(async (home) => {
        await runCli(home, ["list", "--refresh", "--json"]);
        const cachePath = await findJobCachePath(home);
        const jobList = await Bun.file(cachePath).text();
        expect(jobList).not.toContain("\n");

        const pipelineUrl = `${jenkinsUrl}/job/cli-pipeline`;
        const built = await runCli(home, [
          "build",
          "--job-url",
          `${pipelineUrl}/`,
          "--branch",
          "release/integration",
          "--watch",
        ]);
        expect(built.output).toContain("SUCCESS");

        // Parallel commands must not drop each other's recent-job updates.
        const statusJobUrls = [
          "cli-smoke",
          "cli-failure",
          "cli-pipeline-failure",
          "cli-pipeline",
        ].map((name) => `${jenkinsUrl}/job/${name}`);
        await Promise.all(
          statusJobUrls.map((jobUrl) =>
            runCli(home, ["status", "--job-url", `${jobUrl}/`, "--json"]),
          ),
        );

        expect(await Bun.file(cachePath).text()).toBe(jobList);
        const state = JSON.parse(
          await Bun.file(await findJobStatePath(home)).text(),
        ) as {
          recentJobs: string[];
          branches: Record<string, string[]>;
          knownStageTotals: Record<string, { totalStages: number }>;
        };
        expect(state.recentJobs).toEqual(expect.arrayContaining(statusJobUrls));
        const pipelineKey = pipelineUrl.toLowerCase();
        expect(state.branches[pipelineKey]?.[0]).toBe("release/integration");
        expect(
          state.knownStageTotals[pipelineKey]?.totalStages,
        ).toBeGreaterThan(0);
      });
    }, 120_000);

    test("reports attributable git revisions for status and history", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-git-revisions/`;
        const build = await runCli(home, [
          "build",
          "--job-url",
          jobUrl,
          "--without-params",
          "--watch",
        ]);
        expect(build.output).toContain("SUCCESS");

        type Revision = {
          repo?: string;
          remoteUrl?: string;
          remoteUrls: string[];
          branch?: string;
          sha: string;
        };
        const status = parseJson<{
          data: { build: { number: number; revisions: Revision[] } };
        }>(await runCli(home, ["status", "--job-url", jobUrl, "--json"]));
        expect(status.data.build.revisions).toHaveLength(2);

        const statusByRepo = new Map(
          status.data.build.revisions.map((revision) => [
            revision.repo,
            revision,
          ]),
        );
        for (const repo of ["pipeline-definitions", "backend-api"]) {
          const revision = statusByRepo.get(repo);
          if (!revision) {
            throw new Error(`Missing revision for ${repo}`);
          }
          expect(revision.remoteUrl ?? "").toEndWith(`/${repo}.git`);
          expect(revision.remoteUrls).toContain(revision.remoteUrl ?? "");
          expect(revision.branch ?? "").toContain("main");
          expect(revision.sha).toMatch(/^[0-9a-f]{40}$/);
        }

        const history = parseJson<{
          data: Array<{ number: number; revisions: Revision[] }>;
        }>(await runCli(home, ["history", "--job-url", jobUrl, "--json"]));
        expect(history.data[0]?.number).toBe(status.data.build.number);
        const historyByRepo = new Map(
          history.data[0]?.revisions.map((revision) => [
            revision.repo,
            revision,
          ]),
        );
        expect(historyByRepo.get("pipeline-definitions")?.sha).toBe(
          statusByRepo.get("pipeline-definitions")?.sha,
        );
        expect(historyByRepo.get("backend-api")?.sha).toBe(
          statusByRepo.get("backend-api")?.sha,
        );

        const wait = parseJson<{
          data: { result: string; build: { revisions: Revision[] } };
        }>(await runCli(home, ["wait", "--job-url", jobUrl, "--json"]));
        expect(wait.data.result).toBe("SUCCESS");
        expect(
          wait.data.build.revisions.map((revision) => revision.sha).toSorted(),
        ).toEqual(
          status.data.build.revisions
            .map((revision) => revision.sha)
            .toSorted(),
        );

        const noScmJobUrl = `${jenkinsUrl}/job/cli-no-params/`;
        await runCli(home, [
          "build",
          "--job-url",
          noScmJobUrl,
          "--without-params",
          "--watch",
        ]);
        const noScmStatus = parseJson<{
          data: { build: { revisions: Revision[] } };
        }>(await runCli(home, ["status", "--job-url", noScmJobUrl, "--json"]));
        expect(noScmStatus.data.build.revisions).toEqual([]);
      });
    }, 120_000);

    test("explains build causes and groups contained commits by SCM", async () => {
      await withCliHome(async (home) => {
        // A build without SCM: causes are reported, empty changes succeed.
        const noScmJobUrl = `${jenkinsUrl}/job/cli-no-params/`;
        await runCli(home, [
          "build",
          "--job-url",
          noScmJobUrl,
          "--without-params",
          "--watch",
        ]);
        type ChangesDocument = {
          ok: boolean;
          command: string;
          data: {
            build: { number: number; url: string };
            causes: Array<{
              type: string;
              summary?: string;
              userId?: string;
            }>;
            changeSets: Array<{
              sourceType: string;
              revision?: {
                repo?: string;
                remoteUrl?: string;
                remoteUrls: string[];
                branch?: string;
                sha: string;
              };
              changes: Array<{
                id?: string;
                author?: string;
                timestampMs?: number;
                message?: string;
                paths?: string[];
              }>;
            }>;
            pagination: {
              limit: number;
              returned: number;
              total?: number;
              truncated: boolean;
            };
          };
        };
        const noScmChanges = parseJson<ChangesDocument>(
          await runCli(home, ["changes", "--job-url", noScmJobUrl, "--json"]),
        );
        expect(noScmChanges).toMatchObject({ ok: true, command: "changes" });
        expect(noScmChanges.data.causes[0]).toMatchObject({
          type: "user",
          userId: "integration-test",
        });
        expect(noScmChanges.data.changeSets).toEqual([]);
        expect(noScmChanges.data.pagination).toEqual({
          limit: 20,
          returned: 0,
          total: 0,
          truncated: false,
        });

        // Baseline build so the next one has a previous checkout to diff from.
        const revisionsJobUrl = `${jenkinsUrl}/job/cli-git-revisions/`;
        await runCli(home, [
          "build",
          "--job-url",
          revisionsJobUrl,
          "--without-params",
          "--watch",
        ]);

        // Land one commit in each fixture repo, then rebuild. Jenkins must
        // return two attributable change sets rather than one flat list.
        if (!integrationRuntimeDir) {
          throw new Error(
            "JENKINS_INTEGRATION_RUNTIME_DIR is required for the changes scenario.",
          );
        }
        const commits = new Map<string, string>();
        for (const change of [
          {
            repo: "pipeline-definitions",
            path: "pipeline-change.md",
            contents: "# Pipeline change\n",
            subject: "Update synthetic pipeline definitions",
          },
          {
            repo: "backend-api",
            path: "release-notes.md",
            contents:
              "# Release notes\n\nSynthetic change for the changes command.\n",
            subject: "Add synthetic release notes",
          },
        ]) {
          const bareRepository = join(
            integrationRuntimeDir,
            `${change.repo}.git`,
          );
          const clone = join(home, `${change.repo}-changes-clone`);
          await git("clone", bareRepository, clone);
          await Bun.write(join(clone, change.path), change.contents);
          await git("-C", clone, "add", change.path);
          await git(
            "-C",
            clone,
            "commit",
            "-m",
            change.subject,
            "-m",
            "Body line for the changes command.",
          );
          commits.set(change.repo, await git("-C", clone, "rev-parse", "HEAD"));
          await git("-C", clone, "push", "origin", "main");
          if (process.platform !== "win32") {
            // The container's jenkins user reads the pushed objects.
            Bun.spawnSync({ cmd: ["chmod", "-R", "a+rX", bareRepository] });
          }
        }

        await runCli(home, [
          "build",
          "--job-url",
          revisionsJobUrl,
          "--without-params",
          "--watch",
        ]);
        const commitChanges = parseJson<ChangesDocument>(
          await runCli(home, [
            "changes",
            "--job-url",
            revisionsJobUrl,
            "--json",
          ]),
        );
        expect(commitChanges.data.causes[0]).toMatchObject({
          type: "user",
          userId: "integration-test",
        });
        expect(commitChanges.data.changeSets).toHaveLength(2);
        const changeSetsByRepo = new Map(
          commitChanges.data.changeSets.map((changeSet) => [
            changeSet.revision?.repo,
            changeSet,
          ]),
        );
        for (const [repo, subject] of [
          ["pipeline-definitions", "Update synthetic pipeline definitions"],
          ["backend-api", "Add synthetic release notes"],
        ] as const) {
          const changeSet = changeSetsByRepo.get(repo);
          if (!changeSet) {
            throw new Error(`Missing change set for ${repo}`);
          }
          expect(changeSet.sourceType).toBe("git");
          expect(changeSet.revision).toMatchObject({
            repo,
            sha: commits.get(repo),
          });
          expect(changeSet.changes).toHaveLength(1);
          expect(changeSet.changes[0]).toMatchObject({
            id: commits.get(repo),
            message: `${subject}\n\nBody line for the changes command.`,
          });
          // Jenkins resolves the changelog author to a Jenkins user account.
          expect(changeSet.changes[0]?.author).toMatch(/integration/i);
          expect(changeSet.changes[0]?.paths).toBeUndefined();
        }
        expect(commitChanges.data.pagination).toEqual({
          limit: 20,
          returned: 2,
          total: 2,
          truncated: false,
        });

        // Affected paths appear only with --paths, and the exact-build
        // selector pins the same immutable answer.
        const commitBuild = commitChanges.data.build.number;
        const pinnedWithPaths = parseJson<ChangesDocument>(
          await runCli(home, [
            "changes",
            "--job-url",
            revisionsJobUrl,
            "--build",
            String(commitBuild),
            "--paths",
            "--json",
          ]),
        );
        expect(pinnedWithPaths.data.build.number).toBe(commitBuild);
        const pathsByRepo = new Map(
          pinnedWithPaths.data.changeSets.map((changeSet) => [
            changeSet.revision?.repo,
            changeSet.changes[0]?.paths,
          ]),
        );
        expect(pathsByRepo.get("pipeline-definitions")).toEqual([
          "pipeline-change.md",
        ]);
        expect(pathsByRepo.get("backend-api")).toEqual(["release-notes.md"]);

        const human = await runCli(home, [
          "changes",
          "--job-url",
          revisionsJobUrl,
        ]);
        expect(human.output).toContain(`Build: #${commitBuild}`);
        expect(human.output).toContain("user: Started by user");
        expect(human.output).toContain("SCM: pipeline-definitions (git)");
        expect(human.output).toContain("SCM: backend-api (git)");
        for (const commit of commits.values()) {
          expect(human.output).toContain(commit.slice(0, 12));
        }
        expect(human.output).toContain("Update synthetic pipeline definitions");
        expect(human.output).toContain("Add synthetic release notes");
        expect(human.output).not.toContain("Body line for the changes");
        expect(human.output).not.toContain("Affected paths:");

        const humanWithPaths = await runCli(home, [
          "changes",
          "--job-url",
          revisionsJobUrl,
          "--paths",
        ]);
        expect(humanWithPaths.output).toContain("Affected paths:");
        expect(humanWithPaths.output).toContain("release-notes.md");

        // Re-running the same revision is a successful empty result.
        await runCli(home, [
          "build",
          "--job-url",
          revisionsJobUrl,
          "--without-params",
          "--watch",
        ]);
        const rerunChanges = parseJson<ChangesDocument>(
          await runCli(home, [
            "changes",
            "--job-url",
            revisionsJobUrl,
            "--json",
          ]),
        );
        expect(rerunChanges.data.build.number).toBe(commitBuild + 1);
        expect(rerunChanges.data.changeSets).toEqual([]);

        // A missing build keeps its stable error code in JSON.
        const missing = parseJson<{ ok: boolean; error: { code: string } }>(
          await runCliExpectFailure(home, [
            "changes",
            "--job-url",
            revisionsJobUrl,
            "--build",
            "99999",
            "--json",
          ]),
        );
        expect(missing).toMatchObject({
          ok: false,
          error: { code: "BUILD_NOT_FOUND" },
        });
      });
    }, 240_000);

    test("filters and selects real whole-build and Pipeline logs", async () => {
      await withCliHome(async (home) => {
        const pipelineJobUrl = `${jenkinsUrl}/job/cli-pipeline-logs/`;
        await runCli(home, [
          "build",
          "--job-url",
          pipelineJobUrl,
          "--without-params",
          "--watch",
        ]);
        const pipelineStatus = parseJson<{
          data: { build: { url: string } };
        }>(
          await runCli(home, ["status", "--job-url", pipelineJobUrl, "--json"]),
        );
        const pipelineBuildUrl = pipelineStatus.data.build.url;

        const tail = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--tail",
          "2",
          "--no-follow",
        ]);
        expect(tail.stdout.split("\n").filter(Boolean)).toHaveLength(2);
        expect(tail.stdout).not.toContain("HINT:");
        expect(tail.stderr).toContain("HINT: Reading logs");

        const queried = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--plain",
          "--no-timestamps",
          "--grep",
          "pipeline-logs-context-target",
          "--context",
          "1",
          "--no-follow",
        ]);
        expect(queried.stdout.replaceAll("\r\n", "\n")).toBe(
          [
            "pipeline-logs-context-before",
            "pipeline-logs-context-target",
            "pipeline-logs-context-after",
            "",
          ].join("\n"),
        );
        expect(queried.stdout).not.toContain("\x1b");
        expect(queried.stdout).not.toContain("ha:////");
        expect(queried.stdout).not.toContain("[Pipeline]");
        expect(queried.stdout).not.toMatch(/^\[\d{4}-\d{2}-\d{2}T/m);

        const oscPlain = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--plain",
          "--no-timestamps",
          "--grep",
          "pipeline-logs-osc",
          "--no-follow",
        ]);
        expect(oscPlain.stdout.replaceAll("\r\n", "\n")).toBe(
          "pipeline-logs-osc pipeline-logs-link-label end\n",
        );

        const prepare = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Prepare",
          "--no-follow",
        ]);
        expect(prepare.stdout).toContain("pipeline-logs-prepare");
        expect(prepare.stdout).not.toContain("pipeline-logs-test-first");

        const preparedContext = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Prepare",
          "--plain",
          "--grep",
          "pipeline-logs-context-target",
          "--context",
          "1",
          "--no-follow",
        ]);
        expect(preparedContext.stdout).toContain(
          "pipeline-logs-context-before",
        );
        expect(preparedContext.stdout).toContain(
          "pipeline-logs-context-target",
        );
        expect(preparedContext.stdout).toContain("pipeline-logs-context-after");
        expect(preparedContext.stdout).not.toContain("ha:////");
        expect(preparedContext.stdout).not.toContain("\x1b");

        const parallel = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Parallel",
          "--no-follow",
        ]);
        expect(parallel.stdout).toContain("pipeline-logs-linux");
        expect(parallel.stdout).toContain("pipeline-logs-windows");

        const stageEvents = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Prepare",
          "--no-follow",
          "--jsonl",
        ]);
        expect(
          stageEvents.stdout
            .split("\n")
            .filter(Boolean)
            .map(
              (line) => JSON.parse(line) as { stage?: { stageName: string } },
            )
            .filter((event) => event.stage)
            .every((event) => event.stage?.stageName === "Prepare"),
        ).toBeTrue();

        const ambiguous = await runCliExpectFailure(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage",
          "Test",
          "--no-follow",
        ]);
        expect(ambiguous.stderr).toContain("is ambiguous");
        const firstTestStageId =
          ambiguous.stderr.match(/Test \(id (\d+)\)/)?.[1];
        expect(firstTestStageId).toBeDefined();
        const exactStage = await runCli(home, [
          "logs",
          "--build-url",
          pipelineBuildUrl,
          "--stage-id",
          firstTestStageId!,
          "--no-follow",
        ]);
        expect(exactStage.stdout).toContain("pipeline-logs-test-");

        const failureJobUrl = `${jenkinsUrl}/job/cli-pipeline-failure/`;
        await runCliExpectFailure(home, [
          "build",
          "--job-url",
          failureJobUrl,
          "--without-params",
          "--watch",
        ]);
        const failed = await runCli(home, [
          "logs",
          "--job-url",
          failureJobUrl,
          "--failed",
          "--no-follow",
        ]);
        expect(failed.stdout).toContain("pipeline-deploy-context");
        expect(failed.stderr).toContain("pipeline-deploy-failure");
        const failedContext = await runCli(home, [
          "logs",
          "--job-url",
          failureJobUrl,
          "--failed",
          "--grep",
          "pipeline-deploy-context",
          "--context",
          "1",
          "--no-follow",
        ]);
        expect(failedContext.stdout).toContain("pipeline-deploy-before");
        expect(failedContext.stdout).toContain("pipeline-deploy-context");
        expect(failedContext.stdout).toContain("pipeline-deploy-after");
        const unsupportedSince = await runCliExpectFailure(home, [
          "logs",
          "--job-url",
          failureJobUrl,
          "--since",
          "1h",
          "--no-follow",
        ]);
        expect(unsupportedSince.stderr).toContain("did not expose timestamps");

        const timestampedJobUrl = `${jenkinsUrl}/job/cli-timestamped-logs/`;
        await runCli(home, [
          "build",
          "--job-url",
          timestampedJobUrl,
          "--without-params",
          "--watch",
        ]);
        const timestamped = await runCli(home, [
          "logs",
          "--job-url",
          timestampedJobUrl,
          "--since",
          "1h",
          "--no-follow",
        ]);
        expect(timestamped.stdout).toContain("timestamped-log-old");
        expect(timestamped.stdout).toContain("timestamped-log-new");

        const future = await runCli(home, [
          "logs",
          "--job-url",
          timestampedJobUrl,
          "--since",
          new Date(Date.now() + 60_000).toISOString(),
          "--no-follow",
        ]);
        expect(future.stdout).toBe("");
      });
    }, 180_000);

    test("reads a large log's tail and --since without downloading it twice", async () => {
      const received: { method: string; path: string; bytes: number }[] = [];
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const incoming = new URL(request.url);
          const target = new URL(jenkinsUrl!);
          target.pathname = incoming.pathname;
          target.search = incoming.search;
          const headers = new Headers(request.headers);
          headers.delete("host");
          const response = await fetch(target, {
            method: request.method,
            headers,
            body: ["GET", "HEAD"].includes(request.method)
              ? undefined
              : await request.arrayBuffer(),
            redirect: "manual",
          });
          const body = await response.arrayBuffer();
          received.push({
            method: request.method,
            path: incoming.pathname,
            bytes: body.byteLength,
          });
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete("content-length");
          responseHeaders.delete("content-encoding");
          return new Response(body, {
            status: response.status,
            headers: responseHeaders,
          });
        },
      });
      const bytesFrom = (suffix: string): number =>
        received
          .filter((entry) => entry.path.endsWith(suffix))
          .reduce((total, entry) => total + entry.bytes, 0);
      try {
        await withCliHome(async (home) => {
          const root = `${proxy.url.origin}/jenkins`;
          const env = { JENKINS_URL: root };
          const jobUrl = `${root}/job/cli-large-log/`;
          await runCli(
            home,
            ["build", "--job-url", jobUrl, "--without-params", "--watch"],
            env,
          );
          const buildUrl = parseJson<{ data: { build: { url: string } } }>(
            await runCli(home, ["status", "--job-url", jobUrl, "--json"], env),
          ).data.build.url;

          received.length = 0;
          const full = await runCli(
            home,
            ["logs", "--build-url", buildUrl, "--no-follow"],
            env,
          );
          const fullBytes = bytesFrom("/logText/progressiveText");
          expect(full.stdout).toContain("large-log-40000");
          expect(fullBytes).toBeGreaterThan(4 * 1024 * 1024);
          const fullLines = splitLogLines(full.stdout);

          // 2,000 lines outgrow the first 64KB window, so this also covers
          // the window growing.
          for (const lines of [3, 2_000]) {
            received.length = 0;
            const tail = await runCli(
              home,
              [
                "logs",
                "--build-url",
                buildUrl,
                "--tail",
                String(lines),
                "--no-follow",
              ],
              env,
            );
            expect(tail.stdout).toBe(fullLines.slice(-lines).join(""));
            expect(bytesFrom("/logText/progressiveText")).toBeLessThan(
              fullBytes / 4,
            );
          }

          received.length = 0;
          const since = await runCli(
            home,
            ["logs", "--build-url", buildUrl, "--since", "1h", "--no-follow"],
            env,
          );
          expect(since.stdout.match(/^large-log-\d{5} /gm)).toHaveLength(
            40_000,
          );
          expect(since.stdout).toContain("large-log-last");
          // A finished build's --since reads only Timestamper's appendLog
          // text; the console log itself is never downloaded.
          expect(bytesFrom("/logText/progressiveText")).toBe(0);
          expect(bytesFrom("/timestamps/")).toBeLessThan(fullBytes * 1.5);
        });
      } finally {
        await proxy.stop(true);
      }
    }, 180_000);

    test("defaults redirected logs to a one-shot read while a build is running", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-log-follow/`;
        await runCli(home, ["build", "--job-url", jobUrl, "--without-params"]);
        const running = await pollCli(
          home,
          ["status", "--job-url", jobUrl, "--json"],
          (result) => {
            const payload = JSON.parse(result.stdout) as {
              data?: { build?: { building?: boolean; url?: string } };
            };
            return payload.data?.build?.building === true;
          },
        );
        const runningBuildUrl = (
          JSON.parse(running.stdout) as {
            data: { build: { url: string } };
          }
        ).data.build.url;

        const logs = await runCli(home, [
          "logs",
          "--build-url",
          runningBuildUrl,
          "--tail",
          "1",
        ]);
        expect(logs.stdout).toContain("tail-follow-bootstrap-2");
        expect(logs.stdout).not.toContain("tail-follow-finished");

        const stillRunning = JSON.parse(
          (
            await runCli(home, [
              "status",
              "--build-url",
              runningBuildUrl,
              "--json",
            ])
          ).stdout,
        ) as { data: { build: { building: boolean } } };
        expect(stillRunning.data.build.building).toBe(true);

        await runCli(home, [
          "wait",
          "--build-url",
          runningBuildUrl,
          "--timeout",
          "30s",
          "--interval",
          "250ms",
          "--json",
        ]);
      });
    }, 90_000);

    test("polls a running build without re-reading data that cannot change", async () => {
      await withCliHome(async (waitHome) => {
        await withCliHome(async (logsHome) => {
          const jobUrl = `${jenkinsUrl}/job/cli-log-follow/`;
          await runCli(waitHome, [
            "build",
            "--job-url",
            jobUrl,
            "--without-params",
          ]);
          const running = await pollCli(
            waitHome,
            ["status", "--job-url", jobUrl, "--json"],
            (result) => {
              const payload = JSON.parse(result.stdout) as {
                data?: { build?: { building?: boolean } };
              };
              return payload.data?.build?.building === true;
            },
          );
          const buildUrl = (
            JSON.parse(running.stdout) as {
              data: { build: { url: string } };
            }
          ).data.build.url;
          // Only requests made by the commands under test count below.
          for (const home of [waitHome, logsHome]) {
            for (const file of cliLogFiles(home, "api")) {
              rmSync(file);
            }
          }

          const [waited, logs] = await Promise.all([
            invokeCli(waitHome, [
              "wait",
              "--build-url",
              buildUrl,
              "--interval",
              "250ms",
              "--timeout",
              "60s",
              "--json",
              "--debug",
            ]),
            invokeCli(logsHome, [
              "logs",
              "--build-url",
              buildUrl,
              "--follow",
              "--poll",
              "100ms",
              "--debug",
            ]),
          ]);

          expect(waited.exitCode, waited.output).toBe(0);
          const waitedBuild = (
            JSON.parse(waited.stdout) as {
              data: { result: string; build: { triggeredBy?: string } };
            }
          ).data;
          expect(waitedBuild.result).toBe("SUCCESS");
          expect(waitedBuild.build.triggeredBy).toBeString();
          const waitRequests = await apiRequestUrls(waitHome);
          const waitStatusReads = waitRequests.filter((url) =>
            url.startsWith(`${buildUrl}api/json`),
          );
          expect(waitStatusReads.length).toBeGreaterThan(3);
          // Parameters and causes are read once, not on every poll.
          expect(
            waitStatusReads.filter((url) => url.includes("parameters[")),
          ).toHaveLength(1);
          // A freestyle build has no wfapi; the 404 is remembered.
          expect(
            waitRequests.filter((url) => url.includes("/wfapi/describe")),
          ).toHaveLength(1);
          expect(
            waitRequests.filter((url) => url.includes("/queue/item/")).length,
          ).toBeLessThanOrEqual(1);

          expect(logs.exitCode, logs.output).toBe(0);
          expect(logs.stdout).toContain("tail-follow-finished");
          const logsRequests = await apiRequestUrls(logsHome);
          expect(
            logsRequests.filter((url) => url.includes("/progressiveText"))
              .length,
          ).toBeGreaterThan(10);
          // X-More-Data says when the log is done; status is read at start
          // and once the log closes, not on every 100ms poll.
          expect(
            logsRequests.filter((url) => url.startsWith(`${buildUrl}api/json`))
              .length,
          ).toBeLessThanOrEqual(3);
        });
      });
    }, 90_000);

    test("follows one Pipeline stage without re-reading other stages or finished steps", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-pipeline-stage-follow/`;
        await runCli(home, ["build", "--job-url", jobUrl, "--without-params"]);
        const running = await pollCli(
          home,
          ["status", "--job-url", jobUrl, "--json"],
          (result) => {
            const payload = JSON.parse(result.stdout) as {
              data?: {
                build?: {
                  building?: boolean;
                  stages?: { name?: string; status?: string }[];
                };
              };
            };
            return (
              payload.data?.build?.building === true &&
              payload.data.build.stages?.some(
                (stage) =>
                  stage.name === "Watch" && stage.status === "IN_PROGRESS",
              ) === true
            );
          },
        );
        const buildUrl = parseJson<{ data: { build: { url: string } } }>(
          running,
        ).data.build.url;
        for (const file of cliLogFiles(home, "api")) {
          rmSync(file);
        }

        const logs = await invokeCli(home, [
          "logs",
          "--build-url",
          buildUrl,
          "--stage",
          "Watch",
          "--follow",
          "--poll",
          "100ms",
          "--debug",
        ]);

        expect(logs.exitCode, logs.output).toBe(0);
        for (const line of [
          "stage-follow-first",
          "stage-follow-second",
          "stage-follow-third",
        ]) {
          expect(logs.stdout.split(line)).toHaveLength(2);
        }
        expect(logs.stdout).not.toContain("stage-follow-build");
        expect(logs.stdout).not.toContain("stage-follow-lint");

        const paths = (await apiRequestUrls(home)).map(
          (url) => new URL(url).pathname,
        );
        const statusPath = new URL(`${buildUrl}api/json`).pathname;
        const describePath = new URL(`${buildUrl}wfapi/describe`).pathname;
        const statusReads = paths.filter((path) => path === statusPath);
        expect(statusReads.length).toBeGreaterThan(10);
        // The stage list rides on each status poll; no separate describe.
        expect(paths.filter((path) => path === describePath)).toHaveLength(
          statusReads.length,
        );
        // Only the Watch stage's node is described, never Build or Lint.
        expect(
          countBy(
            paths.filter(
              (path) =>
                path.includes("/execution/node/") &&
                path.endsWith("/wfapi/describe"),
            ),
          ).size,
        ).toBe(1);
        // Each step's wfapi log is read once; its console URL is remembered.
        const nodeLogReads = countBy(
          paths.filter((path) => path.endsWith("/wfapi/log")),
        );
        expect(nodeLogReads.size).toBeGreaterThanOrEqual(3);
        expect([...nodeLogReads.values()].every((count) => count === 1)).toBe(
          true,
        );
        // A step that finished before its first read is read exactly once.
        const consoleReads = countBy(
          paths.filter((path) => path.endsWith("/progressiveText")),
        );
        expect(Math.min(...consoleReads.values())).toBe(1);
      });
    }, 90_000);

    test.skipIf(process.platform === "win32")(
      "defaults redirected logs to one shot while explicit follow keeps streaming",
      async () => {
        await withCliHome(async (home) => {
          const jobUrl = `${jenkinsUrl}/job/cli-log-follow/`;
          await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--without-params",
          ]);
          const running = await pollCli(
            home,
            ["status", "--job-url", jobUrl, "--json"],
            (result) => {
              const payload = JSON.parse(result.stdout) as {
                data?: { build?: { building?: boolean; url?: string } };
              };
              return payload.data?.build?.building === true;
            },
          );
          const runningBuildUrl = (
            JSON.parse(running.stdout) as {
              data: { build: { url: string } };
            }
          ).data.build.url;
          const redirected = await runCli(home, [
            "logs",
            "--build-url",
            runningBuildUrl,
            "--tail",
            "1",
            "--poll",
            "100ms",
          ]);
          expect(redirected.stdout).toContain("tail-follow-bootstrap");
          const stillRunning = parseJson<{
            data: { build: { building: boolean } };
          }>(
            await runCli(home, [
              "status",
              "--build-url",
              runningBuildUrl,
              "--json",
            ]),
          );
          expect(stillRunning.data.build.building).toBe(true);

          const interrupted = await invokeCliAndInterrupt(
            home,
            [
              "logs",
              "--build-url",
              runningBuildUrl,
              "--tail",
              "1",
              "--follow",
              "--poll",
              "100ms",
            ],
            "HINT: Reading logs",
          );
          expect(interrupted.exitCode).toBe(130);
          expect(interrupted.stderr).toContain(
            "the Jenkins build was not cancelled",
          );

          const completed = await runCli(home, [
            "wait",
            "--build-url",
            runningBuildUrl,
            "--timeout",
            "30s",
            "--interval",
            "250ms",
            "--json",
          ]);
          expect(JSON.parse(completed.stdout)).toMatchObject({
            data: { result: "SUCCESS" },
          });
        });
      },
      90_000,
    );

    test("follows logs while a queued item becomes a build", async () => {
      await withCliHome(async (home) => {
        const slowJobUrl = `${jenkinsUrl}/job/cli-slow/`;
        await runCli(home, [
          "build",
          "--job-url",
          slowJobUrl,
          "--without-params",
        ]);
        const running = await pollCli(home, ["run"], (result) =>
          result.output.includes("cli-slow #"),
        );
        const slowBuildUrl = running.output.match(
          /(http:\/\/[^\s]+\/job\/cli-slow\/\d+\/)/,
        )?.[1];
        expect(slowBuildUrl).toBeDefined();

        const transitionJobUrl = `${jenkinsUrl}/job/cli-transition/`;
        await runCli(home, [
          "build",
          "--job-url",
          transitionJobUrl,
          "--without-params",
        ]);
        const queued = await pollCli(
          home,
          ["queue", "--job", "cli-transition"],
          (result) => result.output.includes("cli-transition"),
        );
        const queueId = queued.output.match(/^\s*(\d+)\s+cli-transition/m)?.[1];
        expect(queueId).toBeDefined();
        const queueUrl = `${jenkinsUrl}/queue/item/${queueId}/`;

        const waitPromise = invokeCli(home, [
          "wait",
          "--queue-url",
          queueUrl,
          "--interval",
          "250ms",
          "--timeout",
          "30s",
          "--json",
        ]);
        const logsPromise = invokeCli(home, [
          "logs",
          "--queue-url",
          queueUrl,
          "--follow",
          "--poll",
          "100ms",
        ]);
        await runCli(home, ["cancel", "--build-url", slowBuildUrl!]);

        const [waited, logs] = await Promise.all([waitPromise, logsPromise]);
        expect(waited.exitCode, waited.output).toBe(0);
        expect(JSON.parse(waited.stdout)).toMatchObject({
          data: { result: "SUCCESS", build: { result: "SUCCESS" } },
        });
        expect(logs.exitCode, logs.output).toBe(0);
        expect(logs.output).toContain("transition-started");
        expect(logs.output).toContain("transition-finished");
        expect(logs.output.match(/^transition-started$/gm)).toHaveLength(1);
      });
    }, 90_000);

    test("uses CSRF crumbs, history offsets, --limit, and exact artifact targets", async () => {
      await withCliHome(async (home) => {
        const historyJobUrl = `${jenkinsUrl}/job/cli-history/`;
        for (let index = 0; index < 11; index++) {
          await runCli(home, [
            "build",
            "--job-url",
            historyJobUrl,
            "--without-params",
            "--watch",
          ]);
        }

        const secondPage = await pollCli(
          home,
          ["history", "--job-url", historyJobUrl, "--offset", "5", "--json"],
          (result) => {
            const payload = JSON.parse(result.stdout) as {
              data?: Array<{ number?: number; result?: string }>;
            };
            return (
              payload.data?.length === 5 &&
              payload.data[0]?.number === 6 &&
              payload.data.every((build) => build.result === "SUCCESS")
            );
          },
          30_000,
        );
        const secondPageBuilds = parseJson<{
          data: Array<{ number: number; result: string }>;
        }>(secondPage).data;
        expect(secondPageBuilds.map((build) => build.number)).toEqual([
          6, 5, 4, 3, 2,
        ]);
        expect(
          secondPageBuilds.every((build) => build.result === "SUCCESS"),
        ).toBe(true);
        const firstPage = parseJson<{ data: Array<{ number: number }> }>(
          await runCli(home, [
            "history",
            "--job-url",
            historyJobUrl,
            "--offset",
            "0",
            "--json",
          ]),
        );
        expect(firstPage.data).toHaveLength(5);
        expect(firstPage.data.map((build) => build.number)).toEqual([
          11, 10, 9, 8, 7,
        ]);
        const finalPage = parseJson<{ data: Array<{ number: number }> }>(
          await runCli(home, [
            "history",
            "--job-url",
            historyJobUrl,
            "--offset",
            "10",
            "--json",
          ]),
        );
        expect(finalPage.data.map((build) => build.number)).toEqual([1]);

        const limited = parseJson<{ data: Array<{ number: number }> }>(
          await runCli(home, [
            "history",
            "--job",
            "cli-history",
            "--limit",
            "2",
            "--json",
          ]),
        );
        expect(limited.data.map((build) => build.number)).toEqual([11, 10]);
        const widePage = parseJson<{ data: Array<{ number: number }> }>(
          await runCli(home, [
            "history",
            "--job",
            "cli-history",
            "--limit",
            "10",
            "--offset",
            "1",
            "--json",
          ]),
        );
        expect(widePage.data.map((build) => build.number)).toEqual([
          10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
        ]);

        // A slow proxy holds every wfapi/describe open long enough to see how
        // many history fires at once.
        let describeRequests = 0;
        let describesInFlight = 0;
        let peakDescribesInFlight = 0;
        const slowProxy = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const incoming = new URL(request.url);
            const isDescribe = incoming.pathname.endsWith("/wfapi/describe");
            if (isDescribe) {
              describeRequests++;
              describesInFlight++;
              peakDescribesInFlight = Math.max(
                peakDescribesInFlight,
                describesInFlight,
              );
              await Bun.sleep(200);
            }
            try {
              const target = new URL(jenkinsUrl!);
              target.pathname = incoming.pathname;
              target.search = incoming.search;
              const headers = new Headers(request.headers);
              headers.delete("host");
              const response = await fetch(target, {
                method: request.method,
                headers,
                redirect: "manual",
              });
              const responseHeaders = new Headers(response.headers);
              responseHeaders.delete("content-length");
              responseHeaders.delete("content-encoding");
              return new Response(await response.arrayBuffer(), {
                status: response.status,
                headers: responseHeaders,
              });
            } finally {
              if (isDescribe) describesInFlight--;
            }
          },
        });
        try {
          const proxiedRoot = `${slowProxy.url.origin}/jenkins`;
          const fullHistory = await invokeCli(
            home,
            [
              "history",
              "--job-url",
              `${proxiedRoot}/job/cli-history/`,
              "--limit",
              "11",
              "--json",
            ],
            { JENKINS_URL: proxiedRoot },
          );
          expect(fullHistory.exitCode, fullHistory.output).toBe(0);
          expect(
            parseJson<{ data: Array<{ number: number }> }>(
              fullHistory,
            ).data.map((build) => build.number),
          ).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
          expect(describeRequests).toBe(11);
          expect(peakDescribesInFlight).toBe(JENKINS_READ_LIMIT);
          console.log(
            `history --limit 11: wfapi/describe requests=${describeRequests}, peak in flight=${peakDescribesInFlight}`,
          );
        } finally {
          await slowProxy.stop(true);
        }
        const listed = parseJson<{ data: unknown[] }>(
          await runCli(home, ["list", "--limit", "1", "--json"]),
        );
        expect(listed.data).toHaveLength(1);
        const rejected = await runCliExpectFailure(home, [
          "history",
          "--job",
          "cli-history",
          "--limit",
          "0",
          "--json",
        ]);
        expect(rejected.exitCode).toBe(2);
        expect(
          parseJson<{ error: { code: string } }>(rejected).error.code,
        ).toBe("INVALID_USAGE");

        const smokeUrl = `${jenkinsUrl}/job/cli-smoke/`;
        await runCli(home, [
          "build",
          "--job-url",
          smokeUrl,
          "--param",
          "MESSAGE=exact-artifact-target",
          "--watch",
        ]);
        const smokeStatus = parseJson<{
          data: { build: { number: number; url: string } };
        }>(await runCli(home, ["status", "--job-url", smokeUrl, "--json"]));
        const byNumber = await runCli(home, [
          "artifacts",
          "--job-url",
          smokeUrl,
          "--build",
          String(smokeStatus.data.build.number),
        ]);
        expect(byNumber.output).toContain("reports/values.txt");

        const destination = join(home, "exact-artifact");
        await runCli(home, [
          "artifacts",
          "--build-url",
          smokeStatus.data.build.url,
          "--artifact",
          "artifact.txt",
          "--dest",
          destination,
        ]);
        expect(await Bun.file(join(destination, "artifact.txt")).text()).toBe(
          "root-artifact\n",
        );
      });
    }, 120_000);

    test("lists, guards, approves, and aborts pending Pipeline input actions", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-pipeline-input/`;
        const parameterizedJobUrl = `${jenkinsUrl}/job/cli-pipeline-input-params/`;
        const readerEnv = {
          JENKINS_USER:
            process.env.JENKINS_INTEGRATION_READER_USER ?? "integration-reader",
          JENKINS_API_TOKEN: process.env.JENKINS_INTEGRATION_READER_TOKEN ?? "",
        };
        const latestBuildNumber = async (url: string): Promise<number> => {
          const status = parseJson<{
            data: { build: { number: number } | null };
          }>(await runCli(home, ["status", "--job-url", url, "--json"]));
          return status.data.build?.number ?? 0;
        };
        const pendingIds = async (buildUrl: string): Promise<string[]> => {
          const listed = parseJson<{
            data: { actions: Array<{ id: string }> };
          }>(
            await runCli(home, [
              "input",
              "list",
              "--build-url",
              buildUrl,
              "--json",
            ]),
          );
          return listed.data.actions.map((action) => action.id);
        };
        const waitForPendingInput = async (buildUrl: string): Promise<void> => {
          await pollCli(
            home,
            ["input", "list", "--build-url", buildUrl, "--json"],
            (candidate) => {
              const payload = JSON.parse(candidate.stdout) as {
                data?: { actions?: unknown[] };
              };
              return (payload.data?.actions?.length ?? 0) > 0;
            },
            60_000,
          );
        };
        const expectFailureCode = async (
          args: string[],
          codes: string[],
          envOverrides: Record<string, string | undefined> = {},
        ): Promise<string> => {
          const result = await runCliExpectFailure(home, args, envOverrides);
          const lines = result.stdout.split("\n").filter(Boolean);
          expect(lines, result.output).toHaveLength(1);
          const payload = JSON.parse(lines[0] as string) as {
            ok: boolean;
            error: { code: string; message: string };
          };
          expect(payload.ok).toBe(false);
          expect(codes, payload.error.message).toContain(payload.error.code);
          return payload.error.code;
        };

        // A freestyle build has no Pipeline REST API: never an empty list.
        const freestyleJobUrl = `${jenkinsUrl}/job/cli-no-params/`;
        await runCli(home, [
          "build",
          "--job-url",
          freestyleJobUrl,
          "--without-params",
          "--watch",
          "--json",
        ]);
        await expectFailureCode(
          ["input", "list", "--job-url", freestyleJobUrl, "--json"],
          ["PIPELINE_INPUT_UNSUPPORTED"],
        );

        // Pause a Pipeline at its parameterless input step.
        const before = await latestBuildNumber(jobUrl);
        await runCli(home, [
          "build",
          "--job-url",
          jobUrl,
          "--without-params",
          "--json",
        ]);
        const buildUrl = await waitForNewBuild(home, jobUrl, before);
        const buildNumber = before + 1;
        await waitForPendingInput(buildUrl);

        const listed = parseJson(
          await runCli(home, [
            "input",
            "list",
            "--build-url",
            buildUrl,
            "--json",
          ]),
        );
        expect(listed).toMatchObject({
          ok: true,
          command: "input list",
          data: {
            build: { url: buildUrl, number: buildNumber, building: true },
            actions: [
              {
                id: "ReleaseProd",
                message: "Deploy cli-pipeline-input to production?",
                proceedText: "Ship it",
                requiresParameters: false,
                parameters: [],
                proceedUrl: `${buildUrl}wfapi/inputSubmit?inputId=ReleaseProd`,
                abortUrl: `${buildUrl}input/ReleaseProd/abort`,
                approvalUrl: `${buildUrl}input/`,
              },
            ],
          },
        });
        const byNumber = parseJson<{
          data: { actions: Array<{ id: string }> };
        }>(
          await runCli(home, [
            "input",
            "list",
            "--job-url",
            jobUrl,
            "--build",
            String(buildNumber),
            "--json",
          ]),
        );
        expect(byNumber.data.actions.map((action) => action.id)).toEqual([
          "ReleaseProd",
        ]);
        const text = await runCli(home, [
          "input",
          "list",
          "--build-url",
          buildUrl,
        ]);
        expect(text.output).toContain(
          "ReleaseProd: Deploy cli-pipeline-input to production?",
        );
        expect(text.output).toContain(
          "parameters: none | actions: approve, abort",
        );

        // --json and --non-interactive alone never submit.
        await expectFailureCode(
          ["input", "approve", "--build-url", buildUrl, "--json"],
          ["INPUT_CONFIRMATION_REQUIRED"],
        );
        const refusedText = await runCliExpectFailure(home, [
          "input",
          "abort",
          "--build-url",
          buildUrl,
        ]);
        expect(refusedText.output).toContain(
          "ERROR: Refusing to abort a pending input without confirmation.",
        );
        await expectFailureCode(
          [
            "input",
            "approve",
            "--build-url",
            buildUrl,
            "--id",
            "Nope",
            "--yes",
            "--json",
          ],
          ["INPUT_ACTION_NOT_FOUND"],
        );

        // A reader may neither approve nor abort; Jenkins wraps the approval
        // rejection generically, so only the abort proves the permission text.
        const readerApprove = await expectFailureCode(
          ["input", "approve", "--build-url", buildUrl, "--yes", "--json"],
          ["INPUT_PERMISSION_DENIED", "INPUT_SUBMISSION_REJECTED"],
          readerEnv,
        );
        const readerAbort = await expectFailureCode(
          ["input", "abort", "--build-url", buildUrl, "--yes", "--json"],
          ["INPUT_PERMISSION_DENIED", "INPUT_SUBMISSION_REJECTED"],
          readerEnv,
        );
        console.log(
          `reader approve -> ${readerApprove}; reader abort -> ${readerAbort}`,
        );
        expect(await pendingIds(buildUrl)).toEqual(["ReleaseProd"]);

        if (process.platform !== "win32") {
          // Bare interactive launcher: discover the input from the job menu,
          // Esc back without submitting, and the action menu survives.
          const session = await observeInteractiveCli(
            home,
            ["--no-banner"],
            [
              {
                text: "Job name or description",
                input: "cli-pipeline-input\r",
              },
              {
                text: "Action for cli-pipeline-input",
                input: `${"\u001b[B".repeat(8)}\r`,
              },
              {
                text: `Pending inputs for cli-pipeline-input #${buildNumber}`,
                input: "\u001b",
              },
              { text: "Action for cli-pipeline-input", input: "" },
            ],
          );
          expect(session.output).toContain(
            "ReleaseProd: Deploy cli-pipeline-input to production?",
          );
          expect(session.output).not.toContain("Approved input");
          expect(await pendingIds(buildUrl)).toEqual(["ReleaseProd"]);
        }

        const approved = parseJson(
          await runCli(home, [
            "input",
            "approve",
            "--build-url",
            buildUrl,
            "--yes",
            "--json",
          ]),
        );
        expect(approved).toMatchObject({
          ok: true,
          command: "input approve",
          data: {
            operation: "approve",
            disposition: "approved",
            build: { url: buildUrl, number: buildNumber },
            action: { id: "ReleaseProd" },
          },
        });
        const waited = parseJson<{ data: { result: string } }>(
          await runCli(home, [
            "wait",
            "--build-url",
            buildUrl,
            "--timeout",
            "90s",
            "--json",
          ]),
        );
        expect(waited.data.result).toBe("SUCCESS");
        expect(await pendingIds(buildUrl)).toEqual([]);
        await expectFailureCode(
          ["input", "approve", "--build-url", buildUrl, "--yes", "--json"],
          ["INPUT_NOT_PENDING"],
        );

        // Parameterized inputs cannot be approved here but can be aborted.
        const beforeParameterized =
          await latestBuildNumber(parameterizedJobUrl);
        await runCli(home, [
          "build",
          "--job-url",
          parameterizedJobUrl,
          "--without-params",
          "--json",
        ]);
        const parameterizedBuildUrl = await waitForNewBuild(
          home,
          parameterizedJobUrl,
          beforeParameterized,
        );
        await waitForPendingInput(parameterizedBuildUrl);
        const parameterized = parseJson<{
          data: { actions: Array<Record<string, unknown>> };
        }>(
          await runCli(home, [
            "input",
            "list",
            "--build-url",
            parameterizedBuildUrl,
            "--json",
          ]),
        );
        expect(parameterized.data.actions).toEqual([
          expect.objectContaining({
            id: "PickTag",
            requiresParameters: true,
            parameters: [
              expect.objectContaining({
                name: "TAG",
                type: "StringParameterDefinition",
              }),
            ],
          }),
        ]);
        await expectFailureCode(
          [
            "input",
            "approve",
            "--build-url",
            parameterizedBuildUrl,
            "--yes",
            "--json",
          ],
          ["INPUT_PARAMETERS_UNSUPPORTED"],
        );
        expect(await pendingIds(parameterizedBuildUrl)).toEqual(["PickTag"]);
        const aborted = parseJson(
          await runCli(home, [
            "input",
            "abort",
            "--build-url",
            parameterizedBuildUrl,
            "--yes",
            "--json",
          ]),
        );
        expect(aborted).toMatchObject({
          ok: true,
          command: "input abort",
          data: { disposition: "aborted", action: { id: "PickTag" } },
        });
        const abortedWait = parseJson<{ data: { result: string } }>(
          await runCliExpectFailure(home, [
            "wait",
            "--build-url",
            parameterizedBuildUrl,
            "--timeout",
            "90s",
            "--json",
          ]),
        );
        expect(abortedWait.data.result).toBe("ABORTED");
        expect(await pendingIds(parameterizedBuildUrl)).toEqual([]);
      });
    }, 300_000);

    test("replays a Pipeline build with its original and edited scripts", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-replay/`;
        const replayScript = [
          "node {",
          "  writeFile file: 'helper.groovy', text: 'def greet(name) { echo \"replay-helper:${name}\" }; return this'",
          "  def helper = load 'helper.groovy'",
          '  echo "replay-main:${params.GREETING} <&>"',
          "  helper.greet(params.GREETING)",
          "}",
          "",
        ].join("\n");
        const latestBuildNumber = async (url: string): Promise<number> => {
          const status = parseJson<{
            data: { build: { number: number } | null };
          }>(await runCli(home, ["status", "--job-url", url, "--json"]));
          return status.data.build?.number ?? 0;
        };
        type ReplayReceipt = {
          ok: true;
          command: string;
          data: {
            source: { buildUrl: string; buildNumber: number };
            target: { buildUrl: string; buildNumber: number };
            result: string;
          };
        };

        const source = parseJson<{ data: { buildNumber: number } }>(
          await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--param",
            "GREETING=integration",
            "--watch",
            "--json",
          ]),
        ).data.buildNumber;
        const sourceUrl = `${jobUrl}${source}/`;

        const printed = await runCli(home, [
          "replay",
          "--job-url",
          jobUrl,
          "--build",
          String(source),
          "--print-script",
        ]);
        expect(printed.stdout).toBe(replayScript);
        const printedHelper = await runCli(home, [
          "replay",
          "--build-url",
          sourceUrl,
          "--print-loaded",
          "Script1",
        ]);
        expect(printedHelper.stdout).toBe(
          'def greet(name) { echo "replay-helper:${name}" }; return this',
        );

        // The printed script replayed unchanged behaves like a rebuild,
        // including the source build's parameters.
        const scriptPath = join(home, "Jenkinsfile");
        await Bun.write(scriptPath, printed.stdout);
        const unchanged = await runCli(home, [
          "replay",
          "--build-url",
          sourceUrl,
          "--script",
          scriptPath,
          "--follow",
        ]);
        expect(unchanged.output).toContain(
          `with its original scripts. Parameters are copied from #${source}.`,
        );
        expect(unchanged.output).toContain("replay-main:integration <&>");
        expect(unchanged.output).toContain("replay-helper:integration");
        // The replay may be found still queued ("Build queued at") or
        // already running ("Build started at"); --follow reports it either way.
        const unchangedNumber = Number(
          unchanged.output.match(/Build #(\d+) finished: SUCCESS\./)?.[1],
        );
        expect(unchangedNumber).toBeGreaterThan(source);

        await Bun.write(
          scriptPath,
          printed.stdout.replace("replay-main:", "replay-edited:"),
        );
        const helperPath = join(home, "helper.groovy");
        await Bun.write(
          helperPath,
          'def greet(name) { echo "replay-edited-helper:${name}" }; return this',
        );
        const edited = parseJson<ReplayReceipt>(
          await runCli(home, [
            "replay",
            "--build-url",
            sourceUrl,
            "--script",
            scriptPath,
            "--loaded",
            `Script1=${helperPath}`,
            "--follow",
            "--json",
          ]),
        );
        expect(edited).toMatchObject({
          ok: true,
          command: "replay",
          data: {
            source: { buildUrl: sourceUrl, buildNumber: source },
            result: "SUCCESS",
          },
        });
        const editedNumber = edited.data.target.buildNumber;
        expect(editedNumber).toBeGreaterThan(unchangedNumber);
        expect(edited.data.target.buildUrl).toBe(`${jobUrl}${editedNumber}/`);
        const editedLogs = await runCli(home, [
          "logs",
          "--build-url",
          edited.data.target.buildUrl,
          "--plain",
        ]);
        expect(editedLogs.output).toContain("replay-edited:integration <&>");
        expect(editedLogs.output).toContain("replay-edited-helper:integration");
        expect(editedLogs.output).not.toContain("replay-main:");
        expect(editedLogs.output).toContain(`Replayed #${source}`);

        const freestyle = parseJson<{ data: { buildUrl: string } }>(
          await runCli(home, [
            "build",
            "--job-url",
            `${jenkinsUrl}/job/cli-no-params/`,
            "--watch",
            "--json",
          ]),
        ).data.buildUrl;
        const readerEnv = {
          JENKINS_USER:
            process.env.JENKINS_INTEGRATION_READER_USER ?? "integration-reader",
          JENKINS_API_TOKEN: process.env.JENKINS_INTEGRATION_READER_TOKEN ?? "",
        };
        for (const [args, envOverrides, exitCode, code] of [
          [["--build-url", freestyle], {}, 4, "REPLAY_UNAVAILABLE"],
          [["--job-url", jobUrl, "--build", "99999"], {}, 4, "BUILD_NOT_FOUND"],
          [
            ["--build-url", sourceUrl],
            readerEnv,
            3,
            "REPLAY_PERMISSION_DENIED",
          ],
        ] as const) {
          const failed = await runCliExpectFailure(
            home,
            ["replay", ...args, "--script", scriptPath, "--json"],
            envOverrides,
          );
          expect(failed.exitCode, failed.output).toBe(exitCode);
          expect(JSON.parse(failed.stdout)).toMatchObject({
            ok: false,
            error: { code },
          });
        }
        expect(await latestBuildNumber(jobUrl)).toBe(editedNumber);
      });
    }, 180_000);

    test("edits a Pipeline job's script through config --apply", async () => {
      await withCliHome(async (home) => {
        const name = `cli-config-edit-${Date.now().toString(36)}`;
        const jobUrl = parseJson<{ data: { url: string } }>(
          await runCli(home, [
            "create",
            name,
            "--copy-from",
            "cli-pipeline",
            "--json",
          ]),
        ).data.url;
        const readConfig = async (): Promise<string> =>
          (await runCli(home, ["config", "--job-url", jobUrl])).stdout;

        const original = await readConfig();
        expect(original).toContain("pipeline-prepare");
        const configPath = join(home, "config.xml");
        await Bun.write(
          configPath,
          // Non-ASCII proves the POST is decoded as UTF-8, not ISO-8859-1.
          original.replace("pipeline-prepare", "pipeline-edited-café-✓"),
        );
        const applied = parseJson(
          await runCli(home, [
            "config",
            "--job-url",
            jobUrl,
            "--apply",
            configPath,
            "--json",
          ]),
        );
        expect(applied).toEqual({
          ok: true,
          command: "config",
          data: { url: jobUrl.replace(/\/$/, "") },
        });
        const edited = await readConfig();
        expect(edited).toContain("pipeline-edited-café-✓");
        expect(edited).not.toContain("pipeline-prepare");

        const built = await runCli(home, [
          "build",
          "--job-url",
          jobUrl,
          "--param",
          "BRANCH=main",
          "--watch",
        ]);
        expect(built.output).toContain("SUCCESS");
        const logs = await runCli(home, [
          "logs",
          "--job-url",
          jobUrl,
          "--plain",
        ]);
        expect(logs.output).toContain("pipeline-edited-café-✓");

        // Jenkins rejects XML it cannot parse and keeps the previous config.
        // Read it after the build: running a build re-saves the job.
        const beforeRejected = await readConfig();
        await Bun.write(configPath, "<flow-definition>");
        const rejected = await runCliExpectFailure(home, [
          "config",
          "--job-url",
          jobUrl,
          "--apply",
          configPath,
          "--json",
        ]);
        expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false });
        expect(await readConfig()).toBe(beforeRejected);
      });
    }, 120_000);

    test("blocks mutations for a protected profile until confirmed", async () => {
      await withCliHome(async (home) => {
        await writeProtectedProfile(home);
        const jobUrl = `${jenkinsUrl}/job/cli-no-params/`;

        const list = parseJson(
          await runCli(home, ["list", "--refresh", "--json"]),
        );
        expect(list).toMatchObject({ ok: true, command: "list" });

        const buildNumber = async (): Promise<number | null> => {
          const status = parseJson<{
            data: { build: { number: number } | null };
          }>(await runCli(home, ["status", "--job-url", jobUrl, "--json"]));
          return status.data.build?.number ?? null;
        };
        const before = await buildNumber();

        for (const args of [
          ["build", "--job-url", jobUrl, "--json"],
          ["cancel", "--job-url", jobUrl, "--json"],
          ["rerun", "--job-url", jobUrl, "--json"],
          [
            "replay",
            "--build-url",
            `${jobUrl}1/`,
            "--script",
            "Jenkinsfile",
            "--json",
          ],
          ["config", "--job-url", jobUrl, "--apply", "config.xml", "--json"],
          ["input", "approve", "--job-url", jobUrl, "--yes", "--json"],
          ["input", "abort", "--job-url", jobUrl, "--yes", "--json"],
          [
            "build",
            "--job-url",
            jobUrl,
            "--url",
            `${jenkinsUrl}/`,
            "--user",
            process.env.JENKINS_INTEGRATION_USER ?? "",
            "--token",
            process.env.JENKINS_INTEGRATION_TOKEN ?? "",
            "--json",
          ],
        ]) {
          const blocked = await runCliExpectFailure(home, args);
          expect(blocked.exitCode, blocked.output).toBe(5);
          expect(blocked.stdout.split("\n").filter(Boolean)).toHaveLength(1);
          expect(JSON.parse(blocked.stdout)).toEqual({
            ok: false,
            error: {
              message: 'Profile "release" is read-only.',
              code: "PROFILE_PROTECTED",
              hints: [
                "Re-run with --confirm-protected to allow builds, cancels, creates, config changes, reruns, replays, and input approvals or aborts.",
              ],
            },
          });
        }
        expect(await buildNumber()).toBe(before);

        const confirmed = parseJson<{ data: { result: string } }>(
          await runCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--watch",
            "--json",
            "--confirm-protected",
          ]),
        );
        expect(confirmed).toMatchObject({
          ok: true,
          command: "build",
          data: { result: "SUCCESS" },
        });
        expect(await buildNumber()).toBe((before ?? 0) + 1);
      });
    }, 120_000);

    test("build --watch, wait, status --watch, and replay --follow exit with a code per build result", async () => {
      await withCliHome(async (home) => {
        const jobUrl = `${jenkinsUrl}/job/cli-build-results/`;
        const scriptPath = join(home, "Jenkinsfile");
        for (const [outcome, exitCode] of [
          ["SUCCESS", 0],
          ["FAILURE", 1],
          ["UNSTABLE", 7],
          ["ABORTED", 8],
          ["NOT_BUILT", 9],
        ] as const) {
          const watched = await invokeCli(home, [
            "build",
            "--job-url",
            jobUrl,
            "--param",
            `OUTCOME=${outcome}`,
            "--watch",
            "--json",
          ]);
          expect(watched.exitCode, watched.output).toBe(exitCode);
          const receipt = parseJson<{
            data: { result: string; buildUrl: string };
          }>(watched);
          expect(receipt.data.result).toBe(outcome);

          const waited = await invokeCli(home, [
            "wait",
            "--build-url",
            receipt.data.buildUrl,
            "--json",
          ]);
          expect(waited.exitCode, waited.output).toBe(exitCode);
          expect(
            parseJson<{ data: { result: string } }>(waited).data.result,
          ).toBe(outcome);

          const status = await invokeCli(home, [
            "status",
            "--build-url",
            receipt.data.buildUrl,
            "--watch",
            "--non-interactive",
          ]);
          expect(status.exitCode, status.output).toBe(exitCode);

          // The replay copies OUTCOME from the source build.
          const printed = await runCli(home, [
            "replay",
            "--build-url",
            receipt.data.buildUrl,
            "--print-script",
          ]);
          await Bun.write(scriptPath, printed.stdout);
          const replayed = await invokeCli(home, [
            "replay",
            "--build-url",
            receipt.data.buildUrl,
            "--script",
            scriptPath,
            "--follow",
          ]);
          expect(replayed.exitCode, replayed.output).toBe(exitCode);
          expect(replayed.output).toContain(`finished: ${outcome}.`);
        }
      });
    }, 180_000);

    test("classifies failures by exit code and honors --quiet and --no-color", async () => {
      await withCliHome(async (home) => {
        const smokeUrl = `${jenkinsUrl}/job/cli-no-params/`;

        const usage = await invokeCli(home, [
          "logs",
          "--job-url",
          smokeUrl,
          "--context",
          "2",
        ]);
        expect(usage.exitCode, usage.output).toBe(2);
        expect(usage.stderr).toContain("ERROR: --context requires --grep.");

        const rejected = await invokeCli(
          home,
          ["status", "--job-url", smokeUrl, "--json"],
          { JENKINS_API_TOKEN: "not-the-integration-token" },
        );
        expect(rejected.exitCode, rejected.output).toBe(3);
        expect(parseJson(rejected)).toMatchObject({
          error: { code: "JENKINS_AUTH_ERROR" },
        });

        const missing = await invokeCli(home, [
          "status",
          "--job-url",
          `${jenkinsUrl}/job/cli-job-that-does-not-exist/`,
          "--json",
        ]);
        expect(missing.exitCode, missing.output).toBe(4);
        expect(parseJson(missing)).toMatchObject({
          error: { code: "JENKINS_NOT_FOUND" },
        });

        const unreachable = await invokeCli(
          home,
          ["status", "--job-url", "http://127.0.0.1:9/job/x/", "--json"],
          { JENKINS_URL: "http://127.0.0.1:9" },
        );
        expect(unreachable.exitCode, unreachable.output).toBe(6);
        expect(parseJson(unreachable)).toMatchObject({
          error: { code: "JENKINS_UNREACHABLE" },
        });

        const quietSuccess = await invokeCli(home, [
          "build",
          "--job-url",
          smokeUrl,
          "--without-params",
          "--watch",
          "--quiet",
        ]);
        expect(quietSuccess.exitCode, quietSuccess.output).toBe(0);
        expect(quietSuccess.stdout).toBe("");
        expect(quietSuccess.stderr).toBe("");

        const quietFailure = await invokeCli(home, [
          "build",
          "--job-url",
          `${jenkinsUrl}/job/cli-failure/`,
          "--param",
          "REASON=quiet-exit-code",
          "--watch",
          "--quiet",
        ]);
        expect(quietFailure.exitCode, quietFailure.output).toBe(1);
        expect(quietFailure.stdout).toBe("");
        expect(quietFailure.stderr).toBe("");

        const quietError = await invokeCli(home, [
          "status",
          "--job-url",
          `${jenkinsUrl}/job/cli-job-that-does-not-exist/`,
          "--quiet",
        ]);
        expect(quietError.exitCode, quietError.output).toBe(4);
        expect(quietError.stdout).toBe("");
        expect(quietError.stderr).toStartWith("ERROR: ");

        const forcedColor = { NO_COLOR: undefined, FORCE_COLOR: "1" };
        const colored = await runCli(
          home,
          ["status", "--job-url", smokeUrl],
          forcedColor,
        );
        expect(colored.stdout).toContain("\u001b[1mSUCCESS");
        const plain = await runCli(
          home,
          ["status", "--job-url", smokeUrl, "--no-color"],
          forcedColor,
        );
        expect(plain.stdout).toContain("SUCCESS");
        expect(plain.stdout).not.toContain("\u001b");
      });
    }, 120_000);

    test.skipIf(process.platform === "win32")(
      "prints several picked jobs' status in the order they were picked",
      async () => {
        await withCliHome(async (home) => {
          await runCli(home, ["list", "--refresh", "--json"]);
          // Picked out of name order: the output must follow the pick order.
          const picked = ["cli-never-built", "cli-exact", "cli-history"];
          const pickInput = picked
            .map((name, index) => {
              const clearPrevious = "\u007f".repeat(
                index === 0 ? 0 : picked[index - 1]!.length,
              );
              return `${clearPrevious}${name}\t`;
            })
            .join("");

          // `status --json` reads one job; picking several is interactive only.
          const session = await observeInteractiveCli(
            home,
            ["status", "--no-banner"],
            [
              {
                text: "Job name or description",
                input: `${pickInput}\r`,
              },
              { text: "Check another job?", input: "\r" },
            ],
          );

          // Earlier scenarios decide whether a job has builds yet.
          const positions = picked.map((name) =>
            session.output.search(
              new RegExp(
                `OK: (No builds found for|Last build for) ${name}[.:]`,
              ),
            ),
          );
          expect(
            positions.every((position) => position >= 0),
            session.output,
          ).toBe(true);
          expect(positions).toEqual(positions.toSorted((a, b) => a - b));
          expect(session.output.split("-".repeat(60)).length - 1).toBe(2);
        });
      },
      120_000,
    );

    test.skipIf(process.platform === "win32")(
      "keeps the interactive list action menu open after a protected block",
      async () => {
        await withCliHome(async (home) => {
          await writeProtectedProfile(home);
          await runCli(home, ["list", "--refresh", "--json"]);

          const session = await observeInteractiveCli(
            home,
            ["list", "--no-banner"],
            [
              {
                text: "Job name or description",
                input: "cli-no-params\r",
              },
              // Build is the first action: Enter triggers the blocked mutation.
              { text: "Action for cli-no-params", input: "\r" },
              // Synchronize after the completed action prompt, then observe the
              // repeated menu to prove the flow stayed on the selected job.
              {
                text: 'ERROR: Profile "release" is read-only.',
                input: "",
              },
              { text: "Action for cli-no-params", input: "" },
            ],
          );

          expect(session.output).toContain(
            'ERROR: Profile "release" is read-only.',
          );
          expect(session.output).toContain(
            "HINT: Re-run with --confirm-protected to allow builds, cancels, creates, config changes, reruns, replays, and input approvals or aborts.",
          );
        });
      },
      120_000,
    );
  },
);

async function writeProtectedProfile(home: string): Promise<void> {
  const configDir = join(home, ".config", "jenkins-cli");
  mkdirSync(configDir, { recursive: true });
  await Bun.write(
    join(configDir, "jenkins-cli-config.json"),
    `${JSON.stringify(
      {
        version: 2,
        defaultProfile: "release",
        profiles: {
          release: {
            jenkinsUrl: jenkinsUrl,
            jenkinsUser: process.env.JENKINS_INTEGRATION_USER,
            jenkinsApiToken: process.env.JENKINS_INTEGRATION_TOKEN,
            protected: true,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function findJobStatePath(home: string): Promise<string> {
  const glob = new Bun.Glob("**/jenkins-cli/state-*.json");
  for await (const match of glob.scan({ cwd: home, dot: true })) {
    return join(home, match);
  }
  throw new Error(`No job state written under ${home}`);
}
