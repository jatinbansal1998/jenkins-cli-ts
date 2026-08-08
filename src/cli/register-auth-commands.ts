import type { Argv } from "yargs";
import {
  runAuthCurrent,
  runAuthList,
  runAuthLogout,
  runAuthRename,
  runAuthUse,
} from "../commands/auth-profile";
import { runAuthStatus } from "../commands/auth-status";
import { runLogin } from "../commands/login";
import { addJsonOption, optionalString } from "./options";
import type {
  CommandRegistrationDependencies,
  RunTrackedCommand,
} from "./registration-types";

export function registerAuthCommands(
  parser: Argv,
  dependencies: CommandRegistrationDependencies,
): Argv {
  const { runTrackedCommand } = dependencies;

  return parser
    .command(
      "auth",
      "Authentication commands: login, status, list, use, current, rename, logout",
      (authYargs) =>
        authYargs
          .command(
            "login",
            "Save Jenkins credentials",
            configureLoginOptions,
            createLoginHandler("auth:login", runTrackedCommand),
          )
          .command(
            "status",
            "Validate credentials against Jenkins",
            addJsonOption,
            async (argv) => {
              await runTrackedCommand("auth:status", argv, async () => {
                await runAuthStatus({
                  profile: optionalString(argv.profile),
                  url: optionalString(argv.url),
                  user: optionalString(argv.user),
                  apiToken:
                    optionalString(argv.token) ?? optionalString(argv.apiToken),
                  json: Boolean(argv.json),
                });
              });
            },
          )
          .command(
            "list",
            "List stored credential profiles",
            addJsonOption,
            async (argv) => {
              await runTrackedCommand("auth:list", argv, async () => {
                await runAuthList(undefined, undefined, Boolean(argv.json));
              });
            },
          )
          .command(
            "use <name>",
            "Set the default credential profile",
            (useYargs) =>
              useYargs.positional("name", {
                type: "string",
                describe: "Profile name",
              }),
            async (argv) => {
              await runTrackedCommand("auth:use", argv, async () => {
                await runAuthUse(optionalString(argv.name) ?? "");
              });
            },
          )
          .command(
            "current",
            "Show which credentials would be used",
            addJsonOption,
            async (argv) => {
              await runTrackedCommand("auth:current", argv, async () => {
                await runAuthCurrent({
                  profile: optionalString(argv.profile),
                  url: optionalString(argv.url),
                  user: optionalString(argv.user),
                  apiToken:
                    optionalString(argv.token) ?? optionalString(argv.apiToken),
                  json: Boolean(argv.json),
                });
              });
            },
          )
          .command(
            "rename <old> <new>",
            "Rename a stored credential profile",
            (renameYargs) =>
              renameYargs
                .positional("old", {
                  type: "string",
                  describe: "Current profile name",
                })
                .positional("new", {
                  type: "string",
                  describe: "New profile name",
                }),
            async (argv) => {
              await runTrackedCommand("auth:rename", argv, async () => {
                await runAuthRename(
                  optionalString(argv.old) ?? "",
                  optionalString(argv.new) ?? "",
                );
              });
            },
          )
          .command(
            "logout",
            "Remove local credentials (one or --all)",
            (logoutYargs) =>
              logoutYargs.option("all", {
                type: "boolean",
                default: false,
                describe: "Delete every stored profile",
              }),
            async (argv) => {
              await runTrackedCommand(
                "auth:logout",
                argv,
                async ({ showIntro }) => {
                  showIntro();
                  await runAuthLogout({
                    profile: optionalString(argv.profile),
                    all: Boolean(argv.all),
                    nonInteractive: Boolean(argv.nonInteractive),
                  });
                },
              );
            },
          )
          .demandCommand(
            1,
            "Choose an auth command: login, status, list, use, current, rename, or logout.",
          ),
      () => undefined,
    )
    .command(
      "login",
      "Save Jenkins credentials (compatibility alias for auth login)",
      configureLoginOptions,
      createLoginHandler("login", runTrackedCommand),
    );
}

function configureLoginOptions(yargsInstance: Argv): Argv {
  return yargsInstance
    .option("url", {
      type: "string",
      describe: "Jenkins base URL",
    })
    .option("user", {
      type: "string",
      describe: "Jenkins username",
    })
    .option("token", {
      type: "string",
      describe: "Jenkins API token",
    })
    .option("branch-param", {
      type: "string",
      describe: "Branch parameter name (default from env/config)",
    })
    .option("profile", {
      type: "string",
      describe: "Profile name to create or update",
    })
    .option("keychain", {
      type: "boolean",
      default: true,
      describe:
        "Store the token in the OS keychain when available (use --no-keychain to force plaintext)",
    })
    .option("protected", {
      type: "boolean",
      describe:
        "Make the profile read-only: builds, cancels, and reruns then need --confirm-protected (use --no-protected to clear)",
    });
}

function createLoginHandler(
  command: "auth:login" | "login",
  runTrackedCommand: RunTrackedCommand,
) {
  return async (argv: {
    _?: unknown;
    $0?: unknown;
    url?: unknown;
    user?: unknown;
    token?: unknown;
    apiToken?: unknown;
    branchParam?: unknown;
    profile?: unknown;
    nonInteractive?: unknown;
    keychain?: unknown;
    protected?: unknown;
    banner?: unknown;
  }): Promise<void> => {
    await runTrackedCommand(command, argv, async ({ showIntro }) => {
      showIntro();
      await runLogin({
        url: optionalString(argv.url),
        user: optionalString(argv.user),
        apiToken: optionalString(argv.token) ?? optionalString(argv.apiToken),
        branchParam: optionalString(argv.branchParam),
        profile: optionalString(argv.profile),
        nonInteractive: Boolean(argv.nonInteractive),
        noKeychain: argv.keychain === false,
        ...(typeof argv.protected === "boolean"
          ? { protected: argv.protected }
          : {}),
      });
    });
  };
}
