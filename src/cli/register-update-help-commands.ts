import type { Argv } from "yargs";
import { CliError } from "../cli";
import { runUpdate } from "../commands/update";
import { optionalString } from "./options";
import type { CommandRegistrationDependencies } from "./registration-types";

type UpdateHelpRegistrationOptions = {
  version: string;
  printFullHelp: () => Promise<void>;
  printJsonHelp: () => Promise<void>;
  showRootHelp: () => void;
};

export function registerUpdateHelpCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
  options: UpdateHelpRegistrationOptions,
): Argv {
  return parser
    .command(
      "update [tag]",
      "Update the jenkins-cli binary",
      configureUpdateOptions,
      async (argv) => {
        await dependencies.runCommand("update", argv, async () => {
          await runUpdate({
            currentVersion: options.version,
            tag: optionalString(argv.tag),
            check: Boolean(argv.check),
            channel: optionalString(argv.channel),
            json: Boolean(argv.json),
          });
        });
      },
    )
    .command(
      "help",
      "Show help (--full prints every command's options; --json prints the catalog)",
      (helpYargs) =>
        helpYargs.option("full", {
          type: "boolean",
          default: false,
          describe:
            "Print the complete option reference for every command in one output",
        }),
      async (argv) => {
        if (argv.jsonl) {
          throw new CliError("'help' does not support --jsonl output.");
        }
        if (argv.json) {
          await options.printJsonHelp();
          return;
        }
        if (argv.full) {
          await options.printFullHelp();
          return;
        }
        options.showRootHelp();
      },
    );
}

function configureUpdateOptions(yargsInstance: Argv): Argv {
  return yargsInstance
    .positional("tag", {
      type: "string",
      describe: "Install a specific version tag (e.g. v0.2.4)",
    })
    .option("check", {
      type: "boolean",
      default: false,
      describe: "Check for updates without installing",
    })
    .option("channel", {
      type: "string",
      describe: "Set update channel: stable or prerelease",
    });
}
