import { describe, expect, test } from "bun:test";
import { offerToOpenHostInBrowser } from "../src/commands/login";

const URL = "https://jenkins.example.com";

type Recorded = {
  confirmMessages: string[];
  openedUrls: string[];
};

function makeDeps(
  confirmResult: boolean | symbol,
  openImpl?: (url: string) => Promise<void>,
): Recorded & {
  deps: Parameters<typeof offerToOpenHostInBrowser>[1];
} {
  const confirmMessages: string[] = [];
  const openedUrls: string[] = [];
  return {
    confirmMessages,
    openedUrls,
    deps: {
      confirm: async (options: { message: string }) => {
        confirmMessages.push(options.message);
        return confirmResult as boolean;
      },
      openInBrowser:
        openImpl ??
        (async (url: string) => {
          openedUrls.push(url);
        }),
    },
  };
}

describe("offerToOpenHostInBrowser", () => {
  test("skips the prompt entirely in non-interactive mode", async () => {
    const recorded = makeDeps(true);
    await offerToOpenHostInBrowser(
      { url: URL, nonInteractive: true },
      recorded.deps,
    );
    expect(recorded.confirmMessages).toHaveLength(0);
    expect(recorded.openedUrls).toHaveLength(0);
  });

  test("asks a yes/no question that shows the entered host", async () => {
    const recorded = makeDeps(false);
    await offerToOpenHostInBrowser(
      { url: URL, nonInteractive: false },
      recorded.deps,
    );
    expect(recorded.confirmMessages).toEqual([
      `Open ${URL} in your browser? (useful for creating an API token)`,
    ]);
    expect(recorded.openedUrls).toHaveLength(0);
  });

  test("opens the host in the browser when the user accepts", async () => {
    const recorded = makeDeps(true);
    await offerToOpenHostInBrowser(
      { url: URL, nonInteractive: false },
      recorded.deps,
    );
    expect(recorded.openedUrls).toEqual([URL]);
  });

  test("treats a cancelled prompt as a cancelled operation", async () => {
    // clack signals cancellation with a symbol; isCancel detects it.
    const recorded = makeDeps(Symbol.for("clack:cancel"));
    await expect(
      offerToOpenHostInBrowser(
        { url: URL, nonInteractive: false },
        recorded.deps,
      ),
    ).rejects.toThrow("Operation cancelled.");
    expect(recorded.openedUrls).toHaveLength(0);
  });

  test("a failed browser launch prints a hint and does not fail the login", async () => {
    const recorded = makeDeps(true, async () => {
      throw new Error("no display");
    });
    await expect(
      offerToOpenHostInBrowser(
        { url: URL, nonInteractive: false },
        recorded.deps,
      ),
    ).resolves.toBeUndefined();
  });
});
