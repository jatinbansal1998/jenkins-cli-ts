import { describe, expect, test } from "bun:test";
import { waitForPollIntervalOrCancel } from "../src/commands/watch-utils";

describe("waitForPollIntervalOrCancel", () => {
  test("returns quickly when cancel signal is already resolved", async () => {
    const cancelSignal = {
      wait: Promise.resolve(),
    };
    const startedAt = Date.now();

    await waitForPollIntervalOrCancel(500, cancelSignal);

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(100);
  });

  test("returns quickly when cancel signal resolves before poll interval", async () => {
    let resolveCancel: (() => void) | undefined;
    const cancelSignal = {
      wait: new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    };

    setTimeout(() => {
      resolveCancel?.();
    }, 30);

    const startedAt = Date.now();
    await waitForPollIntervalOrCancel(500, cancelSignal);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(200);
  });

  test("waits for poll interval when cancel signal is absent", async () => {
    const startedAt = Date.now();
    await waitForPollIntervalOrCancel(40);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(30);
  });
});
