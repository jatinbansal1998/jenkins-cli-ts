/**
 * Shared error handling for interactive follow-up menus (list, build, status,
 * history). Keeping it in one place is what lets a protected-profile block
 * return the user to the current action menu instead of unwinding the flow.
 */
import { CliError, handleCliError } from "../cli";
import { PROFILE_PROTECTED_CODE } from "../env";
import type { ActionEffectResult } from "../flows/types";

/** Prints a CliError like the top-level handler does; rethrows anything else. */
export function printMenuActionError(error: unknown): void {
  if (!(error instanceof CliError)) {
    throw error;
  }
  handleCliError(error);
}

/**
 * Runs a menu action and maps its failure to a flow event. A protection block
 * yields `mutation_blocked` so the flow stays on the current action menu; any
 * other CliError uses the caller's fallback outcome.
 */
export async function runMenuAction<T>(
  action: () => Promise<T>,
  fallback: ActionEffectResult,
): Promise<T | ActionEffectResult> {
  try {
    return await action();
  } catch (error) {
    printMenuActionError(error);
    return (error as CliError).code === PROFILE_PROTECTED_CODE
      ? "mutation_blocked"
      : fallback;
  }
}
