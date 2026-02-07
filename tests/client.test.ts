import { afterEach, describe, expect, mock, test } from "bun:test";
import { JenkinsClient } from "../src/jenkins/client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe("JenkinsClient triggerBuild", () => {
  test("uses buildWithParameters when params are provided", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL) => {
      if (
        typeof _input === "string" &&
        _input.includes("crumbIssuer/api/json")
      ) {
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    await client.triggerBuild("https://jenkins.example.com/job/my-job", {
      BRANCH: "main",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const triggerCall = fetchMock.mock.calls[1];
    expect(triggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/buildWithParameters?delay=0sec",
    );
    expect((triggerCall?.[1] as RequestInit | undefined)?.method).toBe("POST");
    expect((triggerCall?.[1] as RequestInit | undefined)?.body).toBe(
      "BRANCH=main",
    );
  });

  test("uses build endpoint when no params are provided", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL) => {
      if (
        typeof _input === "string" &&
        _input.includes("crumbIssuer/api/json")
      ) {
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
    });

    await client.triggerBuild("https://jenkins.example.com/job/my-job", {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const triggerCall = fetchMock.mock.calls[1];
    expect(triggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/build?delay=0sec",
    );
    expect((triggerCall?.[1] as RequestInit | undefined)?.method).toBe("POST");
    expect((triggerCall?.[1] as RequestInit | undefined)?.body).toBeUndefined();
  });
});
