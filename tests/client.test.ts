import { afterEach, describe, expect, mock, test } from "bun:test";
import { JenkinsClient } from "../src/jenkins/client";

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

function readHeader(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const entries = headers as Array<[string, string]>;
    const lower = name.toLowerCase();
    const entry = entries.find(([key]) => key.toLowerCase() === lower);
    return entry?.[1];
  }
  const objectHeaders = headers as Record<string, string | readonly string[]>;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(objectHeaders)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return undefined;
}

describe("JenkinsClient triggerBuild", () => {
  test("uses buildWithParameters when params are provided", async () => {
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
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
      useCrumb: true,
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
    const fetchMock = mock(async (_input: FetchInput, _init?: FetchInit) => {
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
      useCrumb: true,
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

  test("refreshes crumb and retries trigger when first attempt gets 403", async () => {
    let crumbRequestCount = 0;
    let triggerRequestCount = 0;

    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (url.includes("crumbIssuer/api/json")) {
        crumbRequestCount += 1;
        return new Response(
          JSON.stringify({
            crumbRequestField: "Jenkins-Crumb",
            crumb: crumbRequestCount === 1 ? "stale-crumb" : "fresh-crumb",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/build?delay=0sec")) {
        triggerRequestCount += 1;
        return new Response("", {
          status: triggerRequestCount === 1 ? 403 : 201,
        });
      }
      return new Response("", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
      useCrumb: true,
    });

    await client.triggerBuild("https://jenkins.example.com/job/my-job", {});

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstTriggerCall = fetchMock.mock.calls[1];
    const secondTriggerCall = fetchMock.mock.calls[3];
    expect(firstTriggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/build?delay=0sec",
    );
    expect(secondTriggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/build?delay=0sec",
    );
    expect(
      readHeader(
        firstTriggerCall?.[1] as RequestInit | undefined,
        "Jenkins-Crumb",
      ),
    ).toBe("stale-crumb");
    expect(
      readHeader(
        secondTriggerCall?.[1] as RequestInit | undefined,
        "Jenkins-Crumb",
      ),
    ).toBe("fresh-crumb");
  });

  test("keeps crumb disabled by default and posts without crumb lookup", async () => {
    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (url.includes("crumbIssuer/api/json")) {
        return new Response("", { status: 500 });
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const triggerCall = fetchMock.mock.calls[0];
    expect(triggerCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/build?delay=0sec",
    );
    expect(
      readHeader(triggerCall?.[1] as RequestInit | undefined, "Jenkins-Crumb"),
    ).toBeUndefined();
  });
});

describe("JenkinsClient POST with crumb", () => {
  test("refreshes crumb and retries stopBuild when first attempt gets 403", async () => {
    let crumbRequestCount = 0;
    let stopRequestCount = 0;

    const fetchMock = mock(async (input: FetchInput, _init?: FetchInit) => {
      const url = String(input);
      if (url.includes("crumbIssuer/api/json")) {
        crumbRequestCount += 1;
        return new Response(
          JSON.stringify({
            crumbRequestField: "Jenkins-Crumb",
            crumb: crumbRequestCount === 1 ? "stale-crumb" : "fresh-crumb",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/stop")) {
        stopRequestCount += 1;
        return new Response("", {
          status: stopRequestCount === 1 ? 403 : 200,
        });
      }
      return new Response("", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new JenkinsClient({
      baseUrl: "https://jenkins.example.com",
      user: "user",
      apiToken: "token",
      timeoutMs: 1_000,
      useCrumb: true,
    });

    await client.stopBuild("https://jenkins.example.com/job/my-job/123/");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstStopCall = fetchMock.mock.calls[1];
    const secondStopCall = fetchMock.mock.calls[3];
    expect(firstStopCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/123/stop",
    );
    expect(secondStopCall?.[0]).toBe(
      "https://jenkins.example.com/job/my-job/123/stop",
    );
    expect(
      readHeader(
        firstStopCall?.[1] as RequestInit | undefined,
        "Jenkins-Crumb",
      ),
    ).toBe("stale-crumb");
    expect(
      readHeader(
        secondStopCall?.[1] as RequestInit | undefined,
        "Jenkins-Crumb",
      ),
    ).toBe("fresh-crumb");
  });
});
