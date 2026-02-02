import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "jenkins-cli");
export const CONFIG_FILE = path.join(CONFIG_DIR, "jenkins-cli-config.json");

export type ConfigFileInput = {
  jenkinsUrl: string;
  jenkinsUser: string;
  jenkinsApiToken: string;
  branchParam?: string;
};

export async function writeConfigFile(input: ConfigFileInput): Promise<string> {
  const payload: ConfigFileInput = {
    jenkinsUrl: input.jenkinsUrl,
    jenkinsUser: input.jenkinsUser,
    jenkinsApiToken: input.jenkinsApiToken,
    ...(input.branchParam ? { branchParam: input.branchParam } : {}),
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
