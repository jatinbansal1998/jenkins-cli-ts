/**
 * Builds the command line to re-invoke this CLI. A compiled binary exposes its
 * embedded entry through Bun's virtual filesystem (/$bunfs on POSIX, B:\~BUN
 * on Windows) and re-runs itself directly; `bun run src/index.ts` keeps a real
 * script path in argv[1] that must be passed through.
 */
export function selfInvocation(args: string[]): string[] {
  const script = process.argv[1];
  const isCompiled =
    !script || script.startsWith("/$bunfs/") || script.includes("~BUN");
  if (isCompiled) {
    return [process.execPath, ...args];
  }
  return [process.execPath, script, ...args];
}
