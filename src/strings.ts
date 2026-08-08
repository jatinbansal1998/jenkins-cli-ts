export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Tri-state boolean flag: "true"/"1" → true, "false"/"0" → false, else undefined. */
export function parseBooleanFlag(
  value: string | boolean | undefined,
): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}
