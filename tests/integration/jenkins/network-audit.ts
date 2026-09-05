import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type Connection = { address: string; port: number; count: number };

export function parseConnections(trace: string): Connection[] {
  const connections = new Map<string, Connection>();
  const pending = new Map<string, string>();
  if (trace && !trace.endsWith("\n"))
    throw new Error("Truncated socket trace; audit is incomplete.");
  for (let line of trace.split("\n")) {
    const pid = line.match(/^\s*(\d+)/)?.[1] ?? "main";
    if (line.includes("connect(") && line.endsWith("<unfinished ...>")) {
      pending.set(pid, line.replace("<unfinished ...>", ""));
      continue;
    }
    if (line.includes("<... connect resumed>")) {
      const start = pending.get(pid);
      if (!start)
        throw new Error("Unmatched socket trace; audit is incomplete.");
      pending.delete(pid);
      line = start + line.split("<... connect resumed>")[1];
    }
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
  if (pending.size)
    throw new Error("Interrupted socket trace; audit is incomplete.");
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
      let connections: Connection[] | null = null;
      let auditError: string | undefined;
      try {
        connections = parseConnections(await Bun.file(tracePath).text());
      } catch (error) {
        auditError =
          error instanceof Error ? error.message : "Cannot read socket trace";
      }
      const unexpected =
        connections === null
          ? null
          : unexpectedConnections(connections, allowedUrls);
      await Bun.write(
        join(directory, `${id}.json`),
        JSON.stringify(
          {
            schemaVersion: 1,
            command: command[1],
            mode: enforce ? "enforce" : "observe",
            complete: auditError === undefined,
            ...(auditError ? { auditError } : {}),
            connections,
            unexpected,
          },
          null,
          2,
        ) + "\n",
      );
      await rm(tracePath, { force: true });
      if (auditError)
        throw new Error(
          `Network audit is incomplete: ${auditError}. Report: ${directory}`,
        );
      if (enforce && unexpected?.length) {
        throw new Error(
          `Unexpected CLI connections: ${unexpected.map(({ address, port }) => `${address}:${port}`).join(", ")}. Report: ${directory}`,
        );
      }
    },
  };
}
