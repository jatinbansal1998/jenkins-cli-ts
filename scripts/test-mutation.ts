import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Mutation = {
  name: string;
  file: string;
  original: string;
  replacement: string;
};

const network = process.argv.includes("--network");
const mutations: Mutation[] = network
  ? [
      {
        name: "retries a committed build POST",
        file: "src/jenkins/client.ts",
        original:
          'context: "trigger build",\n      body,\n      transportRetries: 0,',
        replacement:
          'context: "trigger build",\n      body,\n      transportRetries: 1,',
      },
      {
        name: "retries a committed create POST",
        file: "src/jenkins/client.ts",
        original: "context,\n      transportRetries: 0,",
        replacement: "context,\n      transportRetries: 1,",
      },
      {
        name: "does not retry a timed-out read",
        file: "src/jenkins/client.ts",
        original:
          'private async requestJson<T>(url: string, context: string): Promise<T> {\n    const response = await this.fetchWithTimeout(\n      url,\n      { method: "GET", headers: this.authHeaders() },\n      1,',
        replacement:
          'private async requestJson<T>(url: string, context: string): Promise<T> {\n    const response = await this.fetchWithTimeout(\n      url,\n      { method: "GET", headers: this.authHeaders() },\n      0,',
      },
      {
        name: "does not retry an idempotent cancellation",
        file: "src/jenkins/client.ts",
        original: "const transportRetries = options.transportRetries ?? 1;",
        replacement: "const transportRetries = options.transportRetries ?? 0;",
      },
    ]
  : [
      {
        name: "uses an invalid Jenkins authorization scheme",
        file: "src/jenkins/client.ts",
        original: "this.authHeader = `Basic ${token}`;",
        replacement: "this.authHeader = `Bearer ${token}`;",
      },
      {
        name: "drops submitted build parameter values",
        file: "src/jenkins/client.ts",
        original: "filteredParams.set(normalizedKey, value);",
        replacement: 'filteredParams.set(normalizedKey, "");',
      },
      {
        name: "ignores the Jenkins queue Location header",
        file: "src/jenkins/client.ts",
        original: 'response.headers.get("location") ?? undefined',
        replacement: 'response.headers.get("x-location") ?? undefined',
      },
      {
        name: "hides the latest build result",
        file: "src/jenkins/client.ts",
        original: "result: lastBuild.result ?? null,",
        replacement: "result: null,",
      },
      {
        name: "requests JSON instead of progressive build logs",
        file: "src/jenkins/client.ts",
        original: 'this.withJob(buildUrl, "logText/progressiveText")',
        replacement: 'this.withJob(buildUrl, "api/json")',
      },
      {
        name: "downloads artifacts without authentication",
        file: "src/jenkins/client.ts",
        original:
          "const headers: Record<string, string> = { Authorization: this.authHeader };",
        replacement: "const headers: Record<string, string> = {};",
      },
      {
        name: "hides build results from history",
        file: "src/jenkins/client.ts",
        original: "result: build.result ?? null,",
        replacement: "result: null,",
      },
    ];

const integration = process.argv.includes("--integration");
if (network && !integration)
  throw new Error("--network requires --integration.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxParent = await mkdtemp(join(tmpdir(), "jenkins-cli-mutation-"));
const sandbox = join(sandboxParent, "workspace");

try {
  await cp(root, sandbox, {
    recursive: true,
    filter: (source) => shouldCopy(source),
  });
  await symlink(
    join(root, "node_modules"),
    join(sandbox, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  console.log(
    `Running ${mutations.length} ${integration ? "Jenkins integration" : "Jenkins client"} mutation canaries...`,
  );
  const baselineTypecheck = await run(["bun", "run", "typecheck"]);
  if (!baselineTypecheck.ok) {
    throw new Error(
      `Mutation baseline does not typecheck:\n${baselineTypecheck.output}`,
    );
  }
  const baseline = await runSuite();
  if (!baseline.ok) {
    throw new Error(`Mutation baseline failed:\n${baseline.output}`);
  }

  const survived: string[] = [];
  for (const mutation of mutations) {
    const path = join(sandbox, mutation.file);
    const source = await Bun.file(path).text();
    const occurrences = source.split(mutation.original).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Mutation "${mutation.name}" expected one source match, found ${occurrences}.`,
      );
    }

    await Bun.write(
      path,
      source.replace(mutation.original, mutation.replacement),
    );
    try {
      const typecheck = await run(["bun", "run", "typecheck"]);
      if (!typecheck.ok) {
        throw new Error(
          `Mutation "${mutation.name}" is not type-safe:\n${typecheck.output}`,
        );
      }
      const result = await runSuite();
      if (result.ok) {
        survived.push(mutation.name);
        console.error(`SURVIVED: ${mutation.name}`);
      } else {
        console.log(`KILLED:   ${mutation.name}`);
        if (network) console.log(result.output);
      }
    } finally {
      await Bun.write(path, source);
    }
  }

  if (survived.length > 0) {
    throw new Error(
      `${survived.length} mutation ${survived.length === 1 ? "canary" : "canaries"} survived:\n${survived.map((name) => `- ${name}`).join("\n")}`,
    );
  }
  console.log(`All ${mutations.length} mutation canaries were killed.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(sandboxParent, { recursive: true, force: true });
}

function shouldCopy(source: string): boolean {
  const path = relative(root, source);
  if (!path || path.startsWith("..")) {
    return true;
  }
  const topLevel = path.split(/[\\/]/, 1)[0];
  return ![
    ".git",
    ".stryker-tmp",
    "dist",
    "node_modules",
    "test-artifacts",
  ].includes(topLevel ?? "");
}

async function runSuite(): Promise<{ ok: boolean; output: string }> {
  if (integration) {
    const build = await run(["bun", "run", "build"]);
    if (!build.ok) {
      return build;
    }
    return await run([
      "bun",
      "test",
      network
        ? "tests/integration/jenkins.test.ts"
        : "tests/integration/jenkins.contract.test.ts",
      ...(network ? ["--test-name-pattern", "Toxiproxy"] : []),
    ]);
  }
  return await run(["bun", "test", "tests/client.test.ts"]);
}

async function run(
  command: string[],
): Promise<{ ok: boolean; output: string }> {
  const subprocess = Bun.spawn({
    cmd: command,
    cwd: sandbox,
    env: {
      ...process.env,
      ...(integration ? { JENKINS_INTEGRATION_CLI_PATH: undefined } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      subprocess.kill();
    },
    integration ? 120_000 : 30_000,
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  clearTimeout(timeout);
  const output = stdout + stderr;
  return {
    ok: exitCode === 0 && !timedOut,
    output: timedOut ? `Timed out.\n${output}` : output,
  };
}
