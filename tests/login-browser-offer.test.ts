import { describe, expect, test } from "bun:test";
import {
  buildJenkinsUserSecurityUrl,
  offerToOpenHostInBrowser,
  offerToOpenUserSecurityPageInBrowser,
} from "../src/commands/login";

const URL = "https://jenkins.example.com";
const USER = "alice@example.com";
const SECURITY_URL = `${URL}/user/alice%40example.com/security/`;

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
      `Open ${URL} in your browser? (useful for finding your Jenkins username)`,
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
});

describe("offerToOpenUserSecurityPageInBrowser", () => {
  test("builds the standard user security URL and preserves a context path", () => {
    expect(
      buildJenkinsUserSecurityUrl(
        "https://jenkins.example.com/jenkins/",
        "team/user name",
      ),
    ).toBe(
      "https://jenkins.example.com/jenkins/user/team%2Fuser%20name/security/",
    );
  });

  test("skips the second prompt in non-interactive mode", async () => {
    const recorded = makeDeps(true);
    await offerToOpenUserSecurityPageInBrowser(
      { url: URL, user: USER, nonInteractive: true },
      recorded.deps,
    );
    expect(recorded.confirmMessages).toHaveLength(0);
    expect(recorded.openedUrls).toHaveLength(0);
  });

  test("offers and opens the user's security page", async () => {
    const recorded = makeDeps(true);
    await offerToOpenUserSecurityPageInBrowser(
      { url: URL, user: USER, nonInteractive: false },
      recorded.deps,
    );
    expect(recorded.confirmMessages).toEqual([
      `Open ${SECURITY_URL} in your browser? (useful for creating an API token)`,
    ]);
    expect(recorded.openedUrls).toEqual([SECURITY_URL]);
  });

  test("a failed browser launch prints a hint and does not fail the login", async () => {
    const recorded = makeDeps(true, async () => {
      throw new Error("no display");
    });
    await expect(
      offerToOpenUserSecurityPageInBrowser(
        { url: URL, user: USER, nonInteractive: false },
        recorded.deps,
      ),
    ).resolves.toBeUndefined();
  });
});
