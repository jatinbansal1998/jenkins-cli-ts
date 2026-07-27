import os from "node:os";

export function resolveUserHome(): string {
  return selectUserHome(process.env.HOME, os.homedir(), process.platform);
}

export function selectUserHome(
  configuredHome: string | undefined,
  nativeHome: string,
  platform: NodeJS.Platform,
): string {
  const home = configuredHome?.trim();
  if (!home) {
    return nativeHome;
  }
  const isNativeWindowsPath =
    /^[A-Za-z]:[\\/]/.test(home) || /^\\\\[^\\]/.test(home);
  if (platform === "win32" && !isNativeWindowsPath) {
    return nativeHome;
  }
  return home;
}
