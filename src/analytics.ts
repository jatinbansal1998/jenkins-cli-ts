import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./cli";
import { CONFIG_DIR, readConfigSync } from "./config";
import { ENV_KEYS } from "./env-keys";
import packageJson from "../package.json";

/**
 * Analytics is tracked per command execution.
 *
 * A top-level CLI command starts a CommandSession, deeper helpers emit events
 * against that current session, and the events are queued in memory and sent as
 * one PostHog batch near the end of the command. The whole system is
 * intentionally best-effort: telemetry should never change command behavior.
 */
type AnalyticsValue = string | number | boolean | null | undefined;
type AnalyticsProps = Record<string, AnalyticsValue>;

type AnalyticsErrorType =
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_json";

type AnalyticsClientConfig = {
  apiKey?: string;
  host: string;
  disabled: boolean;
  distinctId?: string;
};

type CommandRunOptions = {
  command: string;
  interactive: boolean;
};

type CommandOutcome =
  | "success"
  | "user_cancelled"
  | "validation_error"
  | "jenkins_api_error"
  | "network_error"
  | "timeout"
  | "unexpected_error";

// PostHog project tokens are intended for client-side ingestion and are safe to
// ship in public apps. This is intentionally a project token, not a personal or
// admin API key. comment added by Me not AI.
const DEFAULT_POSTHOG_PROJECT_TOKEN =
  "phc_EEegv0Ih9p2wbgdGtBzpvDvCMghRkbNf3Z0vZwrg7sk";
const DEFAULT_POSTHOG_HOST = "https://t.jatinbansal.com";
const ANALYTICS_ID_FILE = path.join(CONFIG_DIR, "analytics-id");
const FLUSH_TIMEOUT_MS = 1_500;
const SESSION_ONLY_PROP_KEYS = new Set([
  "command",
  "interactive",
  "tty",
  "parent_command",
]);

// Keeps the current command's analytics session available across async calls so
// nested code can append events without receiving an explicit session object.
const storage = new AsyncLocalStorage<CommandSession>();

let cachedClient: PostHogClient | undefined;

// Process-wide PostHog client. It owns the queue and network flush logic, while
// command-specific metadata lives in CommandSession.
class PostHogClient {
  private readonly apiKey?: string;
  private readonly host: string;
  private readonly disabled: boolean;
  private readonly distinctId?: string;
  private readonly baseProps: AnalyticsProps;
  private queue: Array<{ event: string; properties: AnalyticsProps }> = [];

  constructor(config: AnalyticsClientConfig) {
    this.apiKey = config.apiKey;
    this.host = normalizeHost(config.host);
    this.disabled = config.disabled || !config.apiKey || !config.distinctId;
    this.distinctId = config.distinctId;
    this.baseProps = {
      distinct_id: config.distinctId,
      $lib: "jenkins-cli-ts",
      $lib_version: packageJson.version,
      cli_version: packageJson.version,
      os_platform: process.platform,
      os_release: os.release(),
      bun_version: Bun.version,
    };
  }

  // Queues one event with shared library/runtime metadata attached.
  capture(event: string, properties: AnalyticsProps = {}): void {
    if (this.disabled) {
      return;
    }
    this.queue.push({
      event,
      properties: sanitizeProps({
        ...this.baseProps,
        ...properties,
      }),
    });
  }

  // Sends the queued events to PostHog's batch endpoint through the configured
  // host. Failures are swallowed because analytics is best-effort only.
  async flush(): Promise<void> {
    if (this.disabled || this.queue.length === 0 || !this.apiKey) {
      return;
    }

    const batch = this.queue.splice(0, this.queue.length);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
    try {
      await fetch(new URL("/batch/", this.host).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          sent_at: new Date().toISOString(),
          batch,
        }),
        signal: controller.signal,
      });
    } catch {
      // Telemetry is best-effort only.
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Per-command state that all analytics events inherit from. This is where we
// keep command-wide properties like command name, interactive mode, tty, and
// API call/failure counters.
class CommandSession {
  private readonly analytics: PostHogClient;
  private readonly command: string;
  private readonly startedAt: number;
  private readonly commonProps: AnalyticsProps;
  private apiCallCount = 0;
  private apiFailureCount = 0;
  private pollingCommand = false;

  constructor(
    analytics: PostHogClient,
    options: CommandRunOptions,
    inheritedProps: AnalyticsProps = {},
  ) {
    this.analytics = analytics;
    this.command = options.command;
    this.startedAt = Date.now();
    this.commonProps = sanitizeProps({
      ...inheritedProps,
      command: options.command,
      interactive: options.interactive,
      tty: Boolean(process.stdout.isTTY),
    });
  }

  // Adds command-wide properties that become known after startup, such as
  // whether a profile was used or whether auth came from CLI overrides.
  updateCommonProps(properties: AnalyticsProps): void {
    Object.assign(this.commonProps, sanitizeProps(properties));
  }

  track(event: string, properties: AnalyticsProps = {}): void {
    this.analytics.capture(event, {
      ...this.commonProps,
      ...properties,
    });
  }

  getCommand(): string {
    return this.command;
  }

  getInheritedProps(): AnalyticsProps {
    const inheritedProps: AnalyticsProps = {};
    for (const [key, value] of Object.entries(this.commonProps)) {
      if (SESSION_ONLY_PROP_KEYS.has(key)) {
        continue;
      }
      inheritedProps[key] = value;
    }
    return inheritedProps;
  }

  markPollingCommand(): void {
    this.pollingCommand = true;
  }

  recordApiCall(): void {
    this.apiCallCount += 1;
  }

  recordApiFailure(properties: {
    operation: string;
    errorType: AnalyticsErrorType;
    httpStatus?: number;
    retryAttempted?: boolean;
  }): void {
    this.apiFailureCount += 1;
    this.track("jenkins_api_failure", {
      operation: properties.operation,
      error_type: properties.errorType,
      http_status: properties.httpStatus,
      retry_attempted: Boolean(properties.retryAttempted),
    });
  }

  // Records the final outcome for the command, emits one summary event for
  // Jenkins API usage, then tries to flush the queued analytics.
  async finish(
    outcome: CommandOutcome,
    defaultExitCode?: number,
  ): Promise<void> {
    const durationMs = Date.now() - this.startedAt;
    this.track("command_finished", {
      outcome,
      duration_ms: durationMs,
      process_exit_code:
        process.exitCode ??
        (outcome === "success" ? 0 : (defaultExitCode ?? 1)),
    });
    if (this.apiCallCount > 0 || this.apiFailureCount > 0) {
      this.track("command_api_summary", {
        api_call_count: this.apiCallCount,
        api_failure_count: this.apiFailureCount,
        polling_command: this.pollingCommand,
        duration_ms: durationMs,
      });
    }
    await this.analytics.flush();
  }
}

// Wraps a top-level CLI command in an analytics session. Any helper called
// within this async scope can reach the current session through AsyncLocalStorage.
export async function runWithAnalytics<T>(
  options: CommandRunOptions,
  action: () => Promise<T>,
): Promise<T> {
  const parentSession = storage.getStore();
  const inheritedProps = parentSession?.getInheritedProps() ?? {};
  if (parentSession) {
    inheritedProps.parent_command = parentSession.getCommand();
  }
  const session = new CommandSession(
    getAnalyticsClient(),
    options,
    inheritedProps,
  );
  return await storage.run(session, async () => {
    session.track("command_started");
    try {
      const result = await action();
      await session.finish("success", 0);
      return result;
    } catch (error) {
      await session.finish(classifyCommandOutcome(error));
      throw error;
    }
  });
}

export async function runInteractiveSubcommandWithAnalytics<T>(
  command: string,
  action: () => Promise<T>,
): Promise<T> {
  return await runWithAnalytics(
    {
      command,
      interactive: true,
    },
    action,
  );
}

export function updateAnalyticsContext(properties: AnalyticsProps): void {
  storage.getStore()?.updateCommonProps(properties);
}

export function markAnalyticsPollingCommand(): void {
  storage.getStore()?.markPollingCommand();
}

export function recordJenkinsApiCall(): void {
  storage.getStore()?.recordApiCall();
}

export function recordJenkinsApiFailure(properties: {
  operation: string;
  errorType: AnalyticsErrorType;
  httpStatus?: number;
  retryAttempted?: boolean;
}): void {
  storage.getStore()?.recordApiFailure(properties);
}

// Test helper to clear the process-wide cached client between test cases so
// environment/config changes are picked up cleanly.
export function resetAnalyticsForTests(): void {
  cachedClient = undefined;
}

function getAnalyticsClient(): PostHogClient {
  if (cachedClient) {
    return cachedClient;
  }
  const config = resolveAnalyticsClientConfig();
  cachedClient = new PostHogClient(config);
  return cachedClient;
}

// Computes the effective analytics config for this process. Analytics is
// disabled by default; users can explicitly opt in through config or env and
// still override the host/token when enabled.
function resolveAnalyticsClientConfig(): AnalyticsClientConfig {
  let config;
  try {
    config = readConfigSync()?.config;
  } catch {
    config = undefined;
  }
  const apiKey = normalizeOptionalString(
    process.env[ENV_KEYS.JENKINS_POSTHOG_API_KEY],
  );
  const host =
    normalizeOptionalString(process.env[ENV_KEYS.JENKINS_POSTHOG_HOST]) ??
    DEFAULT_POSTHOG_HOST;
  const analyticsDisabledByEnv = parseOptionalBooleanFlag(
    process.env[ENV_KEYS.JENKINS_ANALYTICS_DISABLED],
  );
  const analyticsDisabledByConfig = config?.analyticsDisabled;
  const analyticsEnabled =
    analyticsDisabledByEnv === false ||
    analyticsDisabledByConfig === false ||
    Boolean(apiKey);
  const analyticsDisabled =
    analyticsDisabledByEnv === true ||
    analyticsDisabledByConfig === true ||
    !analyticsEnabled;

  return {
    apiKey: analyticsDisabled
      ? undefined
      : (apiKey ?? DEFAULT_POSTHOG_PROJECT_TOKEN),
    host,
    disabled: analyticsDisabled,
    distinctId: analyticsDisabled ? undefined : getOrCreateAnalyticsId(),
  };
}

// Loads a stable anonymous install ID from disk or creates one if this is the
// first run. This gives PostHog a consistent distinct_id without using Jenkins
// usernames, URLs, or any other sensitive identifier.
function getOrCreateAnalyticsId(): string {
  try {
    if (fs.existsSync(ANALYTICS_ID_FILE)) {
      const value = fs.readFileSync(ANALYTICS_ID_FILE, "utf8").trim();
      if (value) {
        return value;
      }
    }

    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const value = crypto.randomUUID();
    fs.writeFileSync(ANALYTICS_ID_FILE, `${value}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(ANALYTICS_ID_FILE, 0o600);
    } catch {
      // Best-effort permission hardening.
    }
    return value;
  } catch {
    return crypto.randomUUID();
  }
}

function classifyCommandOutcome(error: unknown): CommandOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Operation cancelled.") {
    return "user_cancelled";
  }
  if (
    message.includes("Request timed out while trying to") ||
    message.startsWith("Timed out after ")
  ) {
    return "timeout";
  }
  if (message.includes("Network error while trying to")) {
    return "network_error";
  }
  if (
    message.includes("Jenkins rejected the request while trying to") ||
    message.includes("Jenkins returned HTTP") ||
    message.includes("Resource not found while trying to") ||
    message.includes("Invalid JSON response while trying to") ||
    message.includes("Unexpected Jenkins response") ||
    message.includes("Unable to complete request while trying to")
  ) {
    return "jenkins_api_error";
  }
  if (error instanceof CliError) {
    return "validation_error";
  }
  return "unexpected_error";
}

// Drops undefined and non-finite numeric values before events are queued so we
// do not send malformed or noisy properties to PostHog.
function sanitizeProps(properties: AnalyticsProps): AnalyticsProps {
  const sanitized: AnalyticsProps = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

// Treats empty strings as unset so env/config overrides behave consistently.
function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// Parses the small set of boolean-like env values we support.
function parseOptionalBooleanFlag(
  value: string | undefined,
): boolean | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}

// Normalizes the analytics host to a valid absolute URL. If the override is
// invalid, we fall back to the default reverse-proxy host instead of failing.
function normalizeHost(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return DEFAULT_POSTHOG_HOST;
  }
}
