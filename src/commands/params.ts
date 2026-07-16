import { CliError, printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { type JsonWrite, runJsonCommand } from "../json-output";
import { formatTable } from "../table";
import type { JobParameterDefinition } from "../types/jenkins";
import { resolveJobTarget } from "./ops-helpers";

type ParamsOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  jobUrl?: string;
  nonInteractive: boolean;
  json?: boolean;
  write?: JsonWrite;
};

type JsonJobParameterDefinition = Omit<JobParameterDefinition, "jenkinsClass">;

export async function runParams(options: ParamsOptions): Promise<void> {
  if (options.job && options.jobUrl) {
    const error = new CliError("Provide either --job or --job-url, not both.", [
      "Remove one of the flags and try again.",
    ]);
    if (options.json) {
      await runJsonCommand("params", async () => Promise.reject(error), {
        write: options.write,
      });
      return;
    }
    throw error;
  }

  if (options.json) {
    await runJsonCommand(
      "params",
      async () => {
        const definitions = await loadDefinitions(options, true);
        return definitions.map(toJsonDefinition);
      },
      { write: options.write },
    );
    return;
  }

  const definitions = await loadDefinitions(options, options.nonInteractive);
  if (definitions.length === 0) {
    printOk("No parameter definitions found for this job.");
    return;
  }
  console.log(formatJobParametersTable(definitions));
}

async function loadDefinitions(
  options: ParamsOptions,
  nonInteractive: boolean,
): Promise<JobParameterDefinition[]> {
  const target = await resolveJobTarget({
    client: options.client,
    env: options.env,
    job: options.job,
    jobUrl: options.jobUrl,
    nonInteractive,
  });
  return await options.client.getJobParameterDefinitions(target.jobUrl);
}

function toJsonDefinition(
  definition: JobParameterDefinition,
): JsonJobParameterDefinition {
  return {
    name: definition.name,
    type: definition.type,
    ...(definition.description ? { description: definition.description } : {}),
    ...(!definition.sensitive && definition.defaultValue !== undefined
      ? { defaultValue: definition.defaultValue }
      : {}),
    ...(definition.choices?.length ? { choices: definition.choices } : {}),
    sensitive: definition.sensitive,
  };
}

export function formatJobParametersTable(
  definitions: JobParameterDefinition[],
): string {
  return formatTable([
    ["NAME", "TYPE", "DEFAULT", "CHOICES", "DESCRIPTION"],
    ...definitions.map((definition) => [
      definition.name,
      definition.type,
      definition.sensitive
        ? ""
        : definition.defaultValue === undefined
          ? ""
          : String(definition.defaultValue),
      definition.choices?.join(", ") ?? "",
      definition.description ?? "",
    ]),
  ]);
}
