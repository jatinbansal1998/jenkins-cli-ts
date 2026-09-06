import { loadEnv } from "../src/env";

const rawOptions = process.env.TEST_LOAD_ENV_OPTIONS;
const options = rawOptions ? JSON.parse(rawOptions) : undefined;

try {
  const { jenkinsApiToken, ...env } = loadEnv(options);
  console.log(
    JSON.stringify({
      ok: true,
      env: {
        ...env,
        apiTokenMatches:
          jenkinsApiToken === process.env.TEST_EXPECTED_API_TOKEN,
      },
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ ok: false, message }));
  process.exitCode = 1;
}
