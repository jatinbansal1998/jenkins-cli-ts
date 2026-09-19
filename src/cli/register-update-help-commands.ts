import type { Argv } from "yargs";
import { runUpdate } from "../commands/update";
import { optionalString } from "./options";
import type { CommandRegistrationDependencies } from "./registration-types";

export function registerUpdateHelpCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
  version: string,
): Argv {
  return parser
    .command(
      "update [tag]",
      "Update the jenkins-cli binary",
      configureUpdateOptions,
      async (argv) => {
        await dependencies.runCommand("update", argv, async () => {
          await runUpdate({
            currentVersion: version,
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
