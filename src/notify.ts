import { printHint } from "./cli";
import { isDebugMode } from "./logger";

type NotifyOptions = {
  title?: string;
  message: string;
};

export async function notifyBuildComplete(
  options: NotifyOptions,
): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const title = options.title?.trim() || "jenkins-cli";
  const message = options.message.trim();
  if (!message) {
    return;
  }

  const script = `display notification ${escapeAppleScriptString(
    message,
  )} with title ${escapeAppleScriptString(title)}`;

  try {
    const proc = Bun.spawn({
      cmd: ["osascript", "-e", script],
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0 && isDebugMode()) {
      printHint("macOS notification failed (osascript exited non-zero).");
    }
  } catch {
    if (isDebugMode()) {
      printHint("macOS notification failed (unable to run osascript).");
    }
  }
}

function escapeAppleScriptString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
