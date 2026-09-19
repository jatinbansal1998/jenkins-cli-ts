export const CLI_FLAGS = {
  HELP: "--help",
  HELP_SHORT: "-h",
  VERSION: "--version",
  VERSION_SHORT: "-v",
  NON_INTERACTIVE: "--non-interactive",
  NON_INTERACTIVE_CAMEL: "--nonInteractive",
} as const;

export const UPDATE_COMMAND_SELF = "jenkins-cli update";
export const UPDATE_COMMAND_BREW = "brew upgrade jenkins-cli";
