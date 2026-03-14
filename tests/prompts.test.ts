import { describe, expect, spyOn, test } from "bun:test";
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
    const writeSpy = spyOn(process.stderr, "write");

    try {
      printCliIntro({
        showAsciiBanner: false,
        version: "0.7.4",
      });

      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("prints banner when enabled", () => {
    const writeSpy = spyOn(process.stderr, "write");
    writeSpy.mockImplementation(() => true);

    try {
      printCliIntro({
        showAsciiBanner: true,
        version: "0.7.4",
      });

      expect(writeSpy).toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("CLI | v0.7.4"));
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("███████"));
    } finally {
      writeSpy.mockRestore();
    }
  });
});
