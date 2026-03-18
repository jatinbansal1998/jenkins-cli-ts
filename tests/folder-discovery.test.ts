import { afterEach, describe, expect, mock, test } from "bun:test";
import { JenkinsClient } from "../src/jenkins/client";

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

const FOLDER_CLASS = "com.cloudbees.hudson.plugins.folder.Folder";
const FREESTYLE_CLASS = "hudson.model.FreeStyleProject";

function makeClient(): JenkinsClient {
  return new JenkinsClient({
    baseUrl: "https://jenkins.example.com",
    user: "user",
    apiToken: "token",
    timeoutMs: 2_000,
  });
}

describe("JenkinsClient folder discovery", () => {
  test("returns root-level jobs when no folders present", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (url.includes("/api/json") && url.includes("tree=jobs[")) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FREESTYLE_CLASS,
                name: "root-job",
                fullName: "root-job",
                url: "https://jenkins.example.com/job/root-job/",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toEqual([
      {
        name: "root-job",
        fullName: "root-job",
        url: "https://jenkins.example.com/job/root-job/",
      },
    ]);
  });

  test("discovers jobs inside a CloudBees folder with inline children", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FREESTYLE_CLASS,
                name: "root-job",
                fullName: "root-job",
                url: "https://jenkins.example.com/job/root-job/",
              },
              {
                _class: FOLDER_CLASS,
                name: "StagingFolder",
                fullName: "StagingFolder",
                url: "https://jenkins.example.com/job/StagingFolder/",
                jobs: [
                  {
                    _class: FREESTYLE_CLASS,
                    name: "staging-api",
                    fullName: "StagingFolder/staging-api",
                    url: "https://jenkins.example.com/job/StagingFolder/job/staging-api/",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs).toEqual([
      {
        name: "root-job",
        fullName: "root-job",
        url: "https://jenkins.example.com/job/root-job/",
      },
      {
        name: "staging-api",
        fullName: "StagingFolder/staging-api",
        url: "https://jenkins.example.com/job/StagingFolder/job/staging-api/",
      },
    ]);
  });

  test("discovers jobs inside nested folders (folder within folder)", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FOLDER_CLASS,
                name: "Env",
                fullName: "Env",
                url: "https://jenkins.example.com/job/Env/",
                jobs: [
                  {
                    _class: FOLDER_CLASS,
                    name: "Staging",
                    fullName: "Env/Staging",
                    url: "https://jenkins.example.com/job/Env/job/Staging/",
                    jobs: [
                      {
                        _class: FREESTYLE_CLASS,
                        name: "deploy",
                        fullName: "Env/Staging/deploy",
                        url: "https://jenkins.example.com/job/Env/job/Staging/job/deploy/",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      name: "deploy",
      fullName: "Env/Staging/deploy",
      url: "https://jenkins.example.com/job/Env/job/Staging/job/deploy/",
    });
  });

  test("deduplicates jobs by normalized URL (trailing slash differences)", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FREESTYLE_CLASS,
                name: "api-job",
                fullName: "api-job",
                url: "https://jenkins.example.com/job/api-job/",
              },
              {
                _class: FREESTYLE_CLASS,
                name: "api-job",
                fullName: "api-job",
                url: "https://jenkins.example.com/job/api-job",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("api-job");
  });

  test("fetches folder children from folder URL when inline jobs not present", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FOLDER_CLASS,
                name: "ProdFolder",
                fullName: "ProdFolder",
                url: "https://jenkins.example.com/job/ProdFolder/",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (
        url.startsWith("https://jenkins.example.com/job/ProdFolder/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FREESTYLE_CLASS,
                name: "prod-deploy",
                fullName: "ProdFolder/prod-deploy",
                url: "https://jenkins.example.com/job/ProdFolder/job/prod-deploy/",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      name: "prod-deploy",
      fullName: "ProdFolder/prod-deploy",
      url: "https://jenkins.example.com/job/ProdFolder/job/prod-deploy/",
    });
  });

  test("preserves fullName for disambiguation of folder jobs", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FREESTYLE_CLASS,
                name: "deploy",
                fullName: "deploy",
                url: "https://jenkins.example.com/job/deploy/",
              },
              {
                _class: FOLDER_CLASS,
                name: "Staging",
                fullName: "Staging",
                url: "https://jenkins.example.com/job/Staging/",
                jobs: [
                  {
                    _class: FREESTYLE_CLASS,
                    name: "deploy",
                    fullName: "Staging/deploy",
                    url: "https://jenkins.example.com/job/Staging/job/deploy/",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.fullName).toBe("deploy");
    expect(jobs[1]?.fullName).toBe("Staging/deploy");
  });

  test("skips folder items without _class field (not treated as folder)", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                name: "plain-job",
                fullName: "plain-job",
                url: "https://jenkins.example.com/job/plain-job/",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("plain-job");
  });

  test("does not recurse into non-folder container types", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class:
                  "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
                name: "multibranch-project",
                fullName: "multibranch-project",
                url: "https://jenkins.example.com/job/multibranch-project/",
                jobs: [
                  {
                    _class: FREESTYLE_CLASS,
                    name: "should-not-appear",
                    url: "https://jenkins.example.com/job/multibranch-project/job/should-not-appear/",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("multibranch-project");
    expect(jobs[0]?.url).toBe(
      "https://jenkins.example.com/job/multibranch-project/",
    );
  });

  test("propagates folder traversal errors (does not swallow them)", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FOLDER_CLASS,
                name: "BrokenFolder",
                fullName: "BrokenFolder",
                url: "https://jenkins.example.com/job/BrokenFolder/",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (
        url.startsWith("https://jenkins.example.com/job/BrokenFolder/api/json")
      ) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(makeClient().listJobs()).rejects.toThrow();
  });

  test("mixed root jobs, folder jobs, and nested folders all discovered", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (
        url.startsWith("https://jenkins.example.com/api/json") &&
        url.includes("tree=jobs[")
      ) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                _class: FREESTYLE_CLASS,
                name: "root-build",
                fullName: "root-build",
                url: "https://jenkins.example.com/job/root-build/",
              },
              {
                _class: FOLDER_CLASS,
                name: "Consumer",
                fullName: "Consumer",
                url: "https://jenkins.example.com/job/Consumer/",
                jobs: [
                  {
                    _class: FREESTYLE_CLASS,
                    name: "order-processor",
                    fullName: "Consumer/order-processor",
                    url: "https://jenkins.example.com/job/Consumer/job/order-processor/",
                  },
                  {
                    _class: FOLDER_CLASS,
                    name: "SubFolder",
                    fullName: "Consumer/SubFolder",
                    url: "https://jenkins.example.com/job/Consumer/job/SubFolder/",
                    jobs: [
                      {
                        _class: FREESTYLE_CLASS,
                        name: "deep-job",
                        fullName: "Consumer/SubFolder/deep-job",
                        url: "https://jenkins.example.com/job/Consumer/job/SubFolder/job/deep-job/",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jobs = await makeClient().listJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.fullName)).toEqual([
      "root-build",
      "Consumer/order-processor",
      "Consumer/SubFolder/deep-job",
    ]);
  });
});
