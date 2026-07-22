import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STARTUP_TIMEOUT_MS = 4 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const image =
  process.env.JENKINS_TEST_IMAGE?.trim() || "jenkins/jenkins:lts-jdk21";
const mutationMode = process.argv.includes("--mutation");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "tests", "integration", "jenkins", "init.groovy");
const containerName = `jenkins-cli-integration-${process.pid}-${Date.now()}`;
const runtimeDir = await mkdtemp(
  join(tmpdir(), "jenkins-cli-integration-runtime-"),
);

let containerStarted = false;
let failed = false;

try {
  await chmod(runtimeDir, 0o777);
  await runChecked(["docker", "info"], {
    failureMessage:
      "Docker is required for Jenkins integration tests. Start Docker and try again.",
  });
  await runChecked([
    "docker",
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1::8080",
    "--tmpfs",
    "/var/jenkins_home:rw,uid=1000,gid=1000",
    "--env",
    "JAVA_OPTS=-Djenkins.install.runSetupWizard=false",
    "--mount",
    `type=bind,source=${fixture},target=/usr/share/jenkins/ref/init.groovy.d/01-integration.groovy,readonly`,
    "--mount",
    `type=bind,source=${runtimeDir},target=/run/jenkins-cli-integration`,
    image,
  ]);
  containerStarted = true;

  const portOutput = await runChecked([
    "docker",
    "port",
    containerName,
    "8080/tcp",
  ]);
  const port = portOutput.trim().match(/:(\d+)$/)?.[1];
  if (!port) {
    throw new Error(`Could not determine the Jenkins port from: ${portOutput}`);
  }

  const jenkinsUrl = `http://127.0.0.1:${port}`;
  const tokenFile = join(runtimeDir, "api-token");
  const token = await waitForJenkins(jenkinsUrl, tokenFile);

  console.log(`Jenkins integration controller ready at ${jenkinsUrl}`);
  const testCommand = mutationMode
    ? ["bun", "scripts/test-mutation.ts", "--integration"]
    : ["bun", "test", "tests/integration/jenkins.test.ts"];
  if (!mutationMode) {
    await runChecked(["bun", "run", "build"], { cwd: root, inherit: true });
  }
  await runChecked(testCommand, {
    cwd: root,
    inherit: true,
    env: {
      ...process.env,
      JENKINS_INTEGRATION_URL: jenkinsUrl,
      JENKINS_INTEGRATION_USER: "integration-test",
      JENKINS_INTEGRATION_TOKEN: token,
    },
  });
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (failed && containerStarted) {
    console.error("\nJenkins container logs:");
    await run(["docker", "logs", containerName], { inherit: true });
  }
  if (containerStarted) {
    await run(["docker", "rm", "--force", containerName]);
  }
  await rm(runtimeDir, { recursive: true, force: true });
}

async function waitForJenkins(
  jenkinsUrl: string,
  tokenFile: string,
): Promise<string> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastProblem = "Jenkins has not responded yet.";

  while (Date.now() < deadline) {
    const token = await readToken(tokenFile);
    if (token) {
      try {
        const response = await fetch(`${jenkinsUrl}/whoAmI/api/json`, {
          headers: {
            Authorization: `Basic ${Buffer.from(`integration-test:${token}`).toString("base64")}`,
          },
        });
        if (response.ok) {
          const identity = (await response.json()) as {
            authenticated?: boolean;
          };
          if (identity.authenticated) {
            return token;
          }
        }
        lastProblem = `Identity endpoint returned HTTP ${response.status}.`;
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : String(error);
      }
    }

    const running = await run([
      "docker",
      "inspect",
      "--format={{.State.Running}}",
      containerName,
    ]);
    if (running.exitCode !== 0 || running.stdout.trim() !== "true") {
      throw new Error("The Jenkins container stopped during startup.");
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Jenkins did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s. ${lastProblem}`,
  );
}

async function readToken(path: string): Promise<string | undefined> {
  try {
    const token = (await Bun.file(path).text()).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

type RunOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  inherit?: boolean;
};

async function run(
  command: string[],
  options: RunOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn({
      cmd: command,
      cwd: options.cwd,
      env: options.env,
      stdout: options.inherit ? "inherit" : "pipe",
      stderr: options.inherit ? "inherit" : "pipe",
    });
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    options.inherit
      ? Promise.resolve("")
      : new Response(
          subprocess.stdout as ReadableStream<Uint8Array> | undefined,
        ).text(),
    options.inherit
      ? Promise.resolve("")
      : new Response(
          subprocess.stderr as ReadableStream<Uint8Array> | undefined,
        ).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runChecked(
  command: string[],
  options: RunOptions & { failureMessage?: string } = {},
): Promise<string> {
  const result = await run(command, options);
  if (result.exitCode !== 0) {
    const details = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      [
        options.failureMessage ?? `Command failed: ${command.join(" ")}`,
        details,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}
