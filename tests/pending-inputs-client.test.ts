import { afterEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import { JenkinsClient } from "../src/jenkins/client";

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const BASE_URL = "https://jenkins.example.com";
const BUILD_URL = `${BASE_URL}/job/deploy/128/`;
const PENDING_URL = `${BUILD_URL}wfapi/pendingInputActions`;
const PROCEED_URL = `${BUILD_URL}wfapi/inputSubmit?inputId=Release`;
const ABORT_URL = `${BUILD_URL}input/Release/abort`;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function createClient(useCrumb = false): JenkinsClient {
  return new JenkinsClient({
    baseUrl: BASE_URL,
    user: "user",
    apiToken: "token",
    timeoutMs: 1_000,
    useCrumb,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function redirectResponse(location: string): Response {
  return new Response("", { status: 302, headers: { location } });
}

function installFetch(
  handler: (input: FetchInput, init?: FetchInit) => Promise<Response>,
) {
  const fetchMock = mock(handler);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function headerValue(init: FetchInit, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  if (!headers) {
    return undefined;
  }
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : undefined;
}

async function captureError(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to throw.");
}

describe("JenkinsClient.listPendingInputActions", () => {
  test("normalizes the pipeline-rest-api payload against the build URL", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse([
        {
          id: "Release",
          proceedText: "Ship it",
          message: "Deploy to production?",
          inputs: [],
          proceedUrl: "/job/deploy/128/wfapi/inputSubmit?inputId=Release",
          abortUrl: "/job/deploy/128/input/Release/abort",
          redirectApprovalUrl: "/job/deploy/128/input/",
        },
      ]),
    );

    const actions = await createClient().listPendingInputActions(BUILD_URL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(PENDING_URL);
    expect(actions).toEqual([
      {
        id: "Release",
        message: "Deploy to production?",
        proceedText: "Ship it",
        parameters: [],
        proceedUrl: PROCEED_URL,
        abortUrl: ABORT_URL,
        approvalUrl: `${BUILD_URL}input/`,
      },
    ]);
  });

  test("returns an empty list only for a successful JSON array", async () => {
    installFetch(async () => jsonResponse([]));
    expect(await createClient().listPendingInputActions(BUILD_URL)).toEqual([]);
  });

  test("maps a 404 to PIPELINE_INPUT_UNSUPPORTED instead of an empty list", async () => {
    installFetch(async () => new Response("Not Found", { status: 404 }));
    const error = await captureError(() =>
      createClient().listPendingInputActions(BUILD_URL),
    );
    expect(error.code).toBe("PIPELINE_INPUT_UNSUPPORTED");
    expect(error.message).toContain("HTTP 404");
  });

  test("rejects an HTML body even with HTTP 200", async () => {
    installFetch(
      async () =>
        new Response("<!DOCTYPE html><html><body>Sign in</body></html>", {
          status: 200,
          headers: { "content-type": "text/html;charset=utf-8" },
        }),
    );
    const error = await captureError(() =>
      createClient().listPendingInputActions(BUILD_URL),
    );
    expect(error.code).toBe("PIPELINE_INPUT_INVALID_RESPONSE");
    expect(error.message).toContain("HTML page");
  });

  test("does not follow redirects and reports them as a login redirect", async () => {
    const fetchMock = installFetch(async () =>
      redirectResponse(`${BASE_URL}/login`),
    );
    const error = await captureError(() =>
      createClient().listPendingInputActions(BUILD_URL),
    );
    expect(error.code).toBe("JENKINS_LOGIN_REDIRECT");
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  test("rejects non-array JSON and malformed JSON", async () => {
    installFetch(async () => jsonResponse({ status: "ok" }));
    expect(
      (
        await captureError(() =>
          createClient().listPendingInputActions(BUILD_URL),
        )
      ).code,
    ).toBe("PIPELINE_INPUT_INVALID_RESPONSE");

    installFetch(
      async () =>
        new Response("[{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(
      (
        await captureError(() =>
          createClient().listPendingInputActions(BUILD_URL),
        )
      ).code,
    ).toBe("PIPELINE_INPUT_INVALID_RESPONSE");
  });

  test("keeps auth failures as JENKINS_AUTH_ERROR", async () => {
    installFetch(async () => new Response("Forbidden", { status: 403 }));
    const error = await captureError(() =>
      createClient().listPendingInputActions(BUILD_URL),
    );
    expect(error.code).toBe("JENKINS_AUTH_ERROR");
  });
});

describe("JenkinsClient.submitPendingInput", () => {
  test("approves through the proceed URL with an empty json form field", async () => {
    const fetchMock = installFetch(
      async () => new Response("", { status: 200 }),
    );

    const result = await createClient().submitPendingInput({
      url: PROCEED_URL,
      operation: "approve",
    });

    expect(result).toEqual({ outcome: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(PROCEED_URL);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("json=%7B%7D");
    expect(headerValue(init, "content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("aborts through the abort URL without a body", async () => {
    const fetchMock = installFetch(
      async () => new Response("", { status: 200 }),
    );

    const result = await createClient().submitPendingInput({
      url: ABORT_URL,
      operation: "abort",
    });

    expect(result).toEqual({ outcome: "accepted" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(ABORT_URL);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(headerValue(init, "content-type")).toBeUndefined();
  });

  test("never transport-retries and reports a lost response as unconfirmed", async () => {
    for (const operation of ["approve", "abort"] as const) {
      const fetchMock = installFetch(async () => {
        throw new TypeError("socket hang up");
      });

      const result = await createClient().submitPendingInput({
        url: operation === "approve" ? PROCEED_URL : ABORT_URL,
        operation,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe("unconfirmed");
      if (result.outcome === "unconfirmed") {
        expect(result.reason).toContain("Network error");
      }
    }
  });

  test("reports a timeout as unconfirmed after a single attempt", async () => {
    const fetchMock = installFetch(async (_input, init) => {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
        setTimeout(resolve, 5_000);
      });
      return new Response("", { status: 200 });
    });
    const client = new JenkinsClient({
      baseUrl: BASE_URL,
      user: "user",
      apiToken: "token",
      timeoutMs: 20,
    });

    const result = await client.submitPendingInput({
      url: PROCEED_URL,
      operation: "approve",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("unconfirmed");
    if (result.outcome === "unconfirmed") {
      expect(result.reason).toContain("timed out");
    }
  });

  test("returns the HTTP status and readable detail for a rejection", async () => {
    installFetch(
      async () =>
        new Response(
          "<html><body><h1>Error</h1><p>You need to have Job/Build permissions to submit this.</p></body></html>",
          { status: 400, headers: { "content-type": "text/html" } },
        ),
    );

    const result = await createClient().submitPendingInput({
      url: PROCEED_URL,
      operation: "approve",
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.httpStatus).toBe(400);
      expect(result.kind).toBe("http_error");
      expect(result.detail).toContain(
        "You need to have Job/Build permissions to submit this.",
      );
    }
  });

  test("never follows a redirect on submit and treats it as a rejection", async () => {
    const fetchMock = installFetch(async () =>
      redirectResponse(`${BASE_URL}/login`),
    );

    const result = await createClient().submitPendingInput({
      url: ABORT_URL,
      operation: "abort",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(result).toEqual({
      outcome: "rejected",
      httpStatus: 302,
      kind: "redirect",
      detail: `redirected to ${BASE_URL}/login`,
    });
  });

  test("rejects a 2xx HTML page instead of reporting success", async () => {
    for (const operation of ["approve", "abort"] as const) {
      installFetch(
        async () =>
          new Response("<!DOCTYPE html><html><body>Sign in</body></html>", {
            status: 200,
            headers: { "content-type": "text/html;charset=utf-8" },
          }),
      );

      const result = await createClient().submitPendingInput({
        url: operation === "approve" ? PROCEED_URL : ABORT_URL,
        operation,
      });

      expect(result).toEqual({
        outcome: "rejected",
        httpStatus: 200,
        kind: "html_page",
        detail: "received an HTML page instead of a Jenkins response",
      });
    }
  });

  test("accepts Jenkins' empty and JSON success bodies", async () => {
    for (const body of ["", "null", "{}"]) {
      installFetch(
        async () =>
          new Response(body, {
            status: 200,
            headers: body ? { "content-type": "application/json" } : {},
          }),
      );
      expect(
        await createClient().submitPendingInput({
          url: PROCEED_URL,
          operation: "approve",
        }),
      ).toEqual({ outcome: "accepted" });
    }
  });

  test("treats gateway errors as unconfirmed, not rejected", async () => {
    for (const status of [502, 503, 504]) {
      const fetchMock = installFetch(
        async () => new Response("Bad Gateway", { status }),
      );
      const result = await createClient().submitPendingInput({
        url: ABORT_URL,
        operation: "abort",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe("unconfirmed");
      if (result.outcome === "unconfirmed") {
        expect(result.reason).toContain(`HTTP ${status}`);
      }
    }
  });

  test("refreshes the crumb once after a 403 and resubmits", async () => {
    let postCount = 0;
    const fetchMock = installFetch(async (input) => {
      const url = String(input);
      if (url.includes("crumbIssuer/api/json")) {
        return jsonResponse({
          crumbRequestField: "Jenkins-Crumb",
          crumb: `crumb-${fetchMock.mock.calls.length}`,
        });
      }
      postCount += 1;
      return postCount === 1
        ? new Response("No valid crumb was included in the request", {
            status: 403,
          })
        : new Response("", { status: 200 });
    });

    const result = await createClient(true).submitPendingInput({
      url: PROCEED_URL,
      operation: "approve",
    });

    expect(result).toEqual({ outcome: "accepted" });
    // crumb, POST(403), crumb, POST(200)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstPost = fetchMock.mock.calls[1];
    const secondPost = fetchMock.mock.calls[3];
    expect(headerValue(firstPost?.[1], "Jenkins-Crumb")).toBe("crumb-1");
    expect(headerValue(secondPost?.[1], "Jenkins-Crumb")).toBe("crumb-3");
  });

  test("surfaces a crumb fetch failure as an error rather than an unconfirmed submission", async () => {
    const fetchMock = installFetch(async () => {
      throw new TypeError("connect ECONNREFUSED");
    });

    await expect(
      createClient(true).submitPendingInput({
        url: PROCEED_URL,
        operation: "approve",
      }),
    ).rejects.toThrow("Network error while trying to fetch crumb.");
    // crumb GET keeps its single transport retry; no POST was ever sent.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
