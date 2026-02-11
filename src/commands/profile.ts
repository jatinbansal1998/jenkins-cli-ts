import { confirm, isCancel } from "@clack/prompts";
import { CliError, printOk } from "../cli";
import {
  migrateLegacyConfigIfNeeded,
  normalizeProfileName,
  resolveDefaultProfileName,
  writeConfig,
} from "../config";

type UseProfileOptions = {
  name: string;
};

type DeleteProfileOptions = {
  name: string;
  nonInteractive: boolean;
};

export async function runProfileList(): Promise<void> {
  const loaded = await migrateLegacyConfigIfNeeded();
  const config = loaded?.config;
  const profiles = config?.profiles ?? {};
  const names = Object.keys(profiles);
  if (names.length === 0) {
    printOk("No profiles configured.");
    return;
  }

  const defaultProfile = resolveDefaultProfileName({
    profiles,
    defaultProfile: config?.defaultProfile,
  });
  for (const name of names) {
    const profile = profiles[name];
    if (!profile) {
      continue;
    }
    const marker = name === defaultProfile ? " (default)" : "";
    console.log(
      `${name}${marker}  ${profile.jenkinsUrl}  ${profile.jenkinsUser}`,
    );
  }
}

export async function runProfileUse(options: UseProfileOptions): Promise<void> {
  const profileName = normalizeProfileName(options.name);
  if (!profileName) {
    throw new CliError("Profile name is required.", [
      "Run `jenkins-cli profile use <name>`.",
    ]);
  }

  const loaded = await migrateLegacyConfigIfNeeded();
  const config = loaded?.config;
  const profiles = config?.profiles ?? {};
  const names = Object.keys(profiles);
  if (names.length === 0) {
    throw new CliError("No profiles are configured.", [
      "Run `jenkins-cli login --profile <name>` to add one.",
    ]);
  }
  if (!profiles[profileName]) {
    throw new CliError(`Profile "${profileName}" was not found.`, [
      `Available profiles: ${names.join(", ")}.`,
    ]);
  }

  if (config?.defaultProfile === profileName) {
    printOk(`Profile "${profileName}" is already the default.`);
    return;
  }

  await writeConfig({
    ...(config ?? { version: 2, profiles }),
    defaultProfile: profileName,
  });
  printOk(`Default profile set to "${profileName}".`);
}

export async function runProfileDelete(
  options: DeleteProfileOptions,
): Promise<void> {
  const profileName = normalizeProfileName(options.name);
  if (!profileName) {
    throw new CliError("Profile name is required.", [
      "Run `jenkins-cli profile delete <name>`.",
    ]);
  }

  const loaded = await migrateLegacyConfigIfNeeded();
  const config = loaded?.config;
  const profiles = config?.profiles ?? {};
  const names = Object.keys(profiles);
  if (names.length === 0) {
    throw new CliError("No profiles are configured.", [
      "Run `jenkins-cli login --profile <name>` to add one.",
    ]);
  }
  if (!profiles[profileName]) {
    throw new CliError(`Profile "${profileName}" was not found.`, [
      `Available profiles: ${names.join(", ")}.`,
    ]);
  }

  if (!options.nonInteractive) {
    const response = await confirm({
      message: `Delete profile "${profileName}"?`,
      initialValue: false,
    });
    if (isCancel(response)) {
      throw new CliError("Operation cancelled.");
    }
    if (!response) {
      throw new CliError("Operation cancelled.");
    }
  }

  const remainingProfiles = { ...profiles };
  delete remainingProfiles[profileName];
  const nextDefault = resolveDefaultProfileName({
    profiles: remainingProfiles,
    defaultProfile:
      config?.defaultProfile === profileName
        ? undefined
        : config?.defaultProfile,
  });

  await writeConfig({
    version: 2,
    profiles: remainingProfiles,
    ...(nextDefault ? { defaultProfile: nextDefault } : {}),
    ...(typeof config?.debug === "boolean" ? { debug: config.debug } : {}),
  });

  printOk(`Deleted profile "${profileName}".`);
  if (nextDefault) {
    printOk(`Default profile is "${nextDefault}".`);
  }
}
