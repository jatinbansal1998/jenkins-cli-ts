import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let fixtureDir: string;
let executable: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "jenkins-update-timeout-fixture-"));
  const entrypoint = join(fixtureDir, "fixture.ts");
  executable = join(fixtureDir, "jenkins-cli");
  await Bun.write(
    entrypoint,
    `
    import { runUpdate } from ${JSON.stringify(resolve("src/commands/update.ts"))};
    import { describeInstalledBinary } from ${JSON.stringify(resolve("src/update.ts"))};
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(
      callback, delay === 300_000 ? 500 : delay === 305_000 ? 800 : delay, ...args);
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (process.env.FIXTURE_MODE === "ignore-abort") {
        return new Promise(() => { setInterval(() => {}, 1000); });
      }
      return nativeFetch(String(url).startsWith("https://api.github.com/")
        ? process.env.FIXTURE_URL + "release" : url, options);
    };
    if (process.env.FIXTURE_MODE === "probe") {
      console.log(describeInstalledBinary(process.env.FIXTURE_PROBE));
    } else {
      try {
        await runUpdate({ currentVersion: "0.0.1", tag: "v99.0.0" });
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
    compile: { outfile: executable },
  });
  expect(build.success).toBe(true);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test.each([
  "release-headers",
  "release-body",
  "asset-headers",
  "asset-body",
  "ignore-abort",
])(
  "updater exits and removes temporary downloads on %s timeout",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "jenkins-update-timeout-"));
    const blocked = Promise.withResolvers<void>();
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const pathname = new URL(request.url).pathname;
        requests.push(pathname);
        const isRelease = pathname === "/release";
        if (isRelease && mode.startsWith("asset")) {
          const { resolveAssetName } = await import("../src/update");
          return Response.json({
            tag_name: "v99.0.0",
            assets: [
              {
                name: resolveAssetName(),
                browser_download_url: new URL("asset", server.url).href,
              },
            ],
          });
        }
        if (mode.endsWith("headers")) {
          await blocked.promise;
          return new Response("released");
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
        );
      },
    });
    const child = Bun.spawn([executable], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        TMP: home,
        TEMP: home,
        FIXTURE_MODE: mode,
        FIXTURE_URL: server.url.href,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        child.exited,
        new Promise<string>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("still running"), 2500);
        }),
      ]);
      expect(outcome).toBe(1);
      if (mode !== "ignore-abort") {
        expect(requests).toContain(
          mode.startsWith("asset") ? "/asset" : "/release",
        );
      }
      expect(
        (await readdir(fixtureDir)).filter((name) =>
          name.startsWith(".jenkins-cli-update-"),
        ),
      ).toEqual([]);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
      blocked.resolve();
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "version probe kills a hung executable",
  async () => {
    const probe = join(fixtureDir, "hung-probe");
    await Bun.write(probe, "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(probe, 0o755);
    const child = Bun.spawn([executable], {
      env: { ...process.env, FIXTURE_MODE: "probe", FIXTURE_PROBE: probe },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        child.exited,
        new Promise<string>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("still running"), 7000);
        }),
      ]);
      expect(outcome).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("null\n");
    } finally {
      clearTimeout(timer);
      // The fixture's probe must be killed even when running against the unfixed code.
      Bun.spawnSync(["pkill", "-KILL", "-P", String(child.pid)], {
        stderr: "ignore",
      });
      child.kill("SIGKILL");
      await child.exited;
    }
  },
  10_000,
);
