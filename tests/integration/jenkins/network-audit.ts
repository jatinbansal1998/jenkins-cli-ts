import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type Connection = { address: string; port: number; count: number };

export function parseConnections(trace: string): Connection[] {
  const connections = new Map<string, Connection>();
  for (const line of trace.split("\n")) {
    if (!line.includes("connect(") || !/sa_family=AF_INET6?[,}]/.test(line))
      continue;
    const port = line.match(/sin6?_port=htons\((\d+)\)/)?.[1];
    const address =
      line.match(/inet_addr\("([^"]+)"\)/)?.[1] ??
      line.match(/inet_pton\(AF_INET6, "([^"]+)"/)?.[1];
    if (!port || !address)
      throw new Error(
        "Unrecognized internet connect trace; audit is incomplete.",
      );
    const normalized = address.replace(/^::ffff:/, "");
    const key = `${normalized}:${port}`;
    const previous = connections.get(key);
    connections.set(key, {
      address: normalized,
      port: Number(port),
      count: (previous?.count ?? 0) + 1,
    });
  }
  return [...connections.values()].toSorted(
    (a, b) => a.address.localeCompare(b.address) || a.port - b.port,
  );
}

export function unexpectedConnections(
  connections: Connection[],
  allowedUrls: string[],
): Connection[] {
  const allowed = allowedUrls.map((value) => {
    const url = new URL(value);
    return {
      address: url.hostname.replaceAll(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  });
  return connections.filter(
    (connection) =>
      !allowed.some(
        (endpoint) =>
          endpoint.address === connection.address &&
          endpoint.port === connection.port,
      ),
  );
}

export async function auditCommand(
  command: string[],
  allowedUrls: string[],
  directory = process.env.JENKINS_INTEGRATION_AUDIT_DIR,
  enforce = true,
): Promise<{ command: string[]; finish: () => Promise<void> }> {
  if (!directory) return { command, finish: async () => {} };
  if (process.platform !== "linux" || !Bun.which("strace")) {
    throw new Error("Linux outbound connection auditing requires strace.");
  }
  await mkdir(directory, { recursive: true });
  const id = crypto.randomUUID();
  const tracePath = join(directory, `${id}.trace`);
  return {
    // Trace socket destinations only. Never capture buffers, headers, argv or credentials.
    command: [
      "strace",
      "-f",
      "-qq",
      "-e",
      "trace=connect",
      "-o",
      tracePath,
      "--",
      ...command,
    ],
    async finish() {
      const connections = parseConnections(await Bun.file(tracePath).text());
      const unexpected = unexpectedConnections(connections, allowedUrls);
      await Bun.write(
        join(directory, `${id}.json`),
        JSON.stringify(
          {
            schemaVersion: 1,
            command: command[1],
            mode: enforce ? "enforce" : "observe",
            connections,
            unexpected,
          },
          null,
          2,
        ) + "\n",
      );
      await rm(tracePath);
      if (enforce && unexpected.length) {
        throw new Error(
          `Unexpected CLI connections: ${unexpected.map(({ address, port }) => `${address}:${port}`).join(", ")}. Report: ${directory}`,
        );
      }
    },
  };
}
