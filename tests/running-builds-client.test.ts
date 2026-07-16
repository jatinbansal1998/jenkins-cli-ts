import { afterEach, describe, expect, mock, test } from "bun:test";
import { JenkinsClient } from "../src/jenkins/client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const FOLDER_CLASS = "com.cloudbees.hudson.plugins.folder.Folder";
const JOB_CLASS = "hudson.model.FreeStyleProject";

test("normalizes, sorts, and deduplicates running builds in nested folders", async () => {
  const fetchMock = mock(async (_input: Parameters<typeof fetch>[0]) =>
    Response.json({
      jobs: [
        {
          _class: JOB_CLASS,
          name: "zeta",
          fullName: "zeta",
          url: "https://jenkins.example.com/job/zeta/",
          lastBuild: {
            number: 8,
            url: "https://jenkins.example.com/job/zeta/8/",
            building: true,
          },
        },
        {
          _class: FOLDER_CLASS,
          name: "apps",
          url: "https://jenkins.example.com/job/apps/",
          jobs: [
            {
              _class: JOB_CLASS,
              name: "api",
              fullName: "apps/api",
              url: "https://jenkins.example.com/job/apps/job/api/",
              lastBuild: {
                number: 12,
                url: "https://jenkins.example.com/job/apps/job/api/12/",
                building: true,
              },
            },
            {
              _class: JOB_CLASS,
              name: "api-copy",
              fullName: "apps/api-copy",
              url: "https://jenkins.example.com/job/apps/job/api-copy/",
              lastBuild: {
                number: 12,
                url: "https://jenkins.example.com/job/apps/job/api/12",
                building: true,
              },
            },
            {
              _class: JOB_CLASS,
              name: "finished",
              url: "https://jenkins.example.com/job/finished/",
              lastBuild: {
                number: 2,
                url: "https://jenkins.example.com/job/finished/2/",
                building: false,
              },
            },
            {
              _class: JOB_CLASS,
              name: "malformed",
              url: "https://jenkins.example.com/job/malformed/",
              lastBuild: { building: true },
            },
          ],
        },
      ],
    }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const client = new JenkinsClient({
    baseUrl: "https://jenkins.example.com",
    user: "user",
    apiToken: "token",
  });

  await expect(client.listRunningBuilds()).resolves.toEqual([
    {
      jobName: "api",
      fullJobName: "apps/api",
      jobUrl: "https://jenkins.example.com/job/apps/job/api/",
      buildNumber: 12,
      buildUrl: "https://jenkins.example.com/job/apps/job/api/12/",
    },
    {
      jobName: "zeta",
      fullJobName: "zeta",
      jobUrl: "https://jenkins.example.com/job/zeta/",
      buildNumber: 8,
      buildUrl: "https://jenkins.example.com/job/zeta/8/",
    },
  ]);

  expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
    "lastBuild[number,url,building]",
  );
});

describe("running-build folder fallback", () => {
  test("fetches folder children when they are not inline", async () => {
    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.startsWith("https://jenkins.example.com/api/json")) {
        return Response.json({
          jobs: [
            {
              _class: FOLDER_CLASS,
              name: "apps",
              url: "https://jenkins.example.com/job/apps/",
            },
          ],
        });
      }
      return Response.json({
        jobs: [
          {
            _class: JOB_CLASS,
            name: "api",
            fullName: "apps/api",
            url: "https://jenkins.example.com/job/apps/job/api/",
            lastBuild: {
              number: 3,
              url: "https://jenkins.example.com/job/apps/job/api/3/",
              building: true,
            },
          },
        ],
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const builds = await new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
    }).listRunningBuilds();

    expect(builds).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
