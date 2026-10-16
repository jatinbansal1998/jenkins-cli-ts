import { afterEach, describe, expect, mock, test } from "bun:test";
import { CliError } from "../src/cli";
import { JenkinsClient } from "../src/jenkins/client";

const realFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const BASE_URL = "https://jenkins.example.com/jenkins";
const JOB_URL = `${BASE_URL}/job/deploy/`;
const BUILD_URL = `${JOB_URL}12/`;
const REPLAY_PAGE_URL = `${BUILD_URL}replay/`;
const REPLAY_RUN_URL = `${BUILD_URL}replay/run`;
const CRUMB_URL = `${BASE_URL}/crumbIssuer/api/json`;

/** The Replay form as Jenkins 2.568.1 renders it, trimmed to the textareas. */
const REPLAY_PAGE = `<!DOCTYPE html><html><body>
<form method="POST" autocomplete="off" name="config" action="run">
<textarea checkDependsOn="" name="_.mainScript" checkMethod="post" rows="6" class="jenkins-input validated  " checkUrl="/jenkins/job/deploy/12/replay/checkScript">
node {
  echo "a &lt;b&gt; &amp;&amp; c > d &quot;q&quot; &#39;s&#39; &#x2603;"
}
</textarea>
<textarea checkDependsOn="" name="_.Script1" checkMethod="post" rows="5" class="jenkins-input validated  " checkUrl="/jenkins/job/deploy/12/replay/checkLoadedScript">def greet(n) { echo n }; return this</textarea>
<textarea name="unrelated">ignored</textarea>
</form></body></html>`;

const REBUILD_ONLY_PAGE = `<!DOCTYPE html><html><body>
<form method="POST" autocomplete="off" name="rebuild" action="rebuild"></form>
</body></html>`;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function createClient(useCrumb = false): JenkinsClient {
  return new JenkinsClient({
    baseUrl: BASE_URL,
    user: "Alice",
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

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}

function redirectResponse(location: string): Response {
  return new Response("", { status: 302, headers: { location } });
}

function installFetch(
  handler: (url: string, init?: FetchInit) => Promise<Response>,
) {
  const fetchMock = mock((input: FetchInput, init?: FetchInit) =>
    handler(String(input), init),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function headerValue(init: FetchInit, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

function postedForm(init: FetchInit): unknown {
  const json = new URLSearchParams(String(init?.body)).get("json");
  return JSON.parse(json ?? "null");
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

describe("JenkinsClient.getReplayScripts", () => {
  test("reads the main and loaded scripts from the Replay form", async () => {
    const fetchMock = installFetch(async () => htmlResponse(REPLAY_PAGE));

    const scripts = await createClient().getReplayScripts(BUILD_URL);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(REPLAY_PAGE_URL);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(scripts).toEqual({
      mainScript: 'node {\n  echo "a <b> && c > d "q" \'s\' ☃"\n}\n',
      loadedScripts: { Script1: "def greet(n) { echo n }; return this" },
    });
  });

  test("keeps a script's own leading newline and never decodes twice", async () => {
    installFetch(async () =>
      htmlResponse(
        `<textarea name="_.mainScript">\n\necho '&amp;lt;'</textarea>`,
      ),
    );

    const scripts = await createClient().getReplayScripts(BUILD_URL);

    expect(scripts.mainScript).toBe("\necho '&lt;'");
  });

  test("reports a build that does not exist", async () => {
    installFetch(async () => htmlResponse("Not found", 404));

    const error = await captureError(() =>
      createClient().getReplayScripts(BUILD_URL),
    );

    expect(error.code).toBe("BUILD_NOT_FOUND");
  });

  test("reports an existing build without a Replay page", async () => {
    installFetch(async (url) =>
      url === REPLAY_PAGE_URL
        ? htmlResponse("Not found", 404)
        : jsonResponse({ number: 12 }),
    );

    const error = await captureError(() =>
      createClient().getReplayScripts(BUILD_URL),
    );

    expect(error.code).toBe("REPLAY_UNAVAILABLE");
    expect(error.hints.join(" ")).toContain("Pipeline");
  });

  test("reports a page that offers only an unchanged rebuild", async () => {
    installFetch(async () => htmlResponse(REBUILD_ONLY_PAGE));

    const error = await captureError(() =>
      createClient().getReplayScripts(BUILD_URL),
    );

    expect(error.code).toBe("REPLAY_PERMISSION_DENIED");
    expect(error.hints.join(" ")).toContain("Run/Replay");
  });

  test("reports a login redirect instead of a page without scripts", async () => {
    installFetch(async () => redirectResponse(`${BASE_URL}/login`));

    const error = await captureError(() =>
      createClient().getReplayScripts(BUILD_URL),
    );

    expect(error.code).toBe("JENKINS_LOGIN_REDIRECT");
  });

  test("reports any other page as an invalid response", async () => {
    installFetch(async () => htmlResponse("<html>Sign in</html>"));

    const error = await captureError(() =>
      createClient().getReplayScripts(BUILD_URL),
    );

    expect(error.code).toBe("JENKINS_INVALID_RESPONSE");
  });
});

describe("JenkinsClient.replayBuild", () => {
  const scripts = {
    mainScript: "echo 'edited'",
    loadedScripts: { Script1: "return this" },
  };

  test("posts the whole form as the json field and accepts the redirect to the job", async () => {
    const fetchMock = installFetch(async () =>
      redirectResponse("/jenkins/job/deploy/"),
    );

    const submission = await createClient().replayBuild({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts,
    });

    expect(submission).toEqual({ outcome: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(REPLAY_RUN_URL);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(headerValue(init, "Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(postedForm(init)).toEqual({
      Script1: "return this",
      mainScript: "echo 'edited'",
    });
  });

  test("sends the crumb and refreshes it once after a 403", async () => {
    const crumbs = ["stale", "fresh"];
    const posts: (string | undefined)[] = [];
    installFetch(async (url, init) => {
      if (url === CRUMB_URL) {
        return jsonResponse({
          crumbRequestField: "Jenkins-Crumb",
          crumb: crumbs.shift(),
        });
      }
      posts.push(headerValue(init, "Jenkins-Crumb"));
      return posts.length === 1
        ? htmlResponse("No valid crumb", 403)
        : redirectResponse(JOB_URL);
    });

    const submission = await createClient(true).replayBuild({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts,
    });

    expect(submission).toEqual({ outcome: "accepted" });
    expect(posts).toEqual(["stale", "fresh"]);
  });

  test("reports a second 403 as a rejection", async () => {
    installFetch(async (url) =>
      url === CRUMB_URL
        ? jsonResponse({ crumbRequestField: "Jenkins-Crumb", crumb: "c" })
        : htmlResponse("Access Denied", 403),
    );

    const submission = await createClient(true).replayBuild({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts,
    });

    expect(submission).toMatchObject({
      outcome: "rejected",
      httpStatus: 403,
      kind: "http_error",
    });
  });

  test("never resends the POST when the connection fails", async () => {
    const fetchMock = installFetch(async () => {
      throw new TypeError("socket hang up");
    });

    const submission = await createClient().replayBuild({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts,
    });

    expect(submission.outcome).toBe("unconfirmed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("treats a gateway error as unconfirmed", async () => {
    installFetch(async () => htmlResponse("Bad Gateway", 502));

    const submission = await createClient().replayBuild({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts,
    });

    expect(submission.outcome).toBe("unconfirmed");
  });

  test("carries Jenkins' reason for a refused replay", async () => {
    installFetch(
      async () =>
        new Response("<html>Error</html>", {
          status: 400,
          headers: {
            "content-type": "text/html",
            "x-error":
              "Replay is not allowed when password parameters are used.",
          },
        }),
    );

    const submission = await createClient().replayBuild({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts,
    });

    expect(submission).toEqual({
      outcome: "rejected",
      httpStatus: 400,
      kind: "http_error",
      detail: "Replay is not allowed when password parameters are used.",
    });
  });

  test("rejects a redirect anywhere but the job", async () => {
    installFetch(async () => redirectResponse(`${BASE_URL}/login`));

    const submission = await createClient().replayBuild({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts,
    });

    expect(submission).toMatchObject({ outcome: "rejected", kind: "redirect" });
  });

  test("rejects a page where Jenkins would redirect", async () => {
    installFetch(async () => htmlResponse("<html>Sign in</html>"));

    const submission = await createClient().replayBuild({
      buildUrl: BUILD_URL,
      jobUrl: JOB_URL,
      scripts,
    });

    expect(submission).toMatchObject({
      outcome: "rejected",
      kind: "html_page",
    });
  });
});

function replayOf(source: number) {
  return {
    _class: "org.jenkinsci.plugins.workflow.cps.replay.ReplayCause",
    shortDescription: `Replayed #${source}`,
  };
}

function startedBy(userId: string) {
  return {
    _class: "hudson.model.Cause$UserIdCause",
    shortDescription: `Started by user ${userId}`,
    userId,
  };
}

function build(number: number, causes: object[]) {
  return {
    number,
    actions: [{}, { _class: "hudson.model.CauseAction", causes }],
  };
}

describe("JenkinsClient.findReplayedBuild", () => {
  test("returns the oldest matching build newer than the request", async () => {
    installFetch(async () =>
      jsonResponse({
        builds: [
          build(17, [startedBy("alice"), replayOf(12)]),
          build(16, [startedBy("alice"), replayOf(12)]),
          build(15, [startedBy("bob"), replayOf(12)]),
          build(14, [startedBy("alice"), replayOf(11)]),
          build(13, [startedBy("alice")]),
          build(12, [startedBy("alice"), replayOf(12)]),
        ],
      }),
    );

    const found = await createClient().findReplayedBuild({
      jobUrl: JOB_URL,
      sourceBuildNumber: 12,
      afterBuildNumber: 12,
      afterQueueId: 0,
    });

    expect(found).toEqual({
      jobUrl: JOB_URL,
      buildUrl: `${JOB_URL}16/`,
      buildNumber: 16,
    });
  });

  test("reads a localized source number with grouping", async () => {
    installFetch(async () =>
      jsonResponse({
        builds: [
          build(1235, [
            startedBy("alice"),
            {
              ...replayOf(0),
              shortDescription: "Wiederholt #1.234",
            },
          ]),
        ],
      }),
    );

    const found = await createClient().findReplayedBuild({
      jobUrl: JOB_URL,
      sourceBuildNumber: 1234,
      afterBuildNumber: 1234,
      afterQueueId: 0,
    });

    expect(found?.buildNumber).toBe(1235);
  });

  test("falls back to the newest matching queue item of the job", async () => {
    installFetch(async (url) =>
      url.startsWith(`${BASE_URL}/queue/`)
        ? jsonResponse({
            items: [
              {
                id: 40,
                task: { url: "https://other-host/jenkins/job/deploy/" },
                actions: [{ causes: [startedBy("alice"), replayOf(12)] }],
              },
              {
                id: 41,
                task: { url: "https://other-host/jenkins/job/deploy/" },
                actions: [{ causes: [startedBy("alice"), replayOf(12)] }],
              },
              {
                id: 42,
                task: { url: "https://other-host/jenkins/job/other/" },
                actions: [{ causes: [startedBy("alice"), replayOf(12)] }],
              },
            ],
          })
        : jsonResponse({ builds: [build(12, [startedBy("alice")])] }),
    );

    const found = await createClient().findReplayedBuild({
      jobUrl: JOB_URL,
      sourceBuildNumber: 12,
      afterBuildNumber: 12,
      afterQueueId: 0,
    });

    expect(found).toEqual({
      jobUrl: JOB_URL,
      queueUrl: `${BASE_URL}/queue/item/41/`,
      queueId: 41,
    });
  });

  test("ignores a matching queue item that existed before the request", async () => {
    installFetch(async (url) =>
      url.startsWith(`${BASE_URL}/queue/`)
        ? jsonResponse({
            items: [
              {
                id: 41,
                task: { url: JOB_URL },
                actions: [{ causes: [startedBy("alice"), replayOf(12)] }],
              },
            ],
          })
        : jsonResponse({ builds: [] }),
    );

    const found = await createClient().findReplayedBuild({
      jobUrl: JOB_URL,
      sourceBuildNumber: 12,
      afterBuildNumber: 12,
      afterQueueId: 41,
    });

    expect(found).toBeNull();
  });

  test("returns null when nothing matches", async () => {
    installFetch(async (url) =>
      url.startsWith(`${BASE_URL}/queue/`)
        ? jsonResponse({ items: [] })
        : jsonResponse({ builds: [] }),
    );

    const found = await createClient().findReplayedBuild({
      jobUrl: JOB_URL,
      sourceBuildNumber: 12,
      afterBuildNumber: 12,
      afterQueueId: 0,
    });

    expect(found).toBeNull();
  });
});
