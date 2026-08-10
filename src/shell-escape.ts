/** Quote a value for safe copy-paste into a POSIX shell. */
export function shellEscape(value: string): string {
  if (value === "") {
    return "''";
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
