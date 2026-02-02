/**
 * Login command implementation.
 * Prompts for Jenkins credentials, saves config, and prints export commands.
 */
import fs from "node:fs";
import { isCancel, password, text } from "@clack/prompts";
import { CliError, printOk } from "../cli";
import { CONFIG_FILE, writeConfigFile } from "../config";
import { normalizeUrl } from "../env";

type LoginOptions = {
  url?: string;
  user?: string;
  apiToken?: string;
  branchParam?: string;
  nonInteractive: boolean;
};

export async function runLogin(options: LoginOptions): Promise<void> {
  const url = await resolveUrl(options);
  const user = await resolveUser(options);
  const apiToken = await resolveApiToken(options);
  const branchParam = await resolveBranchParam(options);

  const normalizedUrl = normalizeUrl(url);
  const configPath = await writeConfigFile({
    jenkinsUrl: normalizedUrl,
    jenkinsUser: user,
    jenkinsApiToken: apiToken,
    ...(branchParam !== DEFAULT_BRANCH_PARAM ? { branchParam } : {}),
  });

  printOk(`Saved config to ${configPath}.`);
  console.log("");
  console.log("To set env vars in your current shell, run:");
  console.log(`  export JENKINS_URL=${shellEscape(normalizedUrl)}`);
  console.log(`  export JENKINS_USER=${shellEscape(user)}`);
  console.log(`  export JENKINS_API_TOKEN=${shellEscape(apiToken)}`);
  if (branchParam !== DEFAULT_BRANCH_PARAM) {
    console.log(`  export JENKINS_BRANCH_PARAM=${shellEscape(branchParam)}`);
  }
  console.log("");
  console.log(
    "To persist them, add the exports to your shell profile manually.",
  );
  console.log(`The CLI also reads ${CONFIG_FILE} directly.`);
}

async function resolveUrl(options: LoginOptions): Promise<string> {
  const provided = options.url?.trim();
  if (provided) {
    return provided;
  }
  if (options.nonInteractive) {
    throw new CliError("Missing required --url.", [
      "Run `jenkins-cli login --url <url> --user <user> --token <token>`.",
    ]);
  }
  const response = await text({
    message: "Jenkins URL",
    placeholder: "https://jenkins.example.com",
    validate: (value) => (value.trim() ? undefined : "Value required."),
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

async function resolveUser(options: LoginOptions): Promise<string> {
  const provided = options.user?.trim();
  if (provided) {
    return provided;
  }
  if (options.nonInteractive) {
    throw new CliError("Missing required --user.", [
      "Run `jenkins-cli login --url <url> --user <user> --token <token>`.",
    ]);
  }
  const response = await text({
    message: "Jenkins username",
    placeholder: "e.g. your-username",
    validate: (value) => (value.trim() ? undefined : "Value required."),
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

async function resolveApiToken(options: LoginOptions): Promise<string> {
  const provided = options.apiToken?.trim();
  if (provided) {
    return provided;
  }
  if (options.nonInteractive) {
    throw new CliError("Missing required --token.", [
      "Run `jenkins-cli login --url <url> --user <user> --token <token>`.",
    ]);
  }
  const response = await password({
    message: "Jenkins API token",
    validate: (value) => (value.trim() ? undefined : "Value required."),
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  return String(response).trim();
}

const DEFAULT_BRANCH_PARAM = "BRANCH";

async function resolveBranchParam(options: LoginOptions): Promise<string> {
  const provided = options.branchParam?.trim();
  if (provided) {
    return provided;
  }
  const defaultParam = getBranchParamDefault();
  if (options.nonInteractive) {
    return defaultParam;
  }
  const response = await text({
    message: `Branch parameter name (default: ${defaultParam})`,
    placeholder: DEFAULT_BRANCH_PARAM,
  });
  if (isCancel(response)) {
    throw new CliError("Operation cancelled.");
  }
  const value = String(response).trim();
  return value ? value : defaultParam;
}

function getBranchParamDefault(): string {
  const envValue = process.env.JENKINS_BRANCH_PARAM?.trim();
  if (envValue) {
    return envValue;
  }
  const configValue = readBranchParamFromConfig();
  if (configValue) {
    return configValue;
  }
  return DEFAULT_BRANCH_PARAM;
}

function readBranchParamFromConfig(): string | undefined {
  if (!fs.existsSync(CONFIG_FILE)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const candidate =
      record.branchParam ??
      record.jenkinsBranchParam ??
      record.JENKINS_BRANCH_PARAM;
    if (typeof candidate !== "string") {
      return undefined;
    }
    const trimmed = candidate.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function shellEscape(value: string): string {
  if (value === "") {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
