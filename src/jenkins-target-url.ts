import { CliError } from "./cli";

export function normalizeControllerTargetUrl(
  value: string,
  controllerUrl: string,
  label: "job-url" | "build-url" | "queue-url" | "folder-url" | "copy-from",
): string {
  let target: URL;
  try {
    target = new URL(value.trim());
  } catch {
    throw new CliError(
      `Invalid --${label} value.`,
      ["Provide a full Jenkins URL."],
      "INVALID_BUILD_SELECTOR",
    );
  }

  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new CliError(
      `Invalid --${label} value.`,
      [
        "Use a plain http:// or https:// URL without credentials, query parameters, or fragments.",
      ],
      "INVALID_BUILD_SELECTOR",
    );
  }

  const controller = new URL(controllerUrl);
  const controllerPath = controller.pathname.replace(/\/+$/, "");
  const targetPath = target.pathname.replace(/\/+$/, "");
  const insideController =
    target.origin === controller.origin &&
    (controllerPath === "" ||
      targetPath === controllerPath ||
      targetPath.startsWith(`${controllerPath}/`));

  if (!insideController) {
    throw new CliError(
      `--${label} belongs to a different Jenkins controller.`,
      [
        `Use a URL under ${controller.toString().replace(/\/+$/, "")}, or switch profiles.`,
      ],
      "CROSS_CONTROLLER_URL",
    );
  }

  target.pathname = targetPath || "/";
  return target.toString().replace(/\/+$/, "");
}
