import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform === "win32")(
  "updating never copies over the installed executable across filesystems",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "jenkins-update-install-"));
    const installDir = join(home, "bin");
    const downloadDir = join(home, "downloads");
    await mkdir(installDir);
    await mkdir(downloadDir);
    const target = join(installDir, "jenkins-cli");
    await Bun.write(target, "original executable");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { mock } from "bun:test";
      import * as fs from "node:fs/promises";
      const realFs = { ...fs };
      const realRename = fs.rename.bind(fs);
      const realWriteFile = fs.writeFile.bind(fs);
      mock.module("node:fs/promises", () => ({
        ...realFs,
        rename: async (source, destination) => {
          if (!String(source).startsWith(${JSON.stringify(installDir + "/")})) {
            throw Object.assign(new Error("different filesystem"), { code: "EXDEV" });
          }
          await realRename(source, destination);
        },
        copyFile: async (source, destination) => {
          await realWriteFile(destination, "partial executable");
          throw new Error("interrupted copy");
        },
      }));
      globalThis.fetch = async () => new Response("complete replacement");
      const { downloadAndInstall } = await import(${JSON.stringify(resolve("src/update.ts"))});
      try { await downloadAndInstall("https://example.invalid/asset", ${JSON.stringify(target)}, "1.0.0"); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
      `,
      ],
      {
        env: { ...process.env, TMPDIR: downloadDir },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
    try {
      const code = await child.exited;
      expect(await Bun.file(target).text()).toBe("complete replacement");
      expect(code).toBe(0);
      expect(await readdir(installDir)).toEqual(["jenkins-cli"]);
      expect(await readdir(downloadDir)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
  },
);
