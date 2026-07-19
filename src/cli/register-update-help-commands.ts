import type { Argv } from "yargs";
import { runUpdate } from "../commands/update";
import { optionalString } from "./options";
import type { CommandRegistrationDependencies } from "./registration-types";

type UpdateHelpRegistrationOptions = {
  version: string;
  printFullHelp: () => Promise<void>;
  showRootHelp: () => void;
};

export function registerUpdateHelpCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
  options: UpdateHelpRegistrationOptions,
): Argv {
  return parser
    .command(
      ["update [tag]", "upgrade [tag]"],
      "Update the jenkins-cli binary (alias: upgrade)",
      configureUpdateOptions,
      async (argv) => {
        await dependencies.runTrackedCommand("update", argv, async () => {
          await runUpdate({
            currentVersion: options.version,
            tag: optionalString(argv.tag),
            check: Boolean(argv.check),
            enableAuto: Boolean(argv.enableAuto),
            disableAuto: Boolean(argv.disableAuto),
            enableAutoInstall: Boolean(argv.enableAutoInstall),
            disableAutoInstall: Boolean(argv.disableAutoInstall),
            channel: optionalString(argv.channel),
          });
        });
      },
    )
    .command(
      "help",
      "Show help (--full prints every command's options)",
      (helpYargs) =>
        helpYargs.option("full", {
          type: "boolean",
          default: false,
          describe:
            "Print the complete option reference for every command in one output",
        }),
      async (argv) => {
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
    .option("enable-auto", {
      type: "boolean",
      describe: "Enable daily update checks (notify only)",
    })
    .option("disable-auto", {
      type: "boolean",
      describe: "Disable daily update checks",
    })
    .option("enable-auto-install", {
      type: "boolean",
      describe: "Enable auto-install of updates",
    })
    .option("disable-auto-install", {
      type: "boolean",
      describe: "Disable auto-install of updates",
    })
    .option("channel", {
      type: "string",
      describe: "Set update channel: stable or prerelease",
    })
    .conflicts("enable-auto", ["disable-auto", "check"])
    .conflicts("disable-auto", ["enable-auto", "check"])
    .conflicts("enable-auto-install", ["disable-auto-install", "check"])
    .conflicts("disable-auto-install", ["enable-auto-install", "check"])
    .conflicts("check", [
      "enable-auto",
      "disable-auto",
      "enable-auto-install",
      "disable-auto-install",
    ]);
}
