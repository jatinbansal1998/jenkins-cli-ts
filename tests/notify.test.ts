import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { notifyBuildComplete } from "../src/notify";

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

let spawnSpy = spyOn(Bun, "spawn");

function spawnedCmd(): string[] {
  const options = spawnSpy.mock.calls[0]?.[0] as unknown as { cmd: string[] };
  return options.cmd;
}

describe("notifyBuildComplete", () => {
  beforeEach(() => {
    spawnSpy = spyOn(Bun, "spawn");
    spawnSpy.mockImplementation((() => ({
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    setPlatform(originalPlatform);
  });

  test("does nothing on non-macOS platforms", async () => {
    setPlatform("linux");

    await notifyBuildComplete({ message: "Build finished" });

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test("does nothing for a blank message", async () => {
    setPlatform("darwin");

    await notifyBuildComplete({ message: "   " });

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test("invokes osascript with the message and default title", async () => {
    setPlatform("darwin");

    await notifyBuildComplete({ message: "Build finished" });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnedCmd()).toEqual([
      "osascript",
      "-e",
      'display notification "Build finished" with title "jenkins-cli"',
    ]);
  });

  test("escapes quotes and backslashes in message and title", async () => {
    setPlatform("darwin");

    await notifyBuildComplete({
      title: 'job "api"',
      message: 'branch fix\\ "done"',
    });

    expect(spawnedCmd()[2]).toBe(
      'display notification "branch fix\\\\ \\"done\\"" with title "job \\"api\\""',
    );
  });

  test("falls back to the default title when title is blank", async () => {
    setPlatform("darwin");

    await notifyBuildComplete({ title: "  ", message: "Done" });

    expect(spawnedCmd()[2]).toContain('with title "jenkins-cli"');
  });

  test("swallows a non-zero osascript exit code", async () => {
    setPlatform("darwin");
    spawnSpy.mockImplementation((() => ({
      exited: Promise.resolve(1),
    })) as unknown as typeof Bun.spawn);

    await expect(
      notifyBuildComplete({ message: "Build finished" }),
    ).resolves.toBeUndefined();
  });

  test("swallows spawn failures entirely", async () => {
    setPlatform("darwin");
    spawnSpy.mockImplementation((() => {
      throw new Error("osascript missing");
    }) as unknown as typeof Bun.spawn);

    await expect(
      notifyBuildComplete({ message: "Build finished" }),
    ).resolves.toBeUndefined();
  });
});
