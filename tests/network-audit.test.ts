import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditCommand,
  parseConnections,
  unexpectedConnections,
} from "./integration/jenkins/network-audit";

describe("outbound connection audit", () => {
  test("records IPv4, IPv6 and mapped addresses without payloads", () => {
    const connections = parseConnections(
      [
        '11 connect(3, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
        '12 connect(4, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr)}, 28) = -1 EINPROGRESS',
        '13 connect(5, {sa_family=AF_INET6, sin6_port=htons(8080), inet_pton(AF_INET6, "::ffff:127.0.0.1", &sin6_addr)}, 28) = 0',
        '14 connect(6, {sa_family=AF_UNIX, sun_path="/run/user/1000/bus"}, 110) = 0',
      ].join("\n"),
    );
    expect(connections).toEqual([
      { address: "127.0.0.1", port: 8080, count: 2 },
      { address: "2001:db8::1", port: 443, count: 1 },
    ]);
    expect(
      unexpectedConnections(connections, ["http://127.0.0.1:8080"]),
    ).toEqual([connections[1]!]);
    expect(
      unexpectedConnections(connections, ["http://127.0.0.1:8081"]),
    ).toHaveLength(2);
    expect(() =>
      parseConnections("connect(3, {sa_family=AF_INET, malformed}, 16)"),
    ).toThrow("incomplete");
  });

  test.skipIf(process.platform !== "linux" || !Bun.which("strace"))(
    "observes a child process and fails an unapproved destination",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "jenkins-network-audit-"));
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("ok"),
      });
      try {
        const code = `await fetch(${JSON.stringify(server.url.toString())});`;
        const audit = await auditCommand(
          [
            process.execPath,
            "-e",
            `const p = Bun.spawn([process.execPath, "-e", ${JSON.stringify(code)}]); await p.exited;`,
          ],
          [],
          directory,
        );
        const child = Bun.spawn({
          cmd: audit.command,
          stdout: "ignore",
          stderr: "pipe",
        });
        expect(await child.exited).toBe(0);
        await expect(audit.finish()).rejects.toThrow(
          "Unexpected CLI connections",
        );
        const reports = await readdir(directory);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toEndWith(".json");
        const report = await Bun.file(join(directory, reports[0]!)).json();
        expect(report.unexpected).toContainEqual({
          address: "127.0.0.1",
          port: server.port,
          count: 1,
        });
      } finally {
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
