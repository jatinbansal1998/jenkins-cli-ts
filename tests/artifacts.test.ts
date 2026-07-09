import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runArtifacts } from "../src/commands/artifacts";
import type { EnvConfig } from "../src/env";
import { JenkinsClient } from "../src/jenkins/api-wrapper";
import type { BuildArtifacts } from "../src/types/jenkins";

const TEST_ENV: EnvConfig = {
  jenkinsUrl: "https://jenkins.example.com",
  jenkinsUser: "tester",
  jenkinsApiToken: "token",
  branchParamDefault: "BRANCH",
  useCrumb: false,
  folderDepth: 1,
};

const BUILD_URL = "https://jenkins.example.com/job/api/5/";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jenkins-cli-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type FetchInput = Parameters<typeof fetch>[0];

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/**
 * Installs a global fetch mock that serves an artifacts listing and streams
 * artifact bytes keyed by relativePath. Returns a restore callback.
 */
function installFetchMock(files: Record<string, string>): () => void {
  const realFetch = globalThis.fetch;
  const fetchMock = mock(async (input: FetchInput) => {
    const url = requestUrl(input);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/api/json")) {
      return new Response(
        JSON.stringify({
          number: 5,
          url: BUILD_URL,
          artifacts: Object.keys(files).map((relativePath) => ({
            fileName: relativePath.split("/").pop(),
            relativePath,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const marker = "/artifact/";
    const index = parsed.pathname.indexOf(marker);
    if (index >= 0) {
      const encodedPath = parsed.pathname.slice(index + marker.length);
      const relativePath = encodedPath
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/");
      const body = files[relativePath];
      if (body === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(body, { status: 200 });
    }
    throw new Error(`Unhandled mocked fetch URL: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function createClient(stubs: Partial<JenkinsClient>): JenkinsClient {
  return stubs as JenkinsClient;
}

function realClient(): JenkinsClient {
  return new JenkinsClient({
    baseUrl: TEST_ENV.jenkinsUrl,
    user: TEST_ENV.jenkinsUser,
    apiToken: TEST_ENV.jenkinsApiToken,
    useCrumb: false,
    folderDepth: 1,
  });
}

describe("runArtifacts listing", () => {
  test("lists artifacts in a table with a count summary", async () => {
    const logSpy = spyOn(console, "log");
    const listArtifacts = mock(async (): Promise<BuildArtifacts> => ({
      buildNumber: 5,
      buildUrl: BUILD_URL,
      artifacts: [
        { fileName: "app.js", relativePath: "dist/app.js" },
        { fileName: "report.txt", relativePath: "report.txt" },
      ],
    }));
    try {
      await runArtifacts({
        client: createClient({ listArtifacts }),
        env: TEST_ENV,
        buildUrl: BUILD_URL,
        nonInteractive: true,
      });

      expect(listArtifacts).toHaveBeenCalledWith(BUILD_URL);
      const output = logSpy.mock.calls
        .map((call) => call[0])
        .filter((entry): entry is string => typeof entry === "string")
        .join("\n");
      expect(output).toContain("dist/app.js");
      expect(output).toContain("report.txt");
      expect(output).toContain("OK: 2 artifacts");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("prints an OK line when there are no artifacts", async () => {
    const logSpy = spyOn(console, "log");
    const listArtifacts = mock(async (): Promise<BuildArtifacts> => ({
      buildUrl: BUILD_URL,
      artifacts: [],
    }));
    try {
      await runArtifacts({
        client: createClient({ listArtifacts }),
        env: TEST_ENV,
        buildUrl: BUILD_URL,
        nonInteractive: true,
      });

      const messages = logSpy.mock.calls
        .map((call) => call[0])
        .filter((entry): entry is string => typeof entry === "string");
      expect(messages.some((message) => message.includes("no artifacts"))).toBe(
        true,
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("runArtifacts download", () => {
  test("streams artifact bytes to nested destination paths", async () => {
    const dest = makeTempDir();
    const files = {
      "dist/nested/app.js": "console.log('hello world');",
      "report.txt": "build report contents",
    };
    const restoreFetch = installFetchMock(files);
    const logSpy = spyOn(console, "log");
    try {
      await runArtifacts({
        client: realClient(),
        env: TEST_ENV,
        buildUrl: BUILD_URL,
        download: true,
        dest,
        nonInteractive: true,
      });

      const nested = await Bun.file(
        path.join(dest, "dist/nested/app.js"),
      ).text();
      const report = await Bun.file(path.join(dest, "report.txt")).text();
      expect(nested).toBe(files["dist/nested/app.js"]);
      expect(report).toBe(files["report.txt"]);
    } finally {
      logSpy.mockRestore();
      restoreFetch();
    }
  });

  test("only downloads artifacts matched by --artifact", async () => {
    const dest = makeTempDir();
    const files = {
      "dist/app.js": "app bytes",
      "report.txt": "report bytes",
    };
    const restoreFetch = installFetchMock(files);
    const logSpy = spyOn(console, "log");
    try {
      await runArtifacts({
        client: realClient(),
        env: TEST_ENV,
        buildUrl: BUILD_URL,
        download: true,
        dest,
        artifact: ["report.txt"],
        nonInteractive: true,
      });

      expect(await Bun.file(path.join(dest, "report.txt")).exists()).toBe(true);
      expect(await Bun.file(path.join(dest, "dist/app.js")).exists()).toBe(
        false,
      );
    } finally {
      logSpy.mockRestore();
      restoreFetch();
    }
  });

  test("rejects when a requested artifact is unknown", async () => {
    const restoreFetch = installFetchMock({ "report.txt": "report bytes" });
    try {
      await expect(
        runArtifacts({
          client: realClient(),
          env: TEST_ENV,
          buildUrl: BUILD_URL,
          download: true,
          artifact: ["missing.bin"],
          nonInteractive: true,
        }),
      ).rejects.toThrow("not found: missing.bin");
    } finally {
      restoreFetch();
    }
  });

  test("does not overwrite existing files unless --force is passed", async () => {
    const dest = makeTempDir();
    const files = { "report.txt": "fresh contents" };
    const existingPath = path.join(dest, "report.txt");
    await Bun.write(existingPath, "original contents");

    const restoreFetch = installFetchMock(files);
    const logSpy = spyOn(console, "log");
    try {
      await runArtifacts({
        client: realClient(),
        env: TEST_ENV,
        buildUrl: BUILD_URL,
        download: true,
        dest,
        nonInteractive: true,
      });
      expect(await Bun.file(existingPath).text()).toBe("original contents");

      await runArtifacts({
        client: realClient(),
        env: TEST_ENV,
        buildUrl: BUILD_URL,
        download: true,
        dest,
        force: true,
        nonInteractive: true,
      });
      expect(await Bun.file(existingPath).text()).toBe("fresh contents");
    } finally {
      logSpy.mockRestore();
      restoreFetch();
    }
  });
});

describe("runArtifacts validation", () => {
  test("fails fast in non-interactive mode when no target is given", async () => {
    const listArtifacts = mock(async (): Promise<BuildArtifacts> => ({
      buildUrl: BUILD_URL,
      artifacts: [],
    }));
    await expect(
      runArtifacts({
        client: createClient({ listArtifacts }),
        env: TEST_ENV,
        nonInteractive: true,
      }),
    ).rejects.toThrow();
    expect(listArtifacts).not.toHaveBeenCalled();
  });

  test("rejects --build-url combined with --job", async () => {
    await expect(
      runArtifacts({
        client: createClient({}),
        env: TEST_ENV,
        buildUrl: BUILD_URL,
        job: "api",
        nonInteractive: true,
      }),
    ).rejects.toThrow(
      "When --build-url is provided, do not pass --job or --job-url.",
    );
  });
});
