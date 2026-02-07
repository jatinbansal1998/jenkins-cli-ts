export async function waitForPollIntervalOrCancel(
  intervalMs: number,
  cancelSignal?: { wait: Promise<void> } | null,
): Promise<void> {
  if (!cancelSignal) {
    await Bun.sleep(intervalMs);
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, intervalMs);
  });

  try {
    await Promise.race([timeoutPromise, cancelSignal.wait]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
