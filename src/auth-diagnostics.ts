import { recordJenkinsApiCall, recordJenkinsApiFailure } from "./analytics";
import {
  CONFIG_FILE,
  readConfigSync,
  resolveDefaultProfileName,
  type JenkinsConfig,
  type JenkinsProfileConfig,
} from "./config";
import { normalizeUrl } from "./env";
import { ENV_KEYS } from "./env-keys";
import {
  logApiError,
  logApiRequest,
  logApiResponse,
  logNetworkError,
} from "./logger";
import {
  buildSecureStoreAccount,
  getToken,
  secureStoreLabel,
} from "./secure-store";

export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export type AuthStatusOptions = {
  profile?: string;
  url?: string;
  user?: string;
  apiToken?: string;
};

export type AuthCredentialProblem =
  | "incomplete-direct-credentials"
  | "unknown-profile"
  | "config-read-error"
  | "invalid-controller-url"
  | "missing-environment-url"
  | "missing-environment-user";

export type AuthCredentialResolution = {
  profileLabel: string;
  controller?: string;
  username?: string;
  tokenStorage?: string;
  tokenPresent?: boolean;
  token?: string;
  problem?: AuthCredentialProblem;
  problemMessage?: string;
  problemHints?: string[];
  keychainReadError?: boolean;
};

export type AuthProbeKind =
  | "authenticated"
  | "anonymous"
  | "unauthorized"
  | "forbidden"
  | "redirect"
  | "unexpected-response"
  | "timeout"
  | "network-error";

export type UnexpectedAuthResponseReason =
  "html" | "malformed-json" | "identity-shape" | "http-status";

export type AuthProbeResult = {
  kind: AuthProbeKind;
  httpStatus?: number;
  contentType?: string;
  redirectLocation?: string;
  jenkinsVersion?: string;
  authenticated?: boolean;
  anonymous?: boolean;
  jenkinsUser?: string;
  unexpectedReason?: UnexpectedAuthResponseReason;
};

export type AuthDiagnosticsResult = Omit<AuthCredentialResolution, "token"> & {
  probe?: AuthProbeResult;
  success: boolean;
};

export type AuthDiagnosticsDeps = {
  readConfig?: () =>
    | { config: JenkinsConfig }
    | null
    | Promise<{ config: JenkinsConfig } | null>;
  env?: Record<string, string | undefined>;
  getToken?: (account: string) => Promise<string | null>;
  secureStoreLabel?: () => Promise<string>;
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  timeoutMs?: number;
};

/**
 * Resolves credentials without using the normal command bootstrap. Expected
 * diagnostic failures are retained in the result instead of being thrown.
 */
export async function resolveAuthCredentials(
  options: AuthStatusOptions,
  deps: AuthDiagnosticsDeps = {},
): Promise<AuthCredentialResolution> {
  const cliUrl = normalizeOptionalString(options.url);
  const cliUser = normalizeOptionalString(options.user);
  const cliToken = normalizeOptionalString(options.apiToken);
  const requestedProfile = normalizeOptionalString(options.profile);
  const hasAnyDirectFlag =
    options.url !== undefined ||
    options.user !== undefined ||
    options.apiToken !== undefined;

  if (hasAnyDirectFlag && !(cliUrl && cliUser && cliToken)) {
    return {
      profileLabel: "Direct credentials",
      controller: normalizeControllerIfValid(cliUrl),
      username: cliUser,
      tokenStorage: "Command line",
      tokenPresent: cliToken ? true : false,
      problem: "incomplete-direct-credentials",
      problemMessage: "Incomplete direct Jenkins credentials.",
      problemHints: [
        "Pass --url, --user, and --token together.",
        "Or omit all three options to use a configured profile or environment credentials.",
      ],
    };
  }

  if (cliUrl && cliUser && cliToken) {
    return directCredentials(cliUrl, cliUser, cliToken);
  }

  let config: JenkinsConfig | undefined;
  try {
    config = (await (deps.readConfig ?? readAuthConfig)())?.config;
  } catch {
    return {
      profileLabel: requestedProfile ?? "Unknown",
      problem: "config-read-error",
      problemMessage: "Unable to read the Jenkins CLI configuration.",
      problemHints: ["Check the config file format and permissions."],
    };
  }

  if (requestedProfile) {
    const profile = config?.profiles[requestedProfile];
    if (!profile) {
      return {
        profileLabel: requestedProfile,
        problem: "unknown-profile",
        problemMessage: `Profile "${requestedProfile}" is not configured.`,
        problemHints: [
          "Run `jenkins-cli profile list` to see configured profiles.",
          `Run \`jenkins-cli auth login --profile ${requestedProfile}\` to create it.`,
        ],
      };
    }
    return await configuredProfile(requestedProfile, profile, deps);
  }

  const defaultProfile = config ? resolveDefaultProfileName(config) : undefined;
  if (defaultProfile && config) {
    return await configuredProfile(
      defaultProfile,
      config.profiles[defaultProfile]!,
      deps,
    );
  }

  return environmentCredentials(deps.env ?? process.env);
}

/** Performs the one read-only Jenkins identity request. */
export async function probeJenkinsIdentity(
  input: {
    controller: string;
    username?: string;
    token?: string;
  },
  deps: Pick<AuthDiagnosticsDeps, "fetch" | "timeoutMs"> = {},
): Promise<AuthProbeResult> {
  const requestUrl = `${input.controller}/whoAmI/api/json`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.username && input.token) {
    const encoded = Buffer.from(`${input.username}:${input.token}`).toString(
      "base64",
    );
    headers.Authorization = `Basic ${encoded}`;
  }

  recordJenkinsApiCall();
  logApiRequest("GET", requestUrl, headers, null);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? AUTH_PROBE_TIMEOUT_MS,
  );

  try {
    const response = await (deps.fetch ?? globalThis.fetch)(requestUrl, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    const responseHeaders = sanitizedResponseHeaders(
      response.headers,
      requestUrl,
    );
    if (response.ok) {
      logApiResponse("GET", requestUrl, response.status, responseHeaders, null);
    } else {
      logApiError("GET", requestUrl, response.status, responseHeaders, null);
    }

    const common = responseMetadata(response);
    if (response.status === 401) {
      recordHttpProbeFailure(response.status);
      return { kind: "unauthorized", ...common };
    }
    if (response.status === 403) {
      recordHttpProbeFailure(response.status);
      return { kind: "forbidden", ...common };
    }
    if (response.status >= 300 && response.status < 400) {
      recordHttpProbeFailure(response.status);
      return {
        kind: "redirect",
        ...common,
        redirectLocation: sanitizeRedirectLocation(
          response.headers.get("location"),
          requestUrl,
        ),
      };
    }
    if (response.status !== 200) {
      recordHttpProbeFailure(response.status);
      return {
        kind: "unexpected-response",
        ...common,
        unexpectedReason: "http-status",
      };
    }

    const body = await response.text();
    if (isHtml(common.contentType, body)) {
      recordInvalidJsonProbeFailure(response.status);
      return {
        kind: "unexpected-response",
        ...common,
        unexpectedReason: "html",
      };
    }

    let identity: unknown;
    try {
      identity = JSON.parse(body);
    } catch {
      recordInvalidJsonProbeFailure(response.status);
      return {
        kind: "unexpected-response",
        ...common,
        unexpectedReason: "malformed-json",
      };
    }

    const fields = parseIdentityFields(identity);
    if (
      fields.authenticated === true &&
      fields.anonymous === false &&
      fields.jenkinsUser
    ) {
      return { kind: "authenticated", ...common, ...fields };
    }
    if (fields.authenticated === false && fields.anonymous === true) {
      return { kind: "anonymous", ...common, ...fields };
    }
    return {
      kind: "unexpected-response",
      ...common,
      ...fields,
      unexpectedReason: "identity-shape",
    };
  } catch (error) {
    if (isAbortError(error)) {
      logNetworkError("GET", requestUrl, "TIMEOUT");
      recordJenkinsApiFailure({
        operation: "auth_status",
        errorType: "timeout",
      });
      return { kind: "timeout" };
    }
    logNetworkError("GET", requestUrl, "NETWORK_ERROR");
    recordJenkinsApiFailure({
      operation: "auth_status",
      errorType: "network_error",
    });
    return { kind: "network-error" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function diagnoseAuthentication(
  options: AuthStatusOptions,
  deps: AuthDiagnosticsDeps = {},
): Promise<AuthDiagnosticsResult> {
  const credentials = await resolveAuthCredentials(options, deps);
  const probe = credentials.controller
    ? await probeJenkinsIdentity(
        {
          controller: credentials.controller,
          username: credentials.username,
          token: credentials.token,
        },
        deps,
      )
    : undefined;
  const success =
    !credentials.problem &&
    !credentials.keychainReadError &&
    credentials.tokenPresent === true &&
    probe?.kind === "authenticated";
  const { token: _token, ...safeCredentials } = credentials;
  return { ...safeCredentials, probe, success };
}

export function sanitizeRedirectLocation(
  location: string | null,
  requestUrl: string,
): string | undefined {
  if (!location) {
    return undefined;
  }
  try {
    const url = new URL(location, requestUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

async function readAuthConfig(): Promise<{ config: JenkinsConfig } | null> {
  const loaded = readConfigSync();
  if (!loaded) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(CONFIG_FILE).text());
  } catch {
    return loaded;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return loaded;
  }

  const rawRecord = raw as Record<string, unknown>;
  const rawProfiles = rawRecord.profiles;
  if (
    !rawProfiles ||
    typeof rawProfiles !== "object" ||
    Array.isArray(rawProfiles)
  ) {
    return loaded;
  }

  const profiles = { ...loaded.config.profiles };
  for (const [rawName, rawProfile] of Object.entries(
    rawProfiles as Record<string, unknown>,
  )) {
    const name = rawName.trim();
    if (!name || profiles[name]) {
      continue;
    }
    const incompleteProfile = parseIncompleteAuthProfile(rawProfile);
    if (incompleteProfile) {
      profiles[name] = incompleteProfile;
    }
  }

  const requestedDefault = normalizeUnknownString(rawRecord.defaultProfile);
  const defaultProfile =
    requestedDefault && profiles[requestedDefault]
      ? requestedDefault
      : loaded.config.defaultProfile;
  return {
    config: {
      ...loaded.config,
      profiles,
      ...(defaultProfile ? { defaultProfile } : {}),
    },
  };
}

function parseIncompleteAuthProfile(
  value: unknown,
): JenkinsProfileConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const jenkinsUrl = pickUnknownString(record, [
    "jenkinsUrl",
    ENV_KEYS.JENKINS_URL,
  ]);
  const jenkinsUser = pickUnknownString(record, [
    "jenkinsUser",
    "accountName",
    ENV_KEYS.JENKINS_USER,
  ]);
  if (!jenkinsUrl || !jenkinsUser) {
    return undefined;
  }
  const rawToken = firstUnknownString(record, [
    "jenkinsApiToken",
    "apiToken",
    ENV_KEYS.JENKINS_API_TOKEN,
  ]);
  return {
    jenkinsUrl,
    jenkinsUser,
    jenkinsApiToken: rawToken?.trim() ?? "",
    ...(record.tokenStorage === "keychain"
      ? { tokenStorage: "keychain" as const }
      : {}),
  };
}

function pickUnknownString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  return normalizeUnknownString(firstUnknownString(record, keys));
}

function firstUnknownString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function normalizeUnknownString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function directCredentials(
  url: string,
  username: string,
  token: string,
): AuthCredentialResolution {
  try {
    return {
      profileLabel: "Direct credentials",
      controller: normalizeControllerUrl(url),
      username,
      tokenStorage: "Command line",
      tokenPresent: true,
      token,
    };
  } catch {
    return invalidController(
      "Direct credentials",
      username,
      "Command line",
      true,
    );
  }
}

async function configuredProfile(
  profileName: string,
  profile: JenkinsProfileConfig,
  deps: AuthDiagnosticsDeps,
): Promise<AuthCredentialResolution> {
  let controller: string;
  try {
    controller = normalizeControllerUrl(profile.jenkinsUrl);
  } catch {
    return invalidController(
      profileName,
      normalizeOptionalString(profile.jenkinsUser),
      profile.tokenStorage === "keychain" ? "OS secure store" : "Config file",
      profile.tokenStorage === "keychain"
        ? undefined
        : Boolean(normalizeOptionalString(profile.jenkinsApiToken)),
    );
  }

  const username = normalizeOptionalString(profile.jenkinsUser);
  if (profile.tokenStorage !== "keychain") {
    const token = normalizeOptionalString(profile.jenkinsApiToken);
    return {
      profileLabel: profileName,
      controller,
      username,
      tokenStorage: "Config file",
      tokenPresent: Boolean(token),
      token,
    };
  }

  const label = await safeSecureStoreLabel(deps);
  const account = buildSecureStoreAccount(profileName, controller);
  try {
    const token = normalizeOptionalString(
      await (deps.getToken ?? getToken)(account),
    );
    return {
      profileLabel: profileName,
      controller,
      username,
      tokenStorage: label,
      tokenPresent: Boolean(token),
      token,
    };
  } catch {
    return {
      profileLabel: profileName,
      controller,
      username,
      tokenStorage: label,
      tokenPresent: undefined,
      keychainReadError: true,
    };
  }
}

function environmentCredentials(
  env: Record<string, string | undefined>,
): AuthCredentialResolution {
  const rawUrl = normalizeOptionalString(env[ENV_KEYS.JENKINS_URL]);
  const username = normalizeOptionalString(env[ENV_KEYS.JENKINS_USER]);
  const token = normalizeOptionalString(env[ENV_KEYS.JENKINS_API_TOKEN]);
  if (!rawUrl) {
    return {
      profileLabel: "Environment",
      username,
      tokenStorage: "Environment variables",
      tokenPresent: Boolean(token),
      problem: "missing-environment-url",
      problemMessage: `Missing ${ENV_KEYS.JENKINS_URL}.`,
      problemHints: [
        `Set ${ENV_KEYS.JENKINS_URL} or run \`jenkins-cli auth login\`.`,
      ],
    };
  }

  let controller: string;
  try {
    controller = normalizeControllerUrl(rawUrl);
  } catch {
    return invalidController(
      "Environment",
      username,
      "Environment variables",
      Boolean(token),
    );
  }

  if (!username) {
    return {
      profileLabel: "Environment",
      controller,
      tokenStorage: "Environment variables",
      tokenPresent: Boolean(token),
      token,
      problem: "missing-environment-user",
      problemMessage: `Missing ${ENV_KEYS.JENKINS_USER}.`,
      problemHints: [
        `Set ${ENV_KEYS.JENKINS_USER} or run \`jenkins-cli auth login\`.`,
      ],
    };
  }

  return {
    profileLabel: "Environment",
    controller,
    username,
    tokenStorage: "Environment variables",
    tokenPresent: Boolean(token),
    token,
  };
}

function invalidController(
  profileLabel: string,
  username?: string,
  tokenStorage?: string,
  tokenPresent?: boolean,
): AuthCredentialResolution {
  return {
    profileLabel,
    username,
    tokenStorage,
    tokenPresent,
    problem: "invalid-controller-url",
    problemMessage: "The Jenkins controller URL is invalid.",
    problemHints: ["Use a full http:// or https:// Jenkins URL."],
  };
}

function normalizeControllerIfValid(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return normalizeControllerUrl(value);
  } catch {
    return undefined;
  }
}

function normalizeControllerUrl(value: string): string {
  const url = new URL(normalizeUrl(value));
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function safeSecureStoreLabel(
  deps: AuthDiagnosticsDeps,
): Promise<string> {
  try {
    return await (deps.secureStoreLabel ?? secureStoreLabel)();
  } catch {
    return "OS secure store";
  }
}

function responseMetadata(response: Response): Omit<AuthProbeResult, "kind"> {
  const contentType = normalizeOptionalString(
    response.headers.get("content-type") ?? undefined,
  );
  const jenkinsVersion = normalizeOptionalString(
    response.headers.get("x-jenkins") ?? undefined,
  );
  return {
    httpStatus: response.status,
    contentType,
    jenkinsVersion,
  };
}

function parseIdentityFields(
  identity: unknown,
): Pick<AuthProbeResult, "authenticated" | "anonymous" | "jenkinsUser"> {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return {};
  }
  const record = identity as Record<string, unknown>;
  return {
    authenticated:
      typeof record.authenticated === "boolean"
        ? record.authenticated
        : undefined,
    anonymous:
      typeof record.anonymous === "boolean" ? record.anonymous : undefined,
    jenkinsUser:
      typeof record.name === "string"
        ? normalizeOptionalString(record.name)
        : undefined,
  };
}

function sanitizedResponseHeaders(
  headers: Headers,
  requestUrl: string,
): Headers {
  const sanitized = new Headers(headers);
  if (sanitized.has("location")) {
    sanitized.set(
      "location",
      sanitizeRedirectLocation(sanitized.get("location"), requestUrl) ??
        "<omitted>",
    );
  }
  return sanitized;
}

function recordHttpProbeFailure(httpStatus: number): void {
  recordJenkinsApiFailure({
    operation: "auth_status",
    errorType: "http_error",
    httpStatus,
  });
}

function recordInvalidJsonProbeFailure(httpStatus: number): void {
  recordJenkinsApiFailure({
    operation: "auth_status",
    errorType: "invalid_json",
    httpStatus,
  });
}

function isHtml(contentType: string | undefined, body: string): boolean {
  return (
    contentType?.toLowerCase().includes("text/html") === true ||
    /^\s*<!doctype\s+html/i.test(body) ||
    /^\s*<html[\s>]/i.test(body)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
