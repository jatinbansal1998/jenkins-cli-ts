export const CLI_FLAGS = {
  HELP: "--help",
  HELP_SHORT: "-h",
  VERSION: "--version",
  VERSION_SHORT: "-v",
  NON_INTERACTIVE: "--non-interactive",
  NON_INTERACTIVE_CAMEL: "--nonInteractive",
} as const;

export const UPDATE_COMMAND_ALIASES = ["update", "upgrade"] as const;

export const UPDATE_COMMAND_SELF = "jenkins-cli update";
export const UPDATE_COMMAND_BREW = "brew upgrade jenkins-cli";

export function isUpdateCommandAlias(value: string): boolean {
  return UPDATE_COMMAND_ALIASES.includes(
    value as (typeof UPDATE_COMMAND_ALIASES)[number],
  );
}
