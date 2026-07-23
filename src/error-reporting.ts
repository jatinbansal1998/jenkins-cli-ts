import os from "node:os";
import type * as Sentry from "@sentry/bun";
import { BUILD_TARGET } from "./build-target";
import { CliError } from "./cli";
import { ENV_KEYS } from "./env-keys";
import packageJson from "../package.json";

type SentryAdapter = {
  init: typeof Sentry.init;
  isEnabled: typeof Sentry.isEnabled;
  captureException: typeof Sentry.captureException;
  flush: typeof Sentry.flush;
};

const DEFAULT_SENTRY_DSN =
  "https://cbbcbb6d130e1d3e2ffa5baf69c6ed6c@o4511785491824640.ingest.de.sentry.io/4511785621586000";
const FLUSH_TIMEOUT_MS = 1_500;

export type ErrorReportingConfig = {
  disabled: boolean;
  dsn?: string;
};

export function resolveErrorReportingConfig(
  env: NodeJS.ProcessEnv = process.env,
): ErrorReportingConfig {
  const disabled = parseBooleanFlag(
    env[ENV_KEYS.JENKINS_ERROR_REPORTING_DISABLED],
  );
  const hasDsnOverride = Object.prototype.hasOwnProperty.call(
    env,
    "SENTRY_DSN",
  );
  const dsnOverride = normalizeOptionalString(env.SENTRY_DSN);

  if (disabled === true || (hasDsnOverride && !dsnOverride)) {
    return { disabled: true };
  }

  return {
    disabled: false,
    dsn: dsnOverride ?? DEFAULT_SENTRY_DSN,
  };
}

export function initializeErrorReporting(adapter: SentryAdapter): boolean {
  const config = resolveErrorReportingConfig();
  if (config.disabled || !config.dsn) {
    return false;
  }

  try {
    adapter.init({
      dsn: config.dsn,
      release: `jenkins-cli-ts@${packageJson.version}`,
      environment: resolveSentryEnvironment(),
      includeServerName: false,
      serverName: "jenkins-cli",
      maxBreadcrumbs: 0,
      enableLogs: false,
      enableMetrics: false,
      sendClientReports: false,
      shutdownTimeout: FLUSH_TIMEOUT_MS,
      tracePropagationTargets: [],
      dataCollection: {
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
      },
      initialScope: {
        tags: {
          build_target: BUILD_TARGET,
          bun_version: Bun.version,
          os_platform: process.platform,
          os_arch: process.arch,
          build_mode: BUILD_TARGET === "source" ? "source" : "bundled",
        },
      },
      beforeSend: scrubEvent,
    });
    return true;
  } catch {
    return false;
  }
}

export async function initializeDefaultErrorReporting(): Promise<boolean> {
  try {
    if (resolveErrorReportingConfig().disabled) {
      return false;
    }
    const adapter = await loadSentryAdapter();
    return adapter.isEnabled() || initializeErrorReporting(adapter);
  } catch {
    return false;
  }
}

export function resolveSentryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  buildTarget: string = BUILD_TARGET,
): string {
  const override = normalizeOptionalString(env.SENTRY_ENVIRONMENT);
  if (override) {
    return override;
  }
  return buildTarget === "source" ? "development" : "production";
}

export async function captureUnexpectedError(
  error: unknown,
  adapter?: SentryAdapter,
): Promise<string | undefined> {
  if (error instanceof CliError) {
    return;
  }

  try {
    if (resolveErrorReportingConfig().disabled) {
      return;
    }
    const activeAdapter = adapter ?? (await loadSentryAdapter());
    if (
      !activeAdapter.isEnabled() &&
      (!initializeErrorReporting(activeAdapter) || !activeAdapter.isEnabled())
    ) {
      return;
    }
    const eventId = activeAdapter.captureException(error);
    return (await activeAdapter.flush(FLUSH_TIMEOUT_MS)) ? eventId : undefined;
  } catch {
    // Error reporting must never change CLI behavior.
    return undefined;
  }
}

async function loadSentryAdapter(): Promise<SentryAdapter> {
  const sentry = await import("@sentry/bun");
  return {
    init: sentry.init,
    isEnabled: sentry.isEnabled,
    captureException: sentry.captureException,
    flush: sentry.flush,
  };
}

function scrubEvent(
  event: Sentry.ErrorEvent,
  hint: Sentry.EventHint,
): Sentry.ErrorEvent | null {
  if (hint.originalException instanceof CliError) {
    return null;
  }
  delete event.user;
  delete event.request;
  delete event.breadcrumbs;
  delete event.contexts;
  delete event.extra;
  delete event.modules;
  delete event.server_name;

  if (event.message) {
    event.message = scrubText(event.message);
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = scrubText(exception.value);
    }
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) {
        frame.filename = scrubText(frame.filename);
      }
      if (frame.abs_path) {
        frame.abs_path = scrubText(frame.abs_path);
      }
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }

  return event;
}

function scrubText(value: string): string {
  let scrubbed = value;
  for (const home of new Set([os.homedir(), process.env.HOME])) {
    if (home) {
      scrubbed = scrubbed.split(home).join("~");
    }
  }
  return scrubbed.replace(/https?:\/\/[^\s)\]}>,]+/gi, "<redacted-url>");
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}
