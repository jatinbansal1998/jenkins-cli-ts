import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { JenkinsClient } from "../src/jenkins/client";
import { setDebugMode } from "../src/logger";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let appendSpy: ReturnType<typeof spyOn<typeof fs, "appendFileSync">>;
let existsSpy: ReturnType<typeof spyOn<typeof fs, "existsSync">>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          property: [
            {
              parameterDefinitions: [
                {
                  _class: "hudson.model.StringParameterDefinition",
                  name: "BRANCH",
                  defaultParameterValue: { value: "main" },
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as unknown as typeof fetch);
  appendSpy = spyOn(fs, "appendFileSync").mockImplementation(() => undefined);
  existsSpy = spyOn(fs, "existsSync").mockImplementation(() => true);
});

afterEach(() => {
  setDebugMode(false);
  fetchSpy.mockRestore();
  appendSpy.mockRestore();
  existsSpy.mockRestore();
});

describe("JenkinsClient parameter discovery", () => {
  test("uses the complete folder and multibranch job URL with a narrow API tree", async () => {
    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com/",
      user: "ci",
      apiToken: "token",
    });
    const definitions = await client.getJobParameterDefinitions(
      "https://jenkins.example.com/job/team%20one/job/api/job/PR-42/",
    );

    expect(definitions[0]).toEqual(
      expect.objectContaining({
        name: "BRANCH",
        type: "string",
        defaultValue: "main",
      }),
    );
    const requestUrl = String(fetchSpy.mock.calls[0]?.[0]);
    const parsed = new URL(requestUrl);
    expect(parsed.pathname).toBe("/job/team%20one/job/api/job/PR-42/api/json");
    expect(parsed.searchParams.get("tree")).toContain(
      "property[_class,parameterDefinitions[",
    );
    expect(parsed.searchParams.get("tree")).not.toContain("builds");
  });

  test("does not persist Jenkins response bodies containing secret defaults", async () => {
    setDebugMode(true);
    fetchSpy.mockImplementationOnce((async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            property: [
              {
                parameterDefinitions: [
                  {
                    _class: "hudson.model.PasswordParameterDefinition",
                    name: "TOKEN",
                    defaultParameterValue: { value: "server-side-secret" },
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch);
    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com/",
      user: "ci",
      apiToken: "token",
    });
    await client.getJobParameterDefinitions(
      "https://jenkins.example.com/job/api/",
    );

    const logged = appendSpy.mock.calls.map((call) => String(call[1])).join("");
    expect(logged).not.toContain("server-side-secret");
  });

  test("does not persist secret build parameter request bodies", async () => {
    setDebugMode(true);
    fetchSpy.mockImplementationOnce((async () =>
      Promise.resolve(
        new Response("queued", { status: 201 }),
      )) as unknown as typeof fetch);
    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com/",
      user: "ci",
      apiToken: "token",
    });
    await client.triggerBuild("https://jenkins.example.com/job/api/", {
      TOKEN: "local-secret-value",
    });

    const logged = appendSpy.mock.calls.map((call) => String(call[1])).join("");
    expect(logged).toContain("Body:\n  <omitted>");
    expect(logged).not.toContain("local-secret-value");
  });
});
