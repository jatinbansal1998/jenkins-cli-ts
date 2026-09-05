import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { invokeCli, jenkinsUrl, parseJson, withCliHome } from "./harness";

const api = process.env.JENKINS_INTEGRATION_TOXIPROXY_URL;
type Toxic = { type: string; attributes: Record<string, number> };

export function registerNetworkFaultTests(): void {
  describe.skipIf(!api)(
    "compiled CLI through Toxiproxy and real Jenkins",
    () => {
      test.skipIf(process.platform !== "linux")(
        "inventories external connections from a fresh profile",
        async () => {
          const directory = process.env.JENKINS_INTEGRATION_AUDIT_DIR!;
          await mkdir(directory, { recursive: true });
          const before = new Set(await readdir(directory));
          await withCliHome(async (home) => {
            await rm(join(home, ".config", "jenkins-cli", "update-state.json"));
            const result = await invokeCli(home, ["nodes", "--json"], {
              JENKINS_INTEGRATION_AUDIT_MODE: "observe",
            });
            expect(result.exitCode, result.output).toBe(0);
            expect(parseJson(result)).toMatchObject({
              ok: true,
              command: "nodes",
            });
          });
          const added = (await readdir(directory)).filter(
            (name) => !before.has(name),
          );
          expect(added).toHaveLength(1);
          const report = await Bun.file(join(directory, added[0]!)).json();
          expect(report.mode).toBe("observe");
          const controller = new URL(jenkinsUrl!);
          expect(report.connections).toContainEqual(
            expect.objectContaining({
              address: controller.hostname,
              port: Number(controller.port),
            }),
          );
        },
      );
      test("preserves reads with latency and rejects reset, truncated and timed-out responses", async () => {
        await withProxy(async (proxy) => {
          await withCliHome(async (home) => {
            const env = { JENKINS_URL: proxy.url };
            await proxy.toxic({
              type: "latency",
              attributes: { latency: 150, jitter: 0 },
            });
            const started = performance.now();
            const baseline = await invokeCli(home, ["nodes", "--json"], env);
            expect(baseline.exitCode, baseline.output).toBe(0);
            expect(parseJson(baseline)).toMatchObject({
              ok: true,
              command: "nodes",
            });
            expect(performance.now() - started).toBeGreaterThanOrEqual(150);
            await proxy.clear();

            const faults: Toxic[] = [
              { type: "reset_peer", attributes: { timeout: 0 } },
              { type: "limit_data", attributes: { bytes: 1024 } },
              { type: "timeout", attributes: { timeout: 0 } },
            ];
            for (const fault of faults) {
              proxy.requests.length = 0;
              await proxy.toxic(fault);
              const result = await invokeCli(
                home,
                ["list", "--refresh", "--json"],
                env,
              );
              expect(result.exitCode, result.output).not.toBe(0);
              expect(parseJson(result)).toMatchObject({
                ok: false,
                error: { message: expect.any(String) },
              });
              if (fault.type === "timeout") {
                expect(result.output).toContain("timed out");
                expect(
                  proxy.requests.filter((request) => request.method === "GET"),
                ).toHaveLength(2);
              }
              if (fault.type === "limit_data") {
                expect(result.output).toContain("Invalid JSON response");
              }
              await proxy.clear();
              const recovered = await invokeCli(home, ["nodes", "--json"], env);
              expect(recovered.exitCode, recovered.output).toBe(0);
              proxy.results.push({
                scenario: fault.type,
                exitCode: result.exitCode,
                recovered: true,
              });
            }
          });
        });
      }, 90_000);

      test("retries an idempotent queue cancellation after its response is lost", async () => {
        await withProxy(async (proxy) => {
          await withCliHome(async (home) => {
            const queued = await invokeCli(home, [
              "build",
              "--job-url",
              `${jenkinsUrl}/job/cli-always-queued/`,
              "--without-params",
              "--json",
            ]);
            expect(queued.exitCode, queued.output).toBe(0);
            const payload = parseJson<{ data: { queueUrl: string } }>(queued);
            const queueUrl = new URL(payload.data.queueUrl);
            proxy.loseNextPost({ type: "timeout", attributes: { timeout: 0 } });
            const cancelled = await invokeCli(
              home,
              [
                "cancel",
                "--queue-url",
                `${new URL(proxy.url).origin}${queueUrl.pathname}`,
                "--json",
              ],
              { JENKINS_URL: proxy.url },
            );
            expect(cancelled.exitCode, cancelled.output).not.toBe(0);
            await proxy.clear();
            expect(
              proxy.requests.filter(
                (request) =>
                  request.method === "POST" &&
                  request.path.endsWith("/cancelItem"),
              ),
            ).toHaveLength(2);
            const queue = await jenkinsJson<{ items: { url: string }[] }>(
              "/queue/api/json",
            );
            expect(
              queue.items.some(
                (item) => new URL(item.url).pathname === queueUrl.pathname,
              ),
            ).toBe(false);
            proxy.results.push({
              scenario: "lost cancellation response",
              cancelRequests: 2,
              removedFromQueue: true,
            });
          });
        });
      }, 45_000);

      test("does not repeat a build or item creation after Jenkins commits and the response is lost", async () => {
        await withProxy(async (proxy) => {
          await withCliHome(async (home) => {
            const env = { JENKINS_URL: proxy.url };
            const before = await jenkinsJson<{ nextBuildNumber: number }>(
              "/job/cli-network/api/json",
            );
            proxy.loseNextPost({ type: "timeout", attributes: { timeout: 0 } });
            const build = await invokeCli(
              home,
              [
                "build",
                "--job-url",
                `${proxy.url}/job/cli-network/`,
                "--without-params",
                "--json",
              ],
              env,
            );
            expect(build.exitCode, build.output).not.toBe(0);
            expect(parseJson(build)).toMatchObject({ ok: false });
            await proxy.clear();
            const deadline = Date.now() + 15_000;
            let after = await jenkinsJson<{ nextBuildNumber: number }>(
              "/job/cli-network/api/json",
            );
            while (
              after.nextBuildNumber === before.nextBuildNumber &&
              Date.now() < deadline
            ) {
              await Bun.sleep(100);
              after = await jenkinsJson("/job/cli-network/api/json");
            }
            expect(after.nextBuildNumber).toBe(before.nextBuildNumber + 1);
            expect(
              proxy.requests.filter(
                (request) =>
                  request.method === "POST" && request.path.endsWith("/build"),
              ),
            ).toHaveLength(1);

            proxy.requests.length = 0;
            const item = `cli-network-copy-${Date.now()}`;
            proxy.loseNextPost({
              type: "timeout",
              attributes: { timeout: 0 },
            });
            const create = await invokeCli(
              home,
              ["create", item, "--copy-from", "cli-network", "--json"],
              env,
            );
            expect(create.exitCode, create.output).not.toBe(0);
            expect(parseJson(create)).toMatchObject({ ok: false });
            await proxy.clear();
            expect(await jenkinsJson(`/job/${item}/api/json`)).toMatchObject({
              name: item,
            });
            expect(
              proxy.requests.filter(
                (request) =>
                  request.method === "POST" &&
                  request.path.endsWith("/createItem"),
              ),
            ).toHaveLength(1);
            proxy.results.push({
              scenario: "lost POST responses",
              buildsCreated: after.nextBuildNumber - before.nextBuildNumber,
              createRequests: 1,
            });
          });
        });
      }, 60_000);
    },
  );
}

async function jenkinsJson<T>(path: string): Promise<T> {
  const response = await fetch(`${jenkinsUrl}${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.JENKINS_INTEGRATION_USER}:${process.env.JENKINS_INTEGRATION_TOKEN}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Fixture inspection failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function control(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<Response> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Toxiproxy ${path}: HTTP ${response.status}`);
  return response;
}

async function withProxy(
  action: (proxy: {
    url: string;
    requests: { method: string; path: string }[];
    results: Record<string, unknown>[];
    toxic: (fault: Toxic) => Promise<void>;
    clear: () => Promise<void>;
    loseNextPost: (fault: Toxic) => void;
  }) => Promise<void>,
): Promise<void> {
  const name = `jenkins-${crypto.randomUUID()}`;
  const requests: { method: string; path: string }[] = [];
  const results: Record<string, unknown>[] = [];
  let pendingPostFault: Toxic | undefined;
  let active = false;
  async function toxic(fault: Toxic): Promise<void> {
    await control(`/proxies/${name}/toxics`, {
      name: "fault",
      stream: "downstream",
      toxicity: 1,
      ...fault,
    });
    active = true;
  }
  async function clear(): Promise<void> {
    if (active)
      await control(`/proxies/${name}/toxics/fault`, undefined, "DELETE");
    active = false;
  }
  // Observe the real server's commit before damaging its response. No timing race
  // between the test enabling a toxic and Jenkins accepting the POST.
  const observer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      const upstream = new URL(url.pathname + url.search, jenkinsUrl);
      const response = await fetch(upstream, {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer(),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.arrayBuffer();
      if (
        request.method === "POST" &&
        pendingPostFault &&
        response.status >= 200 &&
        response.status < 400
      ) {
        const fault = pendingPostFault;
        pendingPostFault = undefined;
        await toxic(fault);
      }
      // Keep headers below the truncation limit, so limit_data cuts the real JSON body.
      const headers = new Headers({
        "content-type":
          response.headers.get("content-type") ?? "application/octet-stream",
      });
      const location = response.headers.get("location");
      if (location) headers.set("location", location);
      headers.set("content-length", String(body.byteLength));
      return new Response(body, { status: response.status, headers });
    },
  });
  let created = false;
  try {
    const response = await control("/proxies", {
      name,
      listen: "127.0.0.1:0",
      upstream: `127.0.0.1:${observer.port}`,
    });
    created = true;
    const { listen } = (await response.json()) as { listen: string };
    await action({
      url: `http://${listen}/jenkins`,
      requests,
      results,
      toxic,
      clear,
      loseNextPost: (fault) => {
        pendingPostFault = fault;
      },
    });
  } finally {
    if (created) await control(`/proxies/${name}`, undefined, "DELETE");
    await observer.stop(true);
    const directory = process.env.JENKINS_INTEGRATION_ARTIFACT_DIR;
    if (directory)
      await Bun.write(
        join(directory, `${name}.json`),
        JSON.stringify({ results, requests }, null, 2) + "\n",
      );
  }
}
