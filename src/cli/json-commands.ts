/** Commands whose `--json` flag emits the structured envelope. */
export const JSON_COMMANDS = new Set([
  "list",
  "params",
  "build",
  "status",
  "history",
  "wait",
  "tests",
  "changes",
  "artifacts",
  "run",
  "cancel",
  "create",
  "queue",
  "nodes",
  "rerun",
  "input:list",
  "input:approve",
  "input:abort",
  "auth:status",
  "auth:list",
  "auth:current",
  "update",
  "help",
]);

export function commandPathSupportsJson(path: string[]): boolean {
  if (path.length === 0) {
    return true;
  }
  return JSON_COMMANDS.has(path.join(":"));
}

export function commandPathSupportsJsonl(path: string[]): boolean {
  return path.length === 1 && path[0] === "logs";
}
