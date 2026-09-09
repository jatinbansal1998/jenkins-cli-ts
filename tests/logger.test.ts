import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  setSystemTime,
} from "bun:test";
import fs from "node:fs";
import { probeJenkinsIdentity } from "../src/auth-diagnostics";
import { toJsonError } from "../src/json-output";
import path from "node:path";
import { resolveUserHome } from "../src/user-home";
import {
  logCliError,
  registerRedactedSecret,
  logApiError,
  logApiRequest,
  logApiResponse,
  pruneOldLogs,
  setDebugMode,
} from "../src/logger";

let appendSpy: ReturnType<typeof spyOn<typeof fs, "appendFileSync">>;
const configDir = path.join(resolveUserHome(), ".config", "jenkins-cli");

beforeEach(() => {
  appendSpy = spyOn(fs, "appendFileSync").mockImplementation(() => undefined);
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  setSystemTime();
  setDebugMode(false);
  appendSpy.mockRestore();
});

function appendedPayload(): string {
  return appendSpy.mock.calls.map((call) => String(call[1])).join("");
}

describe("api logger", () => {
  test("masks registered tokens and Basic credentials in both disk logs, retaining other details", () => {
    const token = "synthetic.api-token+$[literal]";
    const encoded = Buffer.from(`synthetic-user:${token}`).toString("base64");
    registerRedactedSecret(token);
    registerRedactedSecret(encoded);
    logCliError(
      new Error(
        `proxy echoed ${token} twice ${token}; password=keep-local-detail`,
        { cause: new Error(`Authorization: Basic ${encoded}`) },
      ),
    );
    setDebugMode(true);
    logApiResponse("GET", "https://jenkins.example.com", 403, {
      "X-Proxy-Detail": `${token} Basic ${encoded}; diagnostic=keep-local-detail`,
    });
    expect(appendSpy).toHaveBeenCalledTimes(2);
    for (const [, value] of appendSpy.mock.calls) {
      const payload = String(value);
      expect(payload).not.toContain(token);
      expect(payload).not.toContain(encoded);
      expect(payload).toContain("<redacted>");
      expect(payload).toContain("keep-local-detail");
    }
    expect(appendedPayload()).toContain(
      "Caused by\nError: Authorization: Basic <redacted>",
    );
    expect(appendedPayload()).toMatch(/\s+at .+:\d+:\d+/);
  });

  test("masks credentials used by the standalone authentication probe", async () => {
    const token = "synthetic-probe-token";
    const encoded = Buffer.from(`probe-user:${token}`).toString("base64");
    setDebugMode(true);
    await probeJenkinsIdentity(
      {
        controller: "https://jenkins.example.com",
        username: "probe-user",
        token,
      },
      {
        fetch: async () =>
          new Response("forbidden", {
            status: 403,
            headers: { "X-Proxy-Detail": `${token} Basic ${encoded}` },
          }),
      },
    );
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendedPayload()).not.toContain(token);
    expect(appendedPayload()).not.toContain(encoded);
    expect(appendedPayload()).toContain(
      "x-proxy-detail: <redacted> Basic <redacted>",
    );
  });

  test("masks overlapping credentials completely across clients", () => {
    for (const token of ["synthetic-overlap", "synthetic-overlap-extended"]) {
      registerRedactedSecret(token);
    }
    logCliError(new Error("synthetic-overlap-extended synthetic-overlap"));
    expect(appendedPayload()).toContain("Error: <redacted> <redacted>");
    expect(appendedPayload()).not.toContain("extended");
  });

  test("converts JSON errors without writing a log", () => {
    expect(toJsonError(new Error("synthetic conversion")).message).toBe(
      "synthetic conversion",
    );
    expect(appendSpy).not.toHaveBeenCalled();
  });
  test("writes nothing when debug mode is disabled", () => {
    setDebugMode(false);

    logApiRequest("GET", "https://jenkins.example.com/api/json", {
      Authorization: "Basic dXNlcjp0b2tlbg==",
    });
    logApiResponse("GET", "https://jenkins.example.com/api/json", 200, {});
    logApiError("GET", "https://jenkins.example.com/api/json", 500, {});

    expect(appendSpy).not.toHaveBeenCalled();
  });

  test("redacts credential headers when debug mode is enabled", () => {
    setDebugMode(true);

    logApiRequest(
      "POST",
      "https://jenkins.example.com/job/build",
      {
        Authorization: "Basic dXNlcjp0b2tlbg==",
        "Jenkins-Crumb": "crumb-secret",
        Cookie: "JSESSIONID=abc",
        Accept: "application/json",
      },
      true,
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const payload = appendedPayload();
    expect(payload).toContain("Authorization: <redacted>");
    expect(payload).toContain("Jenkins-Crumb: <redacted>");
    expect(payload).toContain("Cookie: <redacted>");
    expect(payload).toContain("Accept: application/json");
    expect(payload).toContain("Body:\n  <omitted>");
    expect(payload).not.toContain("dXNlcjp0b2tlbg==");
    expect(payload).not.toContain("crumb-secret");
    expect(payload).not.toContain("JSESSIONID");
  });

  test("keeps the UTC write date and 0600 permissions across midnight", () => {
    setDebugMode(true);

    setSystemTime(new Date("2026-01-01T23:59:59.999Z"));
    logApiResponse("GET", "https://jenkins.example.com/api/json", 200, {
      "Set-Cookie": "JSESSIONID=abc",
    });

    expect(appendSpy).toHaveBeenCalledTimes(1);
    setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const filePath = path.join(configDir, "api-2026-01-01.log");
    expect(fs.existsSync(filePath)).toBeTrue();
    if (process.platform !== "win32")
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(appendedPayload()).toContain("Set-Cookie: <redacted>");
  });
});

describe("pruneOldLogs", () => {
  const now = Date.parse("2026-07-09T12:00:00.000Z");
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;

  let readdirSpy: ReturnType<typeof spyOn<typeof fs, "readdirSync">>;
  let statSpy: ReturnType<typeof spyOn<typeof fs, "statSync">>;
  let rmSpy: ReturnType<typeof spyOn<typeof fs, "rmSync">>;

  beforeEach(() => {
    readdirSpy = spyOn(fs, "readdirSync").mockImplementation(() => []);
    statSpy = spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    rmSpy = spyOn(fs, "rmSync").mockImplementation(() => undefined);
  });

  afterEach(() => {
    readdirSpy.mockRestore();
    statSpy.mockRestore();
    rmSpy.mockRestore();
  });

  function removedBasenames(): string[] {
    return rmSpy.mock.calls.map((call) => path.basename(String(call[0])));
  }

  test("removes dated logs past retention and keeps recent or unrelated files", () => {
    readdirSpy.mockImplementation((() => [
      "api-2026-07-01.log",
      "api-2026-07-02.log",
      "api-2026-07-09.log",
      "api-notadate.log",
      "jenkins-cli-config.json",
    ]) as unknown as typeof fs.readdirSync);

    pruneOldLogs(now);

    expect(removedBasenames()).toEqual(["api-2026-07-01.log"]);
  });

  test("removes the legacy api.log once its mtime passes retention", () => {
    statSpy.mockImplementation((() => ({
      mtimeMs: cutoff - 1,
    })) as unknown as typeof fs.statSync);

    pruneOldLogs(now);

    expect(removedBasenames()).toEqual(["api.log"]);
  });

  test("keeps a legacy api.log that is still within retention", () => {
    statSpy.mockImplementation((() => ({
      mtimeMs: cutoff + 1,
    })) as unknown as typeof fs.statSync);

    pruneOldLogs(now);

    expect(rmSpy).not.toHaveBeenCalled();
  });

  test("never throws when the config directory is unreadable", () => {
    readdirSpy.mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(() => pruneOldLogs(now)).not.toThrow();
  });
});
