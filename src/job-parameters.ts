import { CliError } from "./cli";
import type {
  JenkinsApiParameterDefinition,
  JenkinsJobParametersResponse,
  JobParameterDefinition,
  JobParameterType,
} from "./types/jenkins";

const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);

export type ValidatedBuildParameters = {
  params: Record<string, string>;
  unknownNames: string[];
  sensitiveNames: Set<string>;
};

/** Normalize the different core/plugin parameter JSON shapes Jenkins exposes. */
export function normalizeJobParameterDefinitions(
  response: JenkinsJobParametersResponse,
): JobParameterDefinition[] {
  const properties = Array.isArray(response.property) ? response.property : [];
  return properties.flatMap((property) => {
    const definitions = Array.isArray(property.parameterDefinitions)
      ? property.parameterDefinitions
      : [];
    return definitions
      .map(normalizeDefinition)
      .filter((value): value is JobParameterDefinition => Boolean(value));
  });
}

function normalizeDefinition(
  raw: JenkinsApiParameterDefinition,
): JobParameterDefinition | undefined {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return undefined;
  }

  const jenkinsClass = firstNonEmpty(raw._class, raw.type);
  const type = classifyParameterType(jenkinsClass);
  const sensitive = isSensitiveType(type, jenkinsClass);
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : undefined;
  const choices = normalizeChoices(raw.choices);
  const defaultValue = sensitive
    ? undefined
    : normalizeDefaultValue(
        raw.defaultParameterValue?.value ?? raw.defaultValue,
        type,
      );

  return {
    name,
    type,
    ...(description ? { description } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(choices.length > 0 ? { choices } : {}),
    sensitive,
    ...(jenkinsClass ? { jenkinsClass } : {}),
  };
}

function classifyParameterType(identifier?: string): JobParameterType {
  const value = identifier?.toLowerCase() ?? "";
  if (/password|secret|credential/.test(value)) return "password";
  if (/choice/.test(value)) return "choice";
  if (/boolean/.test(value)) return "boolean";
  if (/textparameter/.test(value)) return "text";
  if (/stringparameter/.test(value)) return "string";
  return "unknown";
}

function isSensitiveType(type: JobParameterType, identifier?: string): boolean {
  return (
    type === "password" ||
    /password|secret|credential/.test(identifier?.toLowerCase() ?? "")
  );
}

function normalizeDefaultValue(
  value: unknown,
  type: JobParameterType,
): string | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const parsed = parseBooleanParameter(value);
      return parsed === undefined ? undefined : parsed;
    }
    return undefined;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function normalizeChoices(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\r?\n/);
  if (!Array.isArray(value)) return [];
  return value.filter((choice): choice is string => typeof choice === "string");
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values
    .find((value) => typeof value === "string" && value.trim())
    ?.trim();
}

export function parseBooleanParameter(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

/** Validate only known definitions; unknown CLI keys remain backward compatible. */
export function validateBuildParameters(
  definitions: JobParameterDefinition[],
  input: Record<string, string>,
): ValidatedBuildParameters {
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  const params: Record<string, string> = {};
  const unknownNames: string[] = [];
  const sensitiveNames = new Set(
    definitions
      .filter((definition) => definition.sensitive)
      .map((definition) => definition.name),
  );

  for (const [name, value] of Object.entries(input)) {
    const definition = byName.get(name);
    if (!definition) {
      unknownNames.push(name);
      if (isLikelySensitiveParameterName(name)) sensitiveNames.add(name);
      params[name] = value;
      continue;
    }
    if (definition.type === "choice" && definition.choices?.length) {
      if (!definition.choices.includes(value)) {
        throw new CliError(`Invalid value for choice parameter "${name}".`, [
          `Allowed values: ${definition.choices.join(", ")}.`,
        ]);
      }
    }
    if (definition.type === "boolean") {
      const parsed = parseBooleanParameter(value);
      if (parsed === undefined) {
        throw new CliError(`Invalid boolean value for parameter "${name}".`, [
          "Use true/false, yes/no, on/off, or 1/0.",
        ]);
      }
      params[name] = String(parsed);
      continue;
    }
    params[name] = value;
  }

  return { params, unknownNames, sensitiveNames };
}

export function isLikelySensitiveParameterName(name: string): boolean {
  return /password|passwd|secret|token|credential|api[_-]?key/i.test(name);
}

export function defaultsForDefinitions(
  definitions: JobParameterDefinition[],
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const definition of definitions) {
    if (definition.defaultValue !== undefined && !definition.sensitive) {
      params[definition.name] = String(definition.defaultValue);
    }
  }
  return params;
}
