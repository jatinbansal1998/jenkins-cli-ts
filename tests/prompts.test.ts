import { describe, expect, test } from "bun:test";
import { formatCliIntro, printCliIntro } from "../src/cli-intro";

describe("cli intro", () => {
  test("builds the default ASCII intro message with metadata", () => {
    const message = formatCliIntro({
      showAsciiBanner: true,
      version: "0.7.4",
      target: "host: jenkins.example.com | profile: work",
      pendingUpdateVersion: "0.7.5",
    });

    expect(message).toContain("███████");
    expect(message).toContain("CLI | v0.7.4");
    expect(message).toContain("host: jenkins.example.com | profile: work");
    expect(message).toContain("Update available: v0.7.5");
  });

  test("falls back to a plain title when the banner is disabled", () => {
    const message = formatCliIntro({
      showAsciiBanner: false,
      version: "0.7.4",
    });

    expect(message).toBe("Jenkins CLI\nv0.7.4");
  });

  test("prints nothing when the banner is disabled", () => {
    const calls: string[] = [];
    printCliIntro(
      {
        showAsciiBanner: false,
        version: "0.7.4",
      },
      (text) => calls.push(text),
    );

    expect(calls).toHaveLength(0);
  });

  test("prints banner when enabled", () => {
    const calls: string[] = [];
    printCliIntro(
      {
        showAsciiBanner: true,
        version: "0.7.4",
      },
      (text) => calls.push(text),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("CLI | v0.7.4");
    expect(calls[0]).toContain("███████");
  });
});
