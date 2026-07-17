import { describe, expect, test } from "bun:test";
import {
  diagnoseAuthentication,
  probeJenkinsIdentity,
  resolveAuthCredentials,
  sanitizeRedirectLocation,
  type AuthDiagnosticsDeps,
  type AuthDiagnosticsResult,
} from "../src/auth-diagnostics";
import { CliError } from "../src/cli";
import {
  authFailureMessage,
  formatAuthReport,
  runAuthStatus,
} from "../src/commands/auth-status";
import { KEYCHAIN_TOKEN_SENTINEL, type JenkinsConfig } from "../src/config";

const controller = "https://jenkins.example.com";

function configWith(
  profiles: JenkinsConfig["profiles"],
  defaultProfile?: string,
): AuthDiagnosticsDeps["readConfig"] {
  return () => ({
    config: {
      version: 2,
      profiles,
      ...(defaultProfile ? { defaultProfile } : {}),
    },
  });
}

function profile(overrides: Partial<JenkinsConfig["profiles"][string]> = {}) {
  return {
    jenkinsUrl: controller,
    jenkinsUser: "configured-user",
    jenkinsApiToken: "configured-token",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

describe("auth credential resolution", () => {
  test("uses a complete direct credential set ahead of a requested profile", async () => {
    let configRead = false;
    const result = await resolveAuthCredentials(
      {
        profile: "prod",
        url: `${controller}/`,
        user: "direct-user",
        apiToken: "direct-token",
      },
      {
        readConfig: () => {
          configRead = true;
          return null;
        },
      },
    );

    expect(configRead).toBeFalse();
    expect(result).toMatchObject({
      profileLabel: "Direct credentials",
      controller,
      username: "direct-user",
      tokenStorage: "Command line",
      tokenPresent: true,
      token: "direct-token",
    });
  });

  test("removes URL credentials, query strings, and fragments from the controller", async () => {
    const result = await resolveAuthCredentials({
      url: "https://embedded:password@jenkins.example.com/team?token=secret#fragment",
      user: "direct-user",
      apiToken: "direct-token",
    });

    expect(result.controller).toBe("https://jenkins.example.com/team");
    expect(result.controller).not.toContain("embedded");
    expect(result.controller).not.toContain("secret");
  });

  test("selects an explicit profile and ignores environment credentials", async () => {
    const result = await resolveAuthCredentials(
      { profile: "prod" },
      {
        readConfig: configWith({ prod: profile() }, "prod"),
        env: {
          JENKINS_URL: "https://environment.example.com",
          JENKINS_USER: "environment-user",
          JENKINS_API_TOKEN: "environment-token",
        },
      },
    );

    expect(result).toMatchObject({
      profileLabel: "prod",
      controller,
      username: "configured-user",
      tokenStorage: "Config file",
      tokenPresent: true,
      token: "configured-token",
    });
  });

  test("uses the configured default profile", async () => {
    const result = await resolveAuthCredentials(
      {},
      {
        readConfig: configWith(
          { first: profile(), prod: profile({ jenkinsUser: "prod-user" }) },
          "prod",
        ),
      },
    );

    expect(result.profileLabel).toBe("prod");
    expect(result.username).toBe("prod-user");
  });

  test("falls back to environment credentials when no profile exists", async () => {
    const result = await resolveAuthCredentials(
      {},
      {
        readConfig: configWith({}),
        env: {
          JENKINS_URL: `${controller}/`,
          JENKINS_USER: "environment-user",
          JENKINS_API_TOKEN: "environment-token",
        },
      },
    );

    expect(result).toMatchObject({
      profileLabel: "Environment",
      controller,
      username: "environment-user",
      tokenStorage: "Environment variables",
      tokenPresent: true,
      token: "environment-token",
    });
  });

  test("reports an unknown requested profile without using environment credentials", async () => {
    const result = await resolveAuthCredentials(
      { profile: "missing" },
      {
        readConfig: configWith({ prod: profile() }, "prod"),
        env: {
          JENKINS_URL: controller,
          JENKINS_USER: "environment-user",
          JENKINS_API_TOKEN: "environment-token",
        },
      },
    );

    expect(result.problem).toBe("unknown-profile");
    expect(result.profileLabel).toBe("missing");
    expect(result.controller).toBeUndefined();
  });

  test("reports incomplete direct credentials instead of falling back", async () => {
    const result = await resolveAuthCredentials(
      { url: controller, user: "direct-user" },
      { readConfig: configWith({ prod: profile() }, "prod") },
    );

    expect(result.problem).toBe("incomplete-direct-credentials");
    expect(result.tokenPresent).toBeFalse();
  });

  test("labels plaintext profile tokens as config file storage", async () => {
    const result = await resolveAuthCredentials(
      { profile: "work" },
      { readConfig: configWith({ work: profile() }) },
    );

    expect(result.tokenStorage).toBe("Config file");
    expect(result.tokenPresent).toBeTrue();
  });

  test("reads and labels a present keychain token", async () => {
    let account = "";
    const result = await resolveAuthCredentials(
      { profile: "work" },
      {
        readConfig: configWith({
          work: profile({
            jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
            tokenStorage: "keychain",
          }),
        }),
        secureStoreLabel: async () => "macOS Keychain",
        getToken: async (value) => {
          account = value;
          return "keychain-token";
        },
      },
    );

    expect(account).toBe("work@jenkins.example.com");
    expect(result).toMatchObject({
      tokenStorage: "macOS Keychain",
      tokenPresent: true,
      token: "keychain-token",
    });
  });

  test("reports a missing keychain token", async () => {
    const result = await resolveAuthCredentials(
      { profile: "work" },
      {
        readConfig: configWith({
          work: profile({
            jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
            tokenStorage: "keychain",
          }),
        }),
        secureStoreLabel: async () => "macOS Keychain",
        getToken: async () => null,
      },
    );

    expect(result.tokenStorage).toBe("macOS Keychain");
    expect(result.tokenPresent).toBeFalse();
    expect(result.keychainReadError).toBeUndefined();
  });

  test("retains a keychain read error for anonymous probing", async () => {
    const result = await resolveAuthCredentials(
      { profile: "work" },
      {
        readConfig: configWith({
          work: profile({
            jenkinsApiToken: KEYCHAIN_TOKEN_SENTINEL,
            tokenStorage: "keychain",
          }),
        }),
        secureStoreLabel: async () => "Freedesktop Secret Service",
        getToken: async () => {
          throw new Error("locked");
        },
      },
    );

    expect(result).toMatchObject({
      controller,
      tokenStorage: "Freedesktop Secret Service",
      keychainReadError: true,
    });
    expect(result.tokenPresent).toBeUndefined();
  });
});

describe("Jenkins authentication probe", () => {
  test("sends Basic auth and extracts the Jenkins identity and version", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const result = await probeJenkinsIdentity(
      { controller, username: "ci", token: "secret-token" },
      {
        fetch: async (url, init) => {
          seenUrl = String(url);
          seenInit = init;
          return jsonResponse(
            { authenticated: true, anonymous: false, name: "ci.full" },
            { headers: { "x-jenkins": "2.516.1" } },
          );
        },
      },
    );

    expect(seenUrl).toBe(`${controller}/whoAmI/api/json`);
    expect(seenInit?.method).toBe("GET");
    expect(seenInit?.redirect).toBe("manual");
    expect(new Headers(seenInit?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("ci:secret-token").toString("base64")}`,
    );
    expect(result).toMatchObject({
      kind: "authenticated",
      authenticated: true,
      anonymous: false,
      jenkinsUser: "ci.full",
      jenkinsVersion: "2.516.1",
    });
  });

  test("omits Authorization when the token is missing", async () => {
    let authorization: string | null = "not-seen";
    const result = await probeJenkinsIdentity(
      { controller, username: "ci" },
      {
        fetch: async (_url, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return jsonResponse({
            authenticated: false,
            anonymous: true,
            name: "anonymous",
          });
        },
      },
    );

    expect(authorization).toBeNull();
    expect(result.kind).toBe("anonymous");
  });

  test("classifies HTTP 401 and HTTP 403 separately", async () => {
    const unauthorized = await probeJenkinsIdentity(
      { controller, username: "ci", token: "bad" },
      { fetch: async () => new Response(null, { status: 401 }) },
    );
    const forbidden = await probeJenkinsIdentity(
      { controller, username: "ci", token: "maybe" },
      { fetch: async () => new Response(null, { status: 403 }) },
    );

    expect(unauthorized.kind).toBe("unauthorized");
    expect(forbidden.kind).toBe("forbidden");
  });

  test("reports redirects with query strings and fragments removed", async () => {
    const result = await probeJenkinsIdentity(
      { controller, username: "ci", token: "secret-token" },
      {
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location:
                "https://sso.example.com/login?return=secret-token#fragment",
            },
          }),
      },
    );

    expect(result).toMatchObject({
      kind: "redirect",
      redirectLocation: "https://sso.example.com/login",
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("return=");
  });

  test("classifies HTML, malformed JSON, and incomplete identity shapes", async () => {
    const html = await probeJenkinsIdentity(
      { controller },
      {
        fetch: async () =>
          new Response("<html>login</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      },
    );
    const malformed = await probeJenkinsIdentity(
      { controller },
      {
        fetch: async () =>
          new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    const incomplete = await probeJenkinsIdentity(
      { controller },
      {
        fetch: async () =>
          jsonResponse({ authenticated: true, name: "ci.full" }),
      },
    );

    expect(html).toMatchObject({
      kind: "unexpected-response",
      unexpectedReason: "html",
    });
    expect(malformed).toMatchObject({
      kind: "unexpected-response",
      unexpectedReason: "malformed-json",
    });
    expect(incomplete).toMatchObject({
      kind: "unexpected-response",
      unexpectedReason: "identity-shape",
    });
  });

  test("does not accept contradictory identity fields", async () => {
    const result = await probeJenkinsIdentity(
      { controller },
      {
        fetch: async () =>
          jsonResponse({
            authenticated: true,
            anonymous: true,
            name: "ci.full",
          }),
      },
    );

    expect(result).toMatchObject({
      kind: "unexpected-response",
      unexpectedReason: "identity-shape",
    });
  });

  test("classifies timeout and network errors without exposing raw errors", async () => {
    const timeout = await probeJenkinsIdentity(
      { controller },
      {
        fetch: async () => {
          throw new DOMException("secret detail", "AbortError");
        },
      },
    );
    const network = await probeJenkinsIdentity(
      { controller },
      {
        fetch: async () => {
          throw new Error("DNS lookup included sensitive detail");
        },
      },
    );

    expect(timeout).toEqual({ kind: "timeout" });
    expect(network).toEqual({ kind: "network-error" });
  });
});

describe("auth status reporting", () => {
  test("renders the stable success report", () => {
    const result: AuthDiagnosticsResult = {
      profileLabel: "work",
      controller,
      username: "jatin",
      tokenStorage: "macOS Keychain",
      tokenPresent: true,
      success: true,
      probe: {
        kind: "authenticated",
        authenticated: true,
        anonymous: false,
        jenkinsUser: "jatin.bansal",
        jenkinsVersion: "2.516.1",
      },
    };

    expect(formatAuthReport(result)).toBe(
      [
        "Profile:          work",
        `Controller:       ${controller}`,
        "Username:         jatin",
        "Token storage:    macOS Keychain",
        "Token present:    Yes",
        "Authenticated:    Yes",
        "Jenkins user:     jatin.bansal",
        "Jenkins version:  2.516.1",
      ].join("\n"),
    );
  });

  test("renders unknown values and a sanitized redirect", () => {
    const report = formatAuthReport({
      profileLabel: "Direct credentials",
      tokenStorage: "Command line",
      tokenPresent: true,
      success: false,
      probe: {
        kind: "redirect",
        httpStatus: 302,
        redirectLocation: "https://sso.example.com/login",
      },
    });

    expect(report).toContain("Controller:       Unknown");
    expect(report).toContain("Authenticated:    Unknown");
    expect(report).toContain("Redirect:         https://sso.example.com/login");
  });

  test("prints the complete report and success summary", async () => {
    const lines: string[] = [];
    await runAuthStatus(
      {},
      {
        diagnose: async () => ({
          profileLabel: "Environment",
          controller,
          username: "ci",
          tokenStorage: "Environment variables",
          tokenPresent: true,
          success: true,
          probe: {
            kind: "authenticated",
            jenkinsUser: "ci",
          },
        }),
      },
      (line) => lines.push(line),
    );

    expect(lines.at(-1)).toBe("OK: Authentication is working.");
    expect(lines.join("\n")).toContain("Jenkins user:     ci");
  });

  test("prints the report before throwing a targeted failure", async () => {
    const lines: string[] = [];
    const failure = runAuthStatus(
      {},
      {
        diagnose: async () => ({
          profileLabel: "work",
          controller,
          username: "ci",
          tokenStorage: "Config file",
          tokenPresent: true,
          success: false,
          probe: { kind: "unauthorized", httpStatus: 401 },
        }),
      },
      (line) => lines.push(line),
    );

    await expect(failure).rejects.toBeInstanceOf(CliError);
    await expect(failure).rejects.toThrow("HTTP 401");
    expect(lines[0]).toContain("Profile:          work");
  });

  test("prioritizes missing-token and keychain remediation while retaining probe evidence", () => {
    const missing = authFailureMessage({
      profileLabel: "work",
      controller,
      username: "ci",
      tokenStorage: "macOS Keychain",
      tokenPresent: false,
      success: false,
      probe: { kind: "anonymous" },
    });
    const inaccessible = authFailureMessage({
      profileLabel: "work",
      controller,
      username: "ci",
      tokenStorage: "macOS Keychain",
      keychainReadError: true,
      success: false,
      probe: { kind: "network-error" },
    });

    expect(missing.message).toContain("No Jenkins API token");
    expect(missing.hints.join(" ")).toContain("treated the probe as anonymous");
    expect(inaccessible.message).toContain("secure store is inaccessible");
    expect(inaccessible.hints.join(" ")).toContain("could not be reached");
  });

  test("diagnosis probes anonymously after a missing token", async () => {
    let authorization: string | null = "not-seen";
    const result = await diagnoseAuthentication(
      {},
      {
        readConfig: configWith({}),
        env: {
          JENKINS_URL: controller,
          JENKINS_USER: "ci",
        },
        fetch: async (_url, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return jsonResponse({
            authenticated: false,
            anonymous: true,
            name: "anonymous",
          });
        },
      },
    );

    expect(authorization).toBeNull();
    expect(result.tokenPresent).toBeFalse();
    expect(result.probe?.kind).toBe("anonymous");
    expect(result.success).toBeFalse();
  });

  test("does not retain the API token in the final diagnostics result", async () => {
    const result = await diagnoseAuthentication(
      {
        url: controller,
        user: "ci",
        apiToken: "secret-token",
      },
      {
        fetch: async () =>
          jsonResponse({
            authenticated: true,
            anonymous: false,
            name: "ci",
          }),
      },
    );

    expect(result.success).toBeTrue();
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("redirect sanitizer supports relative locations and rejects non-http destinations", () => {
    expect(
      sanitizeRedirectLocation(
        "/login?token=secret#fragment",
        `${controller}/whoAmI/api/json`,
      ),
    ).toBe(`${controller}/login`);
    expect(
      sanitizeRedirectLocation(
        "javascript:alert('secret')",
        `${controller}/whoAmI/api/json`,
      ),
    ).toBeUndefined();
  });
});
