import { loadEnv } from "../src/env";

const rawOptions = process.env.TEST_LOAD_ENV_OPTIONS;
const options = rawOptions ? JSON.parse(rawOptions) : undefined;

try {
  const env = loadEnv(options);
  console.log(JSON.stringify({ ok: true, env }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ ok: false, message }));
  process.exitCode = 1;
}
