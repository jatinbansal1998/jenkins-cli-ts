/**
 * Compatibility `profile` commands. They route through the same shared
 * profile operations as the canonical `auth` commands (list, use, logout) so
 * their behavior cannot drift.
 */
import { confirm, isCancel } from "../clack";
import { CliError } from "../cli";
import { normalizeProfileName } from "../config";
import {
  deleteProfilesStrict,
  listProfiles,
  unknownProfileError,
  type ProfileOperationsDeps,
} from "../profile-operations";
import {
  runAuthList,
  runAuthUse,
  type AuthCommandDeps,
  type WriteLine,
} from "./auth-profile";

type UseProfileOptions = {
  name: string;
};

type DeleteProfileOptions = {
  name: string;
  nonInteractive: boolean;
};

export async function runProfileList(
  deps: ProfileOperationsDeps = {},
  write: WriteLine = console.log,
): Promise<void> {
  await runAuthList(deps, write);
}

export async function runProfileUse(
  options: UseProfileOptions,
  deps: ProfileOperationsDeps = {},
  write: WriteLine = console.log,
): Promise<void> {
  if (!normalizeProfileName(options.name)) {
    throw new CliError("Profile name is required.", [
      "Run `jenkins-cli profile use <name>`.",
    ]);
  }
  await runAuthUse(options.name, deps, write);
}

export async function runProfileDelete(
  options: DeleteProfileOptions,
  deps: AuthCommandDeps = {},
  write: WriteLine = console.log,
): Promise<void> {
  const profileName = normalizeProfileName(options.name);
  if (!profileName) {
    throw new CliError("Profile name is required.", [
      "Run `jenkins-cli profile delete <name>`.",
    ]);
  }

  const listed = await listProfiles(deps);
  if (listed.profiles.length === 0) {
    throw new CliError("No profiles are configured.", [
      "Run `jenkins-cli auth login --profile <name>` to add one.",
    ]);
  }
  if (!listed.profiles.some((row) => row.name === profileName)) {
    throw unknownProfileError(
      profileName,
      listed.profiles.map((row) => row.name),
    );
  }

  if (!options.nonInteractive) {
    const response = await (deps.confirm ?? confirm)({
      message: `Delete profile "${profileName}"?`,
      initialValue: false,
    });
    if (isCancel(response) || !response) {
      throw new CliError("Operation cancelled.");
    }
  }

  const result = await deleteProfilesStrict([profileName], deps);
  write(`OK: Deleted profile "${profileName}".`);
  if (result.nextDefault) {
    write(`OK: Default profile is "${result.nextDefault}".`);
  }
}
