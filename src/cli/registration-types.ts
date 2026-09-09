import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";

export type CommandArgv = {
  [key: string]: unknown;
  nonInteractive?: unknown;
  banner?: unknown;
  json?: unknown;
  jsonl?: unknown;
};

export type ContextArgv = {
  [key: string]: unknown;
  profile?: unknown;
  url?: unknown;
  user?: unknown;
  token?: unknown;
  apiToken?: unknown;
  folderDepth?: unknown;
  confirmProtected?: unknown;
};

export type ContextualCommandArgv = ContextArgv & CommandArgv;

export type CommandContext = {
  env: EnvConfig;
  client: JenkinsClient;
};

type CommandHelpers = {
  showIntro: (target?: string) => void;
  interactive: boolean;
};

export type RunCommand = (
  command: string,
  argv: CommandArgv | undefined,
  action: (helpers: CommandHelpers) => Promise<void>,
) => Promise<void>;

export type RunCommandWithContext = <TArgv extends ContextualCommandArgv>(
  command: string,
  argv: TArgv,
  action: (
    helpers: CommandContext & {
      argv: TArgv;
      showIntro: (target?: string) => void;
    },
  ) => Promise<void>,
) => Promise<void>;

export type CommandRegistrationDependencies = {
  runCommand: RunCommand;
  runCommandWithContext: RunCommandWithContext;
};
