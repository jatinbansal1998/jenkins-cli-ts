import { CliError } from "./cli";

export type BrowserLauncher = (command: string[]) => Promise<number>;

const launchProcess: BrowserLauncher = async (command) => {
  const process = Bun.spawn({
    cmd: command,
    stdout: "ignore",
    stderr: "ignore",
  });
  return await process.exited;
};

export async function openInBrowser(
  url: string,
  launcher: BrowserLauncher = launchProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const command = browserCommand(url, platform);
  const exitCode = await launcher(command);
  if (exitCode !== 0) {
    throw new CliError(`Browser launcher exited with code ${exitCode}.`);
  }
}

export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "darwin") {
    return ["open", url];
  }
  if (platform === "win32") {
    return ["cmd", "/c", "start", "", url];
  }
  return ["xdg-open", url];
}
