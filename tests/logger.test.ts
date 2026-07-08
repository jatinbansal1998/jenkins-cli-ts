import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  logApiError,
  logApiRequest,
  logApiResponse,
  pruneOldApiLogs,
  setDebugMode,
} from "../src/logger";

let appendSpy: ReturnType<typeof spyOn<typeof fs, "appendFileSync">>;
let existsSpy: ReturnType<typeof spyOn<typeof fs, "existsSync">>;

beforeEach(() => {
  appendSpy = spyOn(fs, "appendFileSync").mockImplementation(() => undefined);
  existsSpy = spyOn(fs, "existsSync").mockImplementation(() => true);
});

afterEach(() => {
  setDebugMode(false);
  appendSpy.mockRestore();
  existsSpy.mockRestore();
});

function appendedPayload(): string {
  return appendSpy.mock.calls.map((call) => String(call[1])).join("");
}

describe("api logger", () => {
  test("writes nothing when debug mode is disabled", () => {
    setDebugMode(false);

    logApiRequest("GET", "https://jenkins.example.com/api/json", {
      Authorization: "Basic dXNlcjp0b2tlbg==",
    });
    logApiResponse(
      "GET",
      "https://jenkins.example.com/api/json",
      200,
      {},
      "{}",
    );
    logApiError("GET", "https://jenkins.example.com/api/json", 500, {}, "boom");

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
      "payload",
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const payload = appendedPayload();
    expect(payload).toContain("Authorization: <redacted>");
    expect(payload).toContain("Jenkins-Crumb: <redacted>");
    expect(payload).toContain("Cookie: <redacted>");
    expect(payload).toContain("Accept: application/json");
    expect(payload).not.toContain("dXNlcjp0b2tlbg==");
    expect(payload).not.toContain("crumb-secret");
    expect(payload).not.toContain("JSESSIONID");
  });

  test("writes to a UTC-dated log file created with 0600 permissions", () => {
    setDebugMode(true);

    logApiResponse(
      "GET",
      "https://jenkins.example.com/api/json",
      200,
      { "Set-Cookie": "JSESSIONID=abc" },
      "{}",
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const [filePath, , appendOptions] = appendSpy.mock.calls[0] ?? [];
    const today = new Date().toISOString().slice(0, 10);
    expect(String(filePath).endsWith(`api-${today}.log`)).toBeTrue();
    expect(appendOptions).toEqual({ mode: 0o600 });
    expect(appendedPayload()).toContain("Set-Cookie: <redacted>");
  });
});

describe("pruneOldApiLogs", () => {
  const now = Date.parse("2026-07-09T12:00:00.000Z");
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;

  let readdirSpy: ReturnType<typeof spyOn<typeof fs, "readdirSync">>;
  let statSpy: ReturnType<typeof spyOn<typeof fs, "statSync">>;
  let rmSpy: ReturnType<typeof spyOn<typeof fs, "rmSync">>;

  beforeEach(() => {
    readdirSpy = spyOn(fs, "readdirSync").mockImplementation(
      (() => []) as unknown as typeof fs.readdirSync,
    );
    statSpy = spyOn(fs, "statSync").mockImplementation((() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }) as unknown as typeof fs.statSync);
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

    pruneOldApiLogs(now);

    expect(removedBasenames()).toEqual(["api-2026-07-01.log"]);
  });

  test("removes the legacy api.log once its mtime passes retention", () => {
    statSpy.mockImplementation((() => ({
      mtimeMs: cutoff - 1,
    })) as unknown as typeof fs.statSync);

    pruneOldApiLogs(now);

    expect(removedBasenames()).toEqual(["api.log"]);
  });

  test("keeps a legacy api.log that is still within retention", () => {
    statSpy.mockImplementation((() => ({
      mtimeMs: cutoff + 1,
    })) as unknown as typeof fs.statSync);

    pruneOldApiLogs(now);

    expect(rmSpy).not.toHaveBeenCalled();
  });

  test("never throws when the config directory is unreadable", () => {
    readdirSpy.mockImplementation((() => {
      throw new Error("EACCES");
    }) as unknown as typeof fs.readdirSync);

    expect(() => pruneOldApiLogs(now)).not.toThrow();
  });
});
