import fs from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError } from "./cli";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "jenkins-cli");
export const CONFIG_FILE = path.join(CONFIG_DIR, "jenkins-cli-config.json");
export const DEFAULT_PROFILE_NAME = "default";
const CONFIG_VERSION = 2;

export type ConfigFileInput = {
  profile?: string;
  jenkinsUrl: string;
  jenkinsUser: string;
  jenkinsApiToken: string;
  branchParam?: string;
  useCrumb?: boolean;
  debug?: boolean;
  makeDefault?: boolean;
};

export type JenkinsProfileConfig = {
  jenkinsUrl: string;
  jenkinsUser: string;
  jenkinsApiToken: string;
  branchParam?: string;
  useCrumb?: boolean;
};

export type JenkinsConfig = {
  version: 2;
  defaultProfile?: string;
  profiles: Record<string, JenkinsProfileConfig>;
  debug?: boolean;
};

export type LoadedConfig = {
  config: JenkinsConfig;
  legacyDetected: boolean;
};

export function createEmptyConfig(): JenkinsConfig {
  return {
    version: CONFIG_VERSION,
    profiles: {},
  };
}

export function normalizeProfileName(name: string): string {
  return name.trim();
}

export function resolveDefaultProfileName(
  config: Pick<JenkinsConfig, "profiles" | "defaultProfile">,
): string | undefined {
  if (config.defaultProfile && config.profiles[config.defaultProfile]) {
    return config.defaultProfile;
  }
  const names = Object.keys(config.profiles);
  return names[0];
}

export function readConfigSync(): LoadedConfig | null {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return parseConfigContents(raw, CONFIG_FILE);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("Unable to read config file.", [
      `Check permissions for ${CONFIG_FILE}.`,
    ]);
  }
}

export async function readConfig(): Promise<LoadedConfig | null> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    return parseConfigContents(raw, CONFIG_FILE);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("Unable to read config file.", [
      `Check permissions for ${CONFIG_FILE}.`,
    ]);
  }
}

export async function writeConfig(config: JenkinsConfig): Promise<string> {
  const normalized = normalizeConfigForWrite(config);
  await writeNormalizedConfigAsync(normalized);
  return CONFIG_FILE;
}

export function writeConfigSync(config: JenkinsConfig): string {
  const normalized = normalizeConfigForWrite(config);
  writeNormalizedConfigSync(normalized);
  return CONFIG_FILE;
}

export async function writeConfigFile(input: ConfigFileInput): Promise<string> {
  const loaded = await readConfig();
  const current = loaded?.config ?? createEmptyConfig();
  const profileName = normalizeProfileName(
    input.profile ?? resolveDefaultProfileName(current) ?? DEFAULT_PROFILE_NAME,
  );
  if (!profileName) {
    throw new CliError("Profile name is required.", [
      "Pass --profile <name> to select a profile.",
    ]);
  }

  const existingProfile = current.profiles[profileName];
  const branchParam =
    normalizeOptionalString(input.branchParam) ?? existingProfile?.branchParam;
  const useCrumb =
    typeof input.useCrumb === "boolean"
      ? input.useCrumb
      : existingProfile?.useCrumb;

  const nextProfile: JenkinsProfileConfig = {
    jenkinsUrl: input.jenkinsUrl.trim(),
    jenkinsUser: input.jenkinsUser.trim(),
    jenkinsApiToken: input.jenkinsApiToken.trim(),
    ...(branchParam ? { branchParam } : {}),
    ...(typeof useCrumb === "boolean" ? { useCrumb } : {}),
  };

  const profiles = {
    ...current.profiles,
    [profileName]: nextProfile,
  };

  const defaultProfile = resolveNextDefaultProfile({
    currentDefault: current.defaultProfile,
    profileName,
    profiles,
    makeDefault: input.makeDefault,
  });

  const payload: JenkinsConfig = {
    version: CONFIG_VERSION,
    profiles,
    ...(defaultProfile ? { defaultProfile } : {}),
    ...(typeof input.debug === "boolean"
      ? { debug: input.debug }
      : typeof current.debug === "boolean"
        ? { debug: current.debug }
        : {}),
  };

  return await writeConfig(payload);
}

export async function migrateLegacyConfigIfNeeded(): Promise<LoadedConfig | null> {
  const loaded = await readConfig();
  if (!loaded || !loaded.legacyDetected) {
    return loaded;
  }
  await writeConfig(loaded.config);
  return {
    config: loaded.config,
    legacyDetected: false,
  };
}

export function migrateLegacyConfigSyncIfNeeded(): LoadedConfig | null {
  const loaded = readConfigSync();
  if (!loaded || !loaded.legacyDetected) {
    return loaded;
  }
  try {
    writeConfigSync(loaded.config);
    return {
      config: loaded.config,
      legacyDetected: false,
    };
  } catch {
    // Best-effort migration. Runtime should continue using parsed legacy data.
    return loaded;
  }
}

function parseConfigContents(
  contents: string,
  configPath: string,
): LoadedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new CliError("Invalid config file JSON.", [
      `Fix the JSON in ${configPath}.`,
    ]);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Invalid config file format.", [
      `Expected a JSON object in ${configPath}.`,
    ]);
  }

  const record = parsed as Record<string, unknown>;
  const parsedProfiles = parseProfiles(record, configPath);
  const hasProfileEntries = Object.keys(parsedProfiles).length > 0;
  const defaultProfileCandidate = normalizeOptionalString(
    record.defaultProfile,
  );
  const legacyProfile = hasProfileEntries
    ? undefined
    : parseLegacyProfile(record);

  const profiles =
    legacyProfile && !hasProfileEntries
      ? {
          [defaultProfileCandidate ?? DEFAULT_PROFILE_NAME]: legacyProfile,
        }
      : parsedProfiles;
  const defaultProfile =
    defaultProfileCandidate && profiles[defaultProfileCandidate]
      ? defaultProfileCandidate
      : resolveDefaultProfileName({
          profiles,
          defaultProfile: undefined,
        });
  const debug = parseBooleanLike(record.debug ?? record.JENKINS_DEBUG);

  return {
    config: {
      version: CONFIG_VERSION,
      profiles,
      ...(defaultProfile ? { defaultProfile } : {}),
      ...(debug !== undefined ? { debug } : {}),
    },
    legacyDetected: Boolean(legacyProfile),
  };
}

function parseProfiles(
  record: Record<string, unknown>,
  configPath: string,
): Record<string, JenkinsProfileConfig> {
  if (!Object.prototype.hasOwnProperty.call(record, "profiles")) {
    return {};
  }

  const rawProfiles = record.profiles;
  if (
    !rawProfiles ||
    typeof rawProfiles !== "object" ||
    Array.isArray(rawProfiles)
  ) {
    throw new CliError("Invalid config file format.", [
      `Expected "profiles" to be an object in ${configPath}.`,
    ]);
  }

  const result: Record<string, JenkinsProfileConfig> = {};
  const entries = Object.entries(rawProfiles as Record<string, unknown>);
  for (const [rawName, rawProfile] of entries) {
    const profileName = normalizeProfileName(rawName);
    if (!profileName) {
      continue;
    }
    const parsedProfile = parseProfileRecord(rawProfile);
    if (!parsedProfile) {
      continue;
    }
    result[profileName] = parsedProfile;
  }
  return result;
}

function parseLegacyProfile(
  record: Record<string, unknown>,
): JenkinsProfileConfig | undefined {
  return parseProfileRecord(record);
}

function parseProfileRecord(
  rawProfile: unknown,
): JenkinsProfileConfig | undefined {
  if (
    !rawProfile ||
    typeof rawProfile !== "object" ||
    Array.isArray(rawProfile)
  ) {
    return undefined;
  }
  const record = rawProfile as Record<string, unknown>;
  const jenkinsUrl = pickString(record, ["jenkinsUrl", "JENKINS_URL"]);
  const jenkinsUser = pickString(record, [
    "jenkinsUser",
    "accountName",
    "JENKINS_USER",
  ]);
  const jenkinsApiToken = pickString(record, [
    "jenkinsApiToken",
    "apiToken",
    "JENKINS_API_TOKEN",
  ]);
  if (!jenkinsUrl || !jenkinsUser || !jenkinsApiToken) {
    return undefined;
  }

  const branchParam = pickString(record, [
    "branchParam",
    "jenkinsBranchParam",
    "JENKINS_BRANCH_PARAM",
  ]);
  const useCrumb = firstBoolean(record, [
    "useCrumb",
    "jenkinsUseCrumb",
    "JENKINS_USE_CRUMB",
  ]);

  return {
    jenkinsUrl,
    jenkinsUser,
    jenkinsApiToken,
    ...(branchParam ? { branchParam } : {}),
    ...(typeof useCrumb === "boolean" ? { useCrumb } : {}),
  };
}

function resolveNextDefaultProfile(options: {
  currentDefault?: string;
  profileName: string;
  profiles: Record<string, JenkinsProfileConfig>;
  makeDefault?: boolean;
}): string | undefined {
  if (options.makeDefault === true) {
    return options.profileName;
  }
  if (
    options.currentDefault &&
    Object.prototype.hasOwnProperty.call(
      options.profiles,
      options.currentDefault,
    )
  ) {
    return options.currentDefault;
  }
  if (options.makeDefault === false) {
    return resolveDefaultProfileName({
      profiles: options.profiles,
      defaultProfile: undefined,
    });
  }
  return options.profileName;
}

function normalizeConfigForWrite(config: JenkinsConfig): JenkinsConfig {
  const profiles: Record<string, JenkinsProfileConfig> = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    const normalizedName = normalizeProfileName(name);
    if (!normalizedName) {
      continue;
    }
    profiles[normalizedName] = {
      jenkinsUrl: profile.jenkinsUrl.trim(),
      jenkinsUser: profile.jenkinsUser.trim(),
      jenkinsApiToken: profile.jenkinsApiToken.trim(),
      ...(normalizeOptionalString(profile.branchParam)
        ? { branchParam: normalizeOptionalString(profile.branchParam) }
        : {}),
      ...(typeof profile.useCrumb === "boolean"
        ? { useCrumb: profile.useCrumb }
        : {}),
    };
  }
  const defaultProfile = resolveDefaultProfileName({
    profiles,
    defaultProfile: config.defaultProfile,
  });
  return {
    version: CONFIG_VERSION,
    profiles,
    ...(defaultProfile ? { defaultProfile } : {}),
    ...(typeof config.debug === "boolean" ? { debug: config.debug } : {}),
  };
}

async function writeNormalizedConfigAsync(
  config: JenkinsConfig,
): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(CONFIG_FILE, contents, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(CONFIG_FILE, 0o600);
  } catch {
    // Best-effort permission hardening.
  }
}

function writeNormalizedConfigSync(config: JenkinsConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(CONFIG_FILE, contents, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Best-effort permission hardening.
  }
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = normalizeOptionalString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function firstBoolean(
  record: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
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

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
