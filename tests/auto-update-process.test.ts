import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform === "win32")(
  "foreground exits while the detached update download is still pending",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "jenkins-auto-update-"));
    const downloadStarted = Promise.withResolvers<void>();
    const releaseDownload = Promise.withResolvers<void>();
    const workerFinished = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/finished") {
          workerFinished.resolve();
          return new Response("ok");
        }
        downloadStarted.resolve();
        await releaseDownload.promise;
        return new Response("synthetic download failure", { status: 500 });
      },
    });
    const entrypoint = join(home, "fixture.ts");
    const executable = join(home, "jenkins-cli");
    await Bun.write(
      entrypoint,
      `
      import { kickOffAutoUpdate, resolveAssetName } from ${JSON.stringify(resolve("src/update.ts"))};
      import { runUpdate } from ${JSON.stringify(resolve("src/commands/update.ts"))};
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => String(url).startsWith("https://api.github.com/")
        ? Promise.resolve(Response.json({ tag_name: "v99.0.0", assets: [{
            name: resolveAssetName(), browser_download_url: ${JSON.stringify(server.url.href)}
          }] }))
        : nativeFetch(url, options);
      if (process.argv[2] === "update") {
        try {
          await runUpdate({ currentVersion: "0.0.1", tag: process.argv[3] });
        } catch {
          process.exitCode = 1;
        } finally {
          await nativeFetch(${JSON.stringify(new URL("finished", server.url).href)});
        }
      } else {
        kickOffAutoUpdate("0.0.1", ["auth", "list"]);
        console.log("foreground finished");
      }
    `,
    );
    const build = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      compile: { outfile: executable },
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn([executable], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await downloadStarted.promise;
      const exitCode = await Promise.race([
        child.exited,
        new Promise<"still running">((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout("still running"), 1500);
        }),
      ]);
      expect(exitCode).toBe(0);
      expect(await new Response(child.stdout).text()).toBe(
        "foreground finished\n",
      );
      expect(await new Response(child.stderr).text()).toBe("");
      releaseDownload.resolve();
      await workerFinished.promise;
    } finally {
      clearTimeout(timeout);
      releaseDownload.resolve();
      await child.exited;
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  },
  15_000,
);
