import path from "node:path";
import { ENV_KEYS } from "./env-keys";
import { resolveUserHome } from "./user-home";

/**
 * Every file the CLI keeps outside the job cache lives here: the config file,
 * error and API logs, and update state.
 */
export const CONFIG_DIR = selectConfigDir(
  process.env,
  resolveUserHome(),
  process.platform,
);

export function selectConfigDir(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
): string {
  const override = env[ENV_KEYS.JENKINS_CLI_CONFIG_DIR]?.trim();
  if (override) {
    return override;
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "jenkins-cli");
  }
  const appData = env.APPDATA?.trim();
  if (platform === "win32" && appData) {
    return path.join(appData, "jenkins-cli");
  }
  return path.join(home, ".config", "jenkins-cli");
}
