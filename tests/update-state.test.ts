import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function spawnWriter(home: string, code: string) {
  return Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { patchUpdateState } from ${JSON.stringify(resolve("src/update.ts"))};
     import { runUpdate } from ${JSON.stringify(resolve("src/commands/update.ts"))};
     ${code}`,
    ],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
}

function stateFile(home: string) {
  return Bun.file(join(home, ".config", "jenkins-cli", "update-state.json"));
}

test("concurrent processes preserve each other's update-state fields", async () => {
  const home = await mkdtemp(join(tmpdir(), "jenkins-update-state-"));
  const expected = {
    updateChannel: "prerelease",
    minAllowedVersion: "v1.0.0",
    minAllowedMessage: "synthetic policy",
    minAllowedSourceUrl: "https://example.com/policy.json",
    minAllowedFetchedAt: "2026-09-19T00:00:00Z",
    lastCheckedAt: "2026-09-19T00:00:01Z",
    lastNotifiedVersion: "v1.1.0",
  };
  try {
    const writers = Object.entries(expected).map(([key, value]) =>
      spawnWriter(
        home,
        `await patchUpdateState(${JSON.stringify({ [key]: value })});`,
      ),
    );
    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual(
      writers.map(() => 0),
    );
    expect(await stateFile(home).json()).toEqual(expected);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "update --check json=%s preserves changes made during its release request",
  async (json) => {
    const home = await mkdtemp(join(tmpdir(), "jenkins-update-check-"));
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      async fetch() {
        requested.resolve();
        await release.promise;
        return Response.json({ tag_name: "v1.0.0", assets: [] });
      },
    });
    const check = spawnWriter(
      home,
      `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = () => nativeFetch(${JSON.stringify(server.url.href)});
    await runUpdate({ currentVersion: "1.0.0", check: true, json: ${json} });
  `,
    );
    try {
      await requested.promise;
      const change = spawnWriter(
        home,
        `
      await runUpdate({ currentVersion: "1.0.0", channel: "prerelease" });
      await patchUpdateState({ minAllowedVersion: "v0.9.0" });
    `,
      );
      expect(await change.exited).toBe(0);
      release.resolve();
      expect(await check.exited).toBe(0);
      expect(await stateFile(home).json()).toMatchObject({
        updateChannel: "prerelease",
        minAllowedVersion: "v0.9.0",
        lastCheckedAt: expect.any(String),
      });
    } finally {
      release.resolve();
      await check.exited;
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  },
);
