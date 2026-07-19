/** Every command whose --help output `help --full` aggregates, in display order. */
export const FULL_HELP_COMMANDS: string[][] = [
  [],
  ["auth"],
  ["auth", "login"],
  ["auth", "status"],
  ["auth", "list"],
  ["auth", "use"],
  ["auth", "current"],
  ["auth", "rename"],
  ["auth", "logout"],
  ["login"],
  ["list"],
  ["params"],
  ["build"],
  ["status"],
  ["history"],
  ["wait"],
  ["logs"],
  ["artifacts"],
  ["run"],
  ["cancel"],
  ["queue"],
  ["nodes"],
  ["rerun"],
  ["profile"],
  ["update"],
  ["help"],
];

/**
 * Builds the command line to re-invoke this CLI. A compiled binary exposes its
 * embedded entry through Bun's virtual filesystem (/$bunfs on POSIX, B:\~BUN
 * on Windows) and re-runs itself directly; `bun run src/index.ts` keeps a real
 * script path in argv[1] that must be passed through.
 */
function selfInvocation(args: string[]): string[] {
  const script = process.argv[1];
  const isCompiled =
    !script || script.startsWith("/$bunfs/") || script.includes("~BUN");
  if (isCompiled) {
    return [process.execPath, ...args];
  }
  return [process.execPath, script, ...args];
}

/**
 * Prints the --help output of every command in one document so automation and
 * AI agents can learn the complete CLI surface from a single invocation.
 * Children are spawned concurrently; each `--help` run skips the update
 * prompt/auto-update paths and never touches Jenkins.
 */
export async function printFullHelp(scriptName: string): Promise<void> {
  const sections = await Promise.all(
    FULL_HELP_COMMANDS.map(async (commandPath) => {
      const title = [scriptName, ...commandPath, "--help"].join(" ");
      const child = Bun.spawn({
        cmd: selfInvocation([...commandPath, "--help"]),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      const rule = "=".repeat(72);
      return `${rule}\n${title}\n${rule}\n${`${stdout}${stderr}`.trim()}`;
    }),
  );
  console.log(sections.join("\n\n"));
}
