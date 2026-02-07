import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "jenkins-cli");
export const CONFIG_FILE = path.join(CONFIG_DIR, "jenkins-cli-config.json");

export type ConfigFileInput = {
  jenkinsUrl: string;
  jenkinsUser: string;
  jenkinsApiToken: string;
  branchParam?: string;
  useCrumb?: boolean;
  debug?: boolean;
};

export async function writeConfigFile(input: ConfigFileInput): Promise<string> {
  const preserved = await readPreservedOptionalConfig();
  const payload: ConfigFileInput = {
    jenkinsUrl: input.jenkinsUrl,
    jenkinsUser: input.jenkinsUser,
    jenkinsApiToken: input.jenkinsApiToken,
    ...(input.branchParam ? { branchParam: input.branchParam } : {}),
    ...(typeof input.useCrumb === "boolean"
      ? { useCrumb: input.useCrumb }
      : typeof preserved.useCrumb === "boolean"
        ? { useCrumb: preserved.useCrumb }
        : {}),
    ...(typeof input.debug === "boolean"
      ? { debug: input.debug }
      : typeof preserved.debug === "boolean"
        ? { debug: preserved.debug }
        : {}),
  };

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(CONFIG_FILE, contents, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(CONFIG_FILE, 0o600);
  } catch {
    // Best-effort permission hardening.
  }
  return CONFIG_FILE;
}

async function readPreservedOptionalConfig(): Promise<{
  useCrumb?: boolean;
  debug?: boolean;
}> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const useCrumb = firstBooleanLike(parsed, [
      "useCrumb",
      "jenkinsUseCrumb",
      "JENKINS_USE_CRUMB",
    ]);
    const debug = parseBooleanLike(parsed.debug ?? parsed.JENKINS_DEBUG);
    return {
      ...(useCrumb !== undefined ? { useCrumb } : {}),
      ...(debug !== undefined ? { debug } : {}),
    };
  } catch {
    return {};
  }
}

function firstBooleanLike(
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
