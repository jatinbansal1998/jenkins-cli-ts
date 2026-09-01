/**
 * Create command implementation.
 * Creates a Jenkins item from a config.xml file or by copying an existing
 * item. Blocked on read-only profiles like other Jenkins writes.
 */
import { CliError, printOk } from "../cli";
import { assertProtectedMutationAllowed, type EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";
import { normalizeControllerTargetUrl } from "../jenkins-target-url";
import { jobUrlToFullName } from "../job-url";
import { type JsonWrite, runJsonCommand } from "../json-output";
import { resolveJobTarget } from "./ops-helpers";

type CreateOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  name?: string;
  configPath?: string;
  copyFrom?: string;
  folderUrl?: string;
  nonInteractive: boolean;
  json?: boolean;
  write?: JsonWrite;
};

export async function runCreate(options: CreateOptions): Promise<void> {
  if (options.json) {
    await runJsonCommand("create", async () => await performCreate(options), {
      write: options.write,
    });
    return;
  }
  const created = await performCreate(options);
  printOk(`Created "${created.name}" at ${created.url}`);
}

async function performCreate(
  options: CreateOptions,
): Promise<{ name: string; url: string; copiedFrom?: string }> {
  const name = options.name?.trim() ?? "";
  if (!name) {
    throw new CliError("Missing required <name>.", [
      "Run `jenkins-cli create <name> --config <file>` or `jenkins-cli create <name> --copy-from <job>`.",
    ]);
  }
  if (name.includes("/")) {
    throw new CliError("Item names cannot contain '/'.", [
      "Pass --folder-url <url> to create the item inside a folder.",
    ]);
  }
  if (Boolean(options.configPath) === Boolean(options.copyFrom)) {
    throw new CliError(
      "Provide exactly one of --config <file> or --copy-from <job>.",
      [
        "--config posts the file as the item's config.xml.",
        "--copy-from copies an existing job or folder.",
      ],
    );
  }

  assertProtectedMutationAllowed(options.env);

  const parentUrl = options.folderUrl
    ? normalizeControllerTargetUrl(
        options.folderUrl,
        options.env.jenkinsUrl,
        "folder-url",
      )
    : undefined;

  if (options.configPath) {
    const file = Bun.file(options.configPath);
    if (!(await file.exists())) {
      throw new CliError(`Config file not found: ${options.configPath}`, [
        "Pass --config with a readable config.xml path.",
      ]);
    }
    const configXml = await file.text();
    if (!configXml.trim()) {
      throw new CliError(`Config file is empty: ${options.configPath}`);
    }
    const url = await options.client.createItem({
      name,
      configXml,
      ...(parentUrl ? { parentUrl } : {}),
    });
    return { name, url };
  }

  const source = await resolveCopySource(options, options.copyFrom ?? "");
  const url = await options.client.createItem({
    name,
    copyFrom: source.from,
    ...(parentUrl ? { parentUrl } : {}),
  });
  return { name, url, copiedFrom: source.label };
}

async function resolveCopySource(
  options: CreateOptions,
  copyFromInput: string,
): Promise<{ from: string; label: string }> {
  const copyFrom = copyFromInput.trim();
  const jobUrl = URL.canParse(copyFrom)
    ? normalizeControllerTargetUrl(
        copyFrom,
        options.env.jenkinsUrl,
        "copy-from",
      )
    : (
        await resolveJobTarget({
          client: options.client,
          env: options.env,
          job: copyFrom,
          nonInteractive: options.nonInteractive || Boolean(options.json),
        })
      ).jobUrl;
  const fullName = jobUrlToFullName(jobUrl);
  if (!fullName) {
    throw new CliError("Could not resolve --copy-from to a Jenkins item.", [
      "Pass a job name from `jenkins-cli list` or a full Jenkins job URL.",
    ]);
  }
  // Leading "/" makes Jenkins resolve the source from the controller root
  // even when the new item is created inside a folder.
  return { from: `/${fullName}`, label: fullName };
}
