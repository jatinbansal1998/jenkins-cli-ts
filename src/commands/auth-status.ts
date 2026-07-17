import {
  diagnoseAuthentication,
  type AuthDiagnosticsDeps,
  type AuthDiagnosticsResult,
  type AuthStatusOptions,
} from "../auth-diagnostics";
import { CliError } from "../cli";

export type AuthStatusCommandDeps = AuthDiagnosticsDeps & {
  diagnose?: (
    options: AuthStatusOptions,
    deps: AuthDiagnosticsDeps,
  ) => Promise<AuthDiagnosticsResult>;
};

export async function runAuthStatus(
  options: AuthStatusOptions,
  deps: AuthStatusCommandDeps = {},
  write: (line: string) => void = console.log,
): Promise<void> {
  const result = await (deps.diagnose ?? diagnoseAuthentication)(options, deps);
  write(formatAuthReport(result));
  write("");
  if (result.success) {
    write("OK: Authentication is working.");
    return;
  }

  const failure = authFailureMessage(result);
  throw new CliError(failure.message, failure.hints);
}

export function formatAuthReport(result: AuthDiagnosticsResult): string {
  const fields: Array<[string, string]> = [
    ["Profile:", result.profileLabel || "Unknown"],
    ["Controller:", result.controller ?? "Unknown"],
    ["Username:", result.username ?? "Unknown"],
    ["Token storage:", result.tokenStorage ?? "Unknown"],
    ["Token present:", formatBoolean(result.tokenPresent)],
    ["Authenticated:", formatAuthenticated(result)],
    ["Jenkins user:", result.probe?.jenkinsUser ?? "Unknown"],
    ["Jenkins version:", result.probe?.jenkinsVersion ?? "Unknown"],
  ];
  if (result.probe?.redirectLocation) {
    fields.push(["Redirect:", result.probe.redirectLocation]);
  }
  return fields
    .map(([label, value]) => `${label.padEnd(18, " ")}${value}`)
    .join("\n");
}

export function authFailureMessage(result: AuthDiagnosticsResult): {
  message: string;
  hints: string[];
} {
  if (result.problem) {
    return {
      message: result.problemMessage ?? "Authentication is not configured.",
      hints: result.problemHints ?? ["Run `jenkins-cli auth login`."],
    };
  }
  if (result.keychainReadError) {
    return {
      message: "The Jenkins API token secure store is inaccessible.",
      hints: [
        "Unlock the login keychain / keyring and try again.",
        `Run \`jenkins-cli auth login --profile ${result.profileLabel}\` to store the token again.`,
        ...probeContextHints(result),
      ],
    };
  }
  if (result.tokenPresent === false) {
    return {
      message: "No Jenkins API token was found.",
      hints: [
        result.profileLabel === "Environment"
          ? "Set JENKINS_API_TOKEN or run `jenkins-cli auth login`."
          : `Run \`jenkins-cli auth login --profile ${result.profileLabel}\` to store a token.`,
        ...probeContextHints(result),
      ],
    };
  }

  switch (result.probe?.kind) {
    case "unauthorized":
      return {
        message: "Jenkins rejected the supplied credentials (HTTP 401).",
        hints: [
          "Check the username and API token, then run `jenkins-cli auth login` again.",
        ],
      };
    case "forbidden":
      return {
        message:
          "Jenkins denied access to the identity endpoint (HTTP 403), so authentication could not be confirmed.",
        hints: [
          "Check whether this Jenkins user may access /whoAmI/api/json.",
          "A 403 does not prove that the API token is invalid.",
        ],
      };
    case "redirect":
      return {
        message:
          "The Jenkins API request was redirected by SSO or a reverse proxy.",
        hints: [
          result.probe.redirectLocation
            ? `Check the proxy or SSO route at ${result.probe.redirectLocation}.`
            : "Check the Jenkins reverse-proxy or SSO configuration.",
        ],
      };
    case "anonymous":
      return {
        message: "Jenkins treated the request as anonymous.",
        hints: [
          "Check the username and API token, then run `jenkins-cli auth login` again.",
        ],
      };
    case "timeout":
      return {
        message:
          "The Jenkins controller could not be reached before the request timed out.",
        hints: [
          "Check the controller URL, network, VPN, proxy, and firewall, then try again.",
        ],
      };
    case "network-error":
      return {
        message:
          "The Jenkins controller could not be reached because of a network, DNS, TLS, or connection error.",
        hints: [
          "Check the controller URL, network, VPN, TLS trust, proxy, and firewall, then try again.",
        ],
      };
    case "unexpected-response":
      return unexpectedResponseFailure(result);
    default:
      return {
        message: "Authentication could not be confirmed.",
        hints: ["Check the Jenkins controller and run the command again."],
      };
  }
}

function unexpectedResponseFailure(result: AuthDiagnosticsResult): {
  message: string;
  hints: string[];
} {
  const reason = result.probe?.unexpectedReason;
  if (reason === "html") {
    return {
      message: "The identity endpoint returned HTML instead of Jenkins JSON.",
      hints: [
        "Check whether a proxy or SSO login page intercepted the request.",
      ],
    };
  }
  if (reason === "malformed-json") {
    return {
      message: "The identity endpoint returned malformed JSON.",
      hints: [
        "Check the Jenkins controller, reverse proxy, and SSO configuration.",
      ],
    };
  }
  if (reason === "http-status") {
    return {
      message: `The identity endpoint returned unexpected HTTP ${result.probe?.httpStatus ?? "status"}.`,
      hints: [
        "Check the Jenkins controller, reverse proxy, and SSO configuration.",
      ],
    };
  }
  return {
    message:
      "The identity endpoint returned an incomplete or contradictory identity.",
    hints: [
      "Check the Jenkins controller, reverse proxy, and SSO configuration.",
    ],
  };
}

function probeContextHints(result: AuthDiagnosticsResult): string[] {
  switch (result.probe?.kind) {
    case "anonymous":
      return ["The controller responded but treated the probe as anonymous."];
    case "redirect":
      return result.probe.redirectLocation
        ? [
            `The controller redirected the probe to ${result.probe.redirectLocation}.`,
          ]
        : ["The controller redirected the anonymous probe."];
    case "timeout":
    case "network-error":
      return [
        "The controller could not be reached during the anonymous probe.",
      ];
    default:
      return [];
  }
}

function formatAuthenticated(result: AuthDiagnosticsResult): string {
  switch (result.probe?.kind) {
    case "authenticated":
      return "Yes";
    case "anonymous":
    case "unauthorized":
      return "No";
    default:
      return "Unknown";
  }
}

function formatBoolean(value: boolean | undefined): string {
  if (value === true) {
    return "Yes";
  }
  if (value === false) {
    return "No";
  }
  return "Unknown";
}
