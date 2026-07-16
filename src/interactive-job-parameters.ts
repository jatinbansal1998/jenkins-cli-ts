import type { EnvConfig } from "./env";
import { CliError } from "./cli";
import type { JobParameterDefinition } from "./types/jenkins";
import { withPromptTarget } from "./tui-target";
import { validateBuildParameters } from "./job-parameters";

export type ParameterPromptDeps = {
  text: (options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
  }) => Promise<unknown>;
  password: (options: { message: string; mask?: string }) => Promise<unknown>;
  confirm: (options: {
    message: string;
    initialValue?: boolean;
  }) => Promise<unknown>;
  select: (options: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string;
  }) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
  writeLine: (message: string) => void;
};

export type PromptDiscoveredParametersResult =
  | { cancelled: true }
  | {
      cancelled: false;
      branch: string;
      customParams: Record<string, string>;
      sensitiveNames: Set<string>;
    };

export async function promptForDiscoveredParameters(options: {
  definitions: JobParameterDefinition[];
  env: EnvConfig;
  branchParam: string;
  branch?: string;
  customParams?: Record<string, string>;
  deps: ParameterPromptDeps;
  selectBranch: () => Promise<string>;
}): Promise<PromptDiscoveredParametersResult> {
  const values = { ...options.customParams };
  let branch = options.branch?.trim() ?? "";
  if (branch && Object.hasOwn(values, options.branchParam)) {
    throw new CliError(
      `Parameter key "${options.branchParam}" conflicts with --branch.`,
      [`Remove --param ${options.branchParam}=... or omit --branch.`],
    );
  }

  for (const definition of options.definitions) {
    if (definition.name === options.branchParam) {
      if (!branch) {
        const suppliedBranch = values[definition.name];
        if (suppliedBranch !== undefined) {
          branch = suppliedBranch.trim();
          delete values[definition.name];
        } else {
          try {
            branch = await options.selectBranch();
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "Operation cancelled."
            ) {
              return { cancelled: true };
            }
            throw error;
          }
        }
      }
      continue;
    }

    if (Object.hasOwn(values, definition.name)) {
      continue;
    }

    const value = await promptForDefinition(definition, options);
    if (value.cancelled) {
      return { cancelled: true };
    }
    values[definition.name] = value.value;
  }

  const combined = {
    ...values,
    ...(branch ? { [options.branchParam]: branch } : {}),
  };
  const validated = validateBuildParameters(options.definitions, combined);
  if (branch) {
    delete validated.params[options.branchParam];
  }

  printParameterSummary({
    definitions: options.definitions,
    params: combined,
    sensitiveNames: validated.sensitiveNames,
    writeLine: options.deps.writeLine,
  });
  const confirmed = await options.deps.confirm({
    message: withPromptTarget(
      "Start build with these parameters?",
      options.env,
    ),
    initialValue: true,
  });
  if (options.deps.isCancel(confirmed) || !confirmed) {
    return { cancelled: true };
  }

  return {
    cancelled: false,
    branch,
    customParams: validated.params,
    sensitiveNames: validated.sensitiveNames,
  };
}

async function promptForDefinition(
  definition: JobParameterDefinition,
  options: {
    env: EnvConfig;
    deps: ParameterPromptDeps;
  },
): Promise<{ cancelled: true } | { cancelled: false; value: string }> {
  const message = withPromptTarget(
    definition.description
      ? `${definition.name} — ${definition.description}`
      : definition.name,
    options.env,
  );

  let response: unknown;
  if (definition.type === "boolean") {
    response = await options.deps.confirm({
      message,
      initialValue:
        typeof definition.defaultValue === "boolean"
          ? definition.defaultValue
          : false,
    });
    if (options.deps.isCancel(response)) return { cancelled: true };
    return { cancelled: false, value: String(Boolean(response)) };
  }

  if (definition.type === "choice" && definition.choices?.length) {
    response = await options.deps.select({
      message,
      options: definition.choices.map((choice) => ({
        value: choice,
        label: choice,
      })),
      ...(typeof definition.defaultValue === "string" &&
      definition.choices.includes(definition.defaultValue)
        ? { initialValue: definition.defaultValue }
        : {}),
    });
  } else if (definition.sensitive || definition.type === "password") {
    response = await options.deps.password({ message, mask: "*" });
  } else {
    response = await options.deps.text({
      message,
      ...(definition.description
        ? { placeholder: definition.description }
        : {}),
      ...(typeof definition.defaultValue === "string"
        ? { defaultValue: definition.defaultValue }
        : {}),
    });
  }

  if (options.deps.isCancel(response)) return { cancelled: true };
  return { cancelled: false, value: String(response ?? "") };
}

export function printParameterSummary(options: {
  definitions: JobParameterDefinition[];
  params: Record<string, string>;
  sensitiveNames?: Set<string>;
  writeLine: (message: string) => void;
}): void {
  const definitions = new Map(
    options.definitions.map((definition) => [definition.name, definition]),
  );
  options.writeLine("Parameter summary:");
  for (const [name, value] of Object.entries(options.params)) {
    const rendered =
      definitions.get(name)?.sensitive || options.sensitiveNames?.has(name)
        ? "<redacted>"
        : value;
    options.writeLine(`  ${name}: ${rendered}`);
  }
}
