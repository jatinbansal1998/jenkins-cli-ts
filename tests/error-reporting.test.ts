import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type * as Sentry from "@sentry/bun";
import { CliError } from "../src/cli";
import {
  captureUnexpectedError,
  initializeErrorReporting,
  resolveErrorReportingConfig,
  resolveSentryEnvironment,
} from "../src/error-reporting";

type InitOptions = Parameters<typeof Sentry.init>[0];

const originalSentryDsn = process.env.SENTRY_DSN;
const originalSentryEnvironment = process.env.SENTRY_ENVIRONMENT;
const originalReportingDisabled = process.env.JENKINS_ERROR_REPORTING_DISABLED;

beforeEach(() => {
  delete process.env.JENKINS_ERROR_REPORTING_DISABLED;
});

afterEach(() => {
  restoreEnv("SENTRY_DSN", originalSentryDsn);
  restoreEnv("SENTRY_ENVIRONMENT", originalSentryEnvironment);
  restoreEnv("JENKINS_ERROR_REPORTING_DISABLED", originalReportingDisabled);
});

describe("error reporting configuration", () => {
  test("uses the bundled DSN by default", () => {
    const config = resolveErrorReportingConfig({});

    expect(config.disabled).toBeFalse();
    expect(config.dsn).toStartWith("https://");
    expect(config.dsn).toContain("sentry.io/");
  });

  test("supports a DSN override", () => {
    const config = resolveErrorReportingConfig({
      SENTRY_DSN: " https://public@example.ingest.sentry.io/42 ",
    });

    expect(config).toEqual({
      disabled: false,
      dsn: "https://public@example.ingest.sentry.io/42",
    });
  });

  test("supports explicit opt-out and an empty DSN", () => {
    expect(
      resolveErrorReportingConfig({
        JENKINS_ERROR_REPORTING_DISABLED: "true",
      }),
    ).toEqual({ disabled: true });
    expect(resolveErrorReportingConfig({ SENTRY_DSN: "" })).toEqual({
      disabled: true,
    });
  });

  test("resolves explicit, source, and bundled environments", () => {
    expect(
      resolveSentryEnvironment(
        { SENTRY_ENVIRONMENT: "github-actions" },
        "source",
      ),
    ).toBe("github-actions");
    expect(resolveSentryEnvironment({}, "source")).toBe("development");
    expect(resolveSentryEnvironment({}, "bun-linux-x64")).toBe("production");
  });

  test("initializes error-only reporting with privacy-safe tags", async () => {
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/42";
    process.env.SENTRY_ENVIRONMENT = "test";
    delete process.env.JENKINS_ERROR_REPORTING_DISABLED;
    let options: InitOptions;
    const adapter = createAdapter({
      init: (value) => {
        options = value;
      },
    });

    expect(initializeErrorReporting(adapter)).toBeTrue();
    expect(options!.dsn).toBe("https://public@example.ingest.sentry.io/42");
    expect(options!.environment).toBe("test");
    expect(options!.release).toStartWith("jenkins-cli-ts@");
    expect(options!.includeServerName).toBeFalse();
    expect(options!.serverName).toBe("jenkins-cli");
    expect(options!.maxBreadcrumbs).toBe(0);
    expect(options!.enableLogs).toBeFalse();
    expect(options!.enableMetrics).toBeFalse();
    expect(options!.shutdownTimeout).toBe(1_500);
    expect(options!.tracePropagationTargets).toEqual([]);
    expect(options!.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
    expect(options!.initialScope).toMatchObject({
      tags: {
        bun_version: Bun.version,
        os_platform: process.platform,
        os_arch: process.arch,
      },
    });

    const beforeSend = options!.beforeSend;
    expect(beforeSend).toBeFunction();
    const event = await beforeSend!(
      {
        type: undefined,
        user: { username: "private-user" },
        request: { url: "https://jenkins.example.com/job/private" },
        breadcrumbs: [{ message: "private-job" }],
        contexts: { private: { value: "private" } },
        extra: { private: true },
        server_name: "private-host",
        exception: {
          values: [
            {
              type: "Error",
              value: "Failed at https://jenkins.example.com/job/private",
              stacktrace: {
                frames: [
                  {
                    filename: `${process.env.HOME}/project/src/index.ts`,
                    vars: { token: "secret" },
                    pre_context: ["private before"],
                    context_line: "private current",
                    post_context: ["private after"],
                  },
                ],
              },
            },
          ],
        },
      },
      {},
    );

    expect(event?.user).toBeUndefined();
    expect(event?.request).toBeUndefined();
    expect(event?.breadcrumbs).toBeUndefined();
    expect(event?.contexts).toBeUndefined();
    expect(event?.extra).toBeUndefined();
    expect(event?.server_name).toBeUndefined();
    expect(event?.exception?.values?.[0]?.value).toBe(
      "Failed at <redacted-url>",
    );
    expect(
      event?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename,
    ).toBe("~/project/src/index.ts");
    expect(
      event?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars,
    ).toBeUndefined();
    expect(
      event?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.context_line,
    ).toBeUndefined();

    expect(
      await beforeSend!(
        { type: undefined, message: "Expected" },
        { originalException: new CliError("Expected") },
      ),
    ).toBeNull();
  });
});

describe("unexpected error capture", () => {
  test("does not capture expected CLI errors", async () => {
    let captures = 0;
    let flushes = 0;
    const adapter = createAdapter({
      captureException: () => {
        captures += 1;
      },
      flush: async () => {
        flushes += 1;
        return true;
      },
    });

    await captureUnexpectedError(new CliError("Expected failure."), adapter);

    expect(captures).toBe(0);
    expect(flushes).toBe(0);
  });

  test("captures and flushes unexpected errors", async () => {
    const error = new Error("Unexpected failure.");
    let captured: unknown;
    let flushTimeout: number | undefined;
    const adapter = createAdapter({
      captureException: (value) => {
        captured = value;
      },
      flush: async (timeout) => {
        flushTimeout = timeout;
        return true;
      },
    });

    const eventId = await captureUnexpectedError(error, adapter);

    expect(captured).toBe(error);
    expect(flushTimeout).toBe(1_500);
    expect(eventId).toBe("test-event-id");
  });

  test("does not confirm an event when the transport cannot flush", async () => {
    const adapter = createAdapter({ flush: async () => false });

    expect(
      await captureUnexpectedError(new Error("Unexpected failure."), adapter),
    ).toBeUndefined();
  });

  test("does nothing when reporting is disabled", async () => {
    let captures = 0;
    const adapter = createAdapter({
      isEnabled: () => false,
      captureException: () => {
        captures += 1;
      },
    });

    await captureUnexpectedError(new Error("Unexpected failure."), adapter);

    expect(captures).toBe(0);
  });
});

function createAdapter(
  overrides: {
    init?: (options: InitOptions) => void;
    isEnabled?: () => boolean;
    captureException?: (error: unknown) => void;
    flush?: (timeout?: number) => Promise<boolean>;
  } = {},
) {
  return {
    init: (options: InitOptions) => {
      overrides.init?.(options);
      return undefined;
    },
    isEnabled: overrides.isEnabled ?? (() => true),
    captureException: (error: unknown) => {
      overrides.captureException?.(error);
      return "test-event-id";
    },
    flush: overrides.flush ?? (async () => true),
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
