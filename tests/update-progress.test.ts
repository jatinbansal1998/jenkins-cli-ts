import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let fixtureDir: string;
let fixture: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(
    join(tmpdir(), "jenkins-update-progress-fixture-"),
  );
  const entrypoint = join(fixtureDir, "fixture.ts");
  fixture = join(fixtureDir, "jenkins-cli");
  await Bun.write(
    entrypoint,
    `
    import { runUpdate } from ${JSON.stringify(resolve("src/commands/update.ts"))};
    if (process.argv.includes("--version")) {
      console.log("2.1.278 (fixture)");
    } else {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => nativeFetch(
        String(url).startsWith("https://api.github.com/") ? process.env.FIXTURE_URL + "release" : url, options);
      try {
        await runUpdate({ currentVersion: "2.1.276", tag: process.env.FIXTURE_TAG });
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    }
  `,
  );
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    compile: { outfile: fixture },
  });
  expect(build.success).toBe(true);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function expectProgress(progress: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      progress.then(() => "printed"),
      new Promise<string>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("silent"), 1000);
      }),
    ]);
    expect(result).toBe("printed");
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(process.platform === "win32").each([undefined, "v2.1.278"])(
  "manual update reports progress before requests finish, tag %s",
  async (tag) => {
    const home = await mkdtemp(join(tmpdir(), "jenkins-update-progress-"));
    const executable = join(home, "jenkins-cli");
    await copyFile(fixture, executable);
    await chmod(executable, 0o755);
    const releaseRequested = Promise.withResolvers<void>();
    const releaseAllowed = Promise.withResolvers<void>();
    const assetRequested = Promise.withResolvers<void>();
    const assetAllowed = Promise.withResolvers<void>();
    const { resolveAssetName } = await import("../src/update");
    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        if (new URL(request.url).pathname === "/release") {
          releaseRequested.resolve();
          await releaseAllowed.promise;
          return Response.json({
            tag_name: "v2.1.278",
            assets: [
              {
                name: resolveAssetName(),
                browser_download_url: new URL("asset", server.url).href,
              },
            ],
          });
        }
        assetRequested.resolve();
        await assetAllowed.promise;
        return new Response(Bun.file(fixture));
      },
    });
    const child = Bun.spawn([executable], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FIXTURE_URL: server.url.href,
        FIXTURE_TAG: tag,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    const checking = Promise.withResolvers<void>();
    const updating = Promise.withResolvers<void>();
    const readOutput = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        if (stdout.includes("Checking for")) checking.resolve();
        if (stdout.includes("Updating to")) updating.resolve();
      }
    })();
    try {
      await releaseRequested.promise;
      await expectProgress(checking.promise);
      expect(stdout).toBe(
        `Current version: 2.1.276\n${tag ? "Checking for version v2.1.278..." : "Checking for updates to latest version..."}\n`,
      );
      releaseAllowed.resolve();
      await assetRequested.promise;
      await expectProgress(updating.promise);
      expect(stdout).toEndWith("Updating to 2.1.278...\n");
      expect(stdout).not.toContain("Successfully updated");
      assetAllowed.resolve();
      expect(await child.exited).toBe(0);
      await readOutput;
      expect(stdout).toEndWith(
        "OK: Successfully updated from 2.1.276 to version 2.1.278 (fixture).\n",
      );
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      releaseAllowed.resolve();
      assetAllowed.resolve();
      child.kill("SIGKILL");
      await child.exited;
      await readOutput;
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  },
  15_000,
);
