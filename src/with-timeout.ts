/** Abort controller wired to an optional timeout; cleanup() cancels the timer. */
export function withTimeout(timeoutMs?: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timeout.unref === "function") {
      timeout.unref();
    }
  }
  return {
    controller,
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
}
