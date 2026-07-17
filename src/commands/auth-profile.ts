/**
 * Local credential-profile management commands under the `auth` group:
 * list, use, current, rename, and logout. These manage credentials stored by
 * this CLI; logout does not revoke the Jenkins-side API token because Jenkins
 * exposes no general token revocation operation to these credentials.
 */
import {
  resolveAuthCredentials,
  type AuthCredentialResolution,
  type AuthDiagnosticsDeps,
  type AuthStatusOptions,
} from "../auth-diagnostics";
import { confirm, isCancel } from "../clack";
import { CliError, printHint } from "../cli";
import {
  deleteAllProfiles,
  deleteProfilesStrict,
  listProfiles,
  renameProfile,
  selectProfile,
  unknownProfileError,
  type ProfileOperationsDeps,
} from "../profile-operations";
import { normalizeProfileName } from "../config";

export type AuthCommandDeps = ProfileOperationsDeps & {
  confirm?: typeof confirm;
};

export type WriteLine = (line: string) => void;

const LOGOUT_LOCAL_ONLY_HINT =
  "Local credentials were removed. The Jenkins-side API token is not revoked; delete it from the Jenkins user configuration page if needed.";

export async function runAuthList(
  deps: ProfileOperationsDeps = {},
  write: WriteLine = console.log,
): Promise<void> {
  const result = await listProfiles(deps);
  if (result.profiles.length === 0) {
    write("OK: No profiles configured.");
    return;
  }
  for (const row of result.profiles) {
    const marker = row.isDefault ? " (default)" : "";
    write(
      `${row.name}${marker}  ${row.jenkinsUrl}  ${row.jenkinsUser}  ${row.tokenStorage}`,
    );
  }
}

export async function runAuthUse(
  name: string,
  deps: ProfileOperationsDeps = {},
  write: WriteLine = console.log,
): Promise<void> {
  const result = await selectProfile(name, deps);
  if (result.changed) {
    write(`OK: Default profile set to "${result.profileName}".`);
  } else {
    write(`OK: Profile "${result.profileName}" is already the default.`);
  }
}

/**
 * Inspection command: reports which credentials would be used, resolved
 * locally with the CLI's established precedence (direct flags, explicit
 * profile, default profile, environment). Never makes a network request and
 * never prints the token; `auth status` remains the network-backed check.
 */
export async function runAuthCurrent(
  options: AuthStatusOptions,
  deps: AuthDiagnosticsDeps = {},
  write: WriteLine = console.log,
): Promise<void> {
  const credentials = await resolveAuthCredentials(options, deps);
  if (credentials.problem) {
    throw new CliError(
      credentials.problemMessage ?? "Authentication is not configured.",
      credentials.problemHints ?? ["Run `jenkins-cli auth login`."],
    );
  }

  const fields: Array<[string, string]> = [
    ["Source:", describeCredentialSource(options, credentials)],
    ["Profile:", credentials.profileLabel || "Unknown"],
    ["Controller:", credentials.controller ?? "Unknown"],
    ["Username:", credentials.username ?? "Unknown"],
    ["Token storage:", credentials.tokenStorage ?? "Unknown"],
    ["Token present:", formatTokenPresence(credentials)],
  ];
  for (const [label, value] of fields) {
    write(`${label.padEnd(18, " ")}${value}`);
  }
  if (credentials.keychainReadError) {
    printHint(
      "The OS secure store could not be read. Unlock your login keychain / keyring, or run `jenkins-cli auth status` for a full check.",
    );
  }
}

export type AuthLogoutOptions = {
  profile?: string;
  all?: boolean;
  nonInteractive: boolean;
};

export async function runAuthLogout(
  options: AuthLogoutOptions,
  deps: AuthCommandDeps = {},
  write: WriteLine = console.log,
): Promise<void> {
  if (options.all && options.profile !== undefined) {
    throw new CliError("--all and --profile are mutually exclusive.", [
      "Pass --all to remove every profile, or --profile <name> for one.",
    ]);
  }

  if (options.all) {
    await runLogoutAll(options, deps, write);
    return;
  }

  const listed = await listProfiles(deps);
  let target: string;
  if (options.profile !== undefined) {
    target = normalizeProfileName(options.profile);
    if (!target) {
      throw new CliError("Profile name is required.", [
        "Run `jenkins-cli auth logout --profile <name>`.",
      ]);
    }
    if (!listed.profiles.some((row) => row.name === target)) {
      throw unknownProfileError(
        target,
        listed.profiles.map((row) => row.name),
      );
    }
  } else {
    if (!listed.defaultProfile) {
      throw new CliError("No active profile to log out.", [
        "Run `jenkins-cli auth logout --profile <name>` to target a profile.",
        "Run `jenkins-cli auth list` to see configured profiles.",
      ]);
    }
    target = listed.defaultProfile;
  }

  await confirmOrAbort(
    options,
    deps,
    `Log out profile "${target}"? This deletes its stored credentials.`,
  );

  const result = await deleteProfilesStrict([target], deps);
  write(`OK: Logged out profile "${target}".`);
  if (result.nextDefault) {
    write(`OK: Default profile is "${result.nextDefault}".`);
  }
  printHint(LOGOUT_LOCAL_ONLY_HINT);
}

export async function runAuthRename(
  oldName: string,
  newName: string,
  deps: ProfileOperationsDeps = {},
  write: WriteLine = console.log,
): Promise<void> {
  const result = await renameProfile(oldName, newName, deps);
  if (!result.changed) {
    write(`OK: Profile "${result.to}" already has that name.`);
    return;
  }
  write(`OK: Renamed profile "${result.from}" to "${result.to}".`);
  if (result.isDefault) {
    write(`OK: Default profile is "${result.to}".`);
  }
}

async function runLogoutAll(
  options: AuthLogoutOptions,
  deps: AuthCommandDeps,
  write: WriteLine,
): Promise<void> {
  const listed = await listProfiles(deps);
  if (listed.profiles.length === 0) {
    write("OK: No profiles configured.");
    return;
  }

  await confirmOrAbort(
    options,
    deps,
    `Log out all ${listed.profiles.length} profile(s)? This deletes every stored credential.`,
  );

  const result = await deleteAllProfiles(deps);
  write(`OK: Logged out ${result.deleted.length} profile(s).`);
  printHint(LOGOUT_LOCAL_ONLY_HINT);
}

async function confirmOrAbort(
  options: AuthLogoutOptions,
  deps: AuthCommandDeps,
  message: string,
): Promise<void> {
  if (options.nonInteractive) {
    return;
  }
  const response = await (deps.confirm ?? confirm)({
    message,
    initialValue: false,
  });
  if (isCancel(response) || !response) {
    throw new CliError("Operation cancelled.");
  }
}

function describeCredentialSource(
  options: AuthStatusOptions,
  credentials: AuthCredentialResolution,
): string {
  if (
    options.url !== undefined ||
    options.user !== undefined ||
    options.apiToken !== undefined
  ) {
    return "Command-line credentials";
  }
  if (options.profile !== undefined) {
    return "Explicit profile (--profile)";
  }
  if (credentials.tokenStorage === "Environment variables") {
    return "Environment variables";
  }
  return "Default profile";
}

function formatTokenPresence(credentials: AuthCredentialResolution): string {
  if (credentials.keychainReadError) {
    return "Unavailable";
  }
  if (credentials.tokenPresent === true) {
    return "Yes";
  }
  if (credentials.tokenPresent === false) {
    return "No";
  }
  return "Unknown";
}
