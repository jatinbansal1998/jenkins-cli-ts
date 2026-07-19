import { CliError } from "../cli";

export function parseArtifactFilters(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const filters = entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return filters.length > 0 ? filters : undefined;
}

export function parseBuildCustomParams(
  value: unknown,
): Record<string, string> | undefined {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  if (entries.length === 0) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new CliError("Invalid --param value.", [
        "Expected each --param entry to be a string in KEY=VALUE format.",
        "Use --param KEY=VALUE (example: --param DEPLOY_ENV=staging).",
      ]);
    }
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      throw new CliError("Invalid --param value.", [
        "Use --param KEY=VALUE (example: --param DEPLOY_ENV=staging).",
      ]);
    }
    const key = entry.slice(0, equalsIndex).trim();
    const paramValue = entry.slice(equalsIndex + 1);
    if (!key) {
      throw new CliError("Invalid --param value.", [
        "Parameter name cannot be empty.",
      ]);
    }
    if (Object.hasOwn(params, key)) {
      throw new CliError(`Duplicate --param key "${key}".`, [
        "Use unique parameter names when passing --param multiple times.",
      ]);
    }
    params[key] = paramValue;
  }

  return params;
}
