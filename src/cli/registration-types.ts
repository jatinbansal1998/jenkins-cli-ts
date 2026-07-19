import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/client";

export type TrackedArgv = {
  [key: string]: unknown;
  nonInteractive?: unknown;
  banner?: unknown;
  json?: unknown;
};

export type ContextArgv = {
  [key: string]: unknown;
  profile?: unknown;
  url?: unknown;
  user?: unknown;
  token?: unknown;
  apiToken?: unknown;
  folderDepth?: unknown;
};

export type ContextualCommandArgv = ContextArgv & TrackedArgv;

export type CommandContext = {
  env: EnvConfig;
  client: JenkinsClient;
};

export type TrackedCommandHelpers = {
  showIntro: (target?: string) => void;
  interactive: boolean;
};

export type RunTrackedCommand = (
  command: string,
  argv: TrackedArgv | undefined,
  action: (helpers: TrackedCommandHelpers) => Promise<void>,
) => Promise<void>;

export type RunTrackedCommandWithContext = <
  TArgv extends ContextualCommandArgv,
>(
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
  runTrackedCommand: RunTrackedCommand;
  runTrackedCommandWithContext: RunTrackedCommandWithContext;
};
