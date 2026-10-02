import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import {
  CliError,
  handleCliError,
  printHint,
  printLine,
  printOk,
  printWarning,
  setQuietMode,
  writeStdout,
} from "../src/cli";
import { applyOutputOptions, validateOutputOptions } from "../src/cli/options";
import { runCli } from "./helpers.cli";

type ConsoleMethod = (...data: unknown[]) => void;

let logSpy: Mock<ConsoleMethod>;
let errorSpy: Mock<ConsoleMethod>;
let writeSpy: Mock<typeof process.stdout.write>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  setQuietMode(false);
  logSpy.mockRestore();
  errorSpy.mockRestore();
  writeSpy.mockRestore();
});

describe("--quiet", () => {
  test("drops command output and informational hints", () => {
    setQuietMode(true);
    printOk("Triggered build.");
    printLine("table row");
    printHint("Run status to follow it.");
    printWarning("Skipping malformed job entry: {}");
    writeStdout("raw output\n");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("still prints an error and its hints to stderr", () => {
    setQuietMode(true);
    handleCliError(
      new CliError("No jobs match.", ["Run list --refresh."], "JOB_NOT_FOUND"),
    );

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls).toEqual([
      ["ERROR: No jobs match."],
      ["HINT: Run list --refresh."],
    ]);
  });

  test("prints output when not quiet", () => {
    printOk("Triggered build.");
    printHint("Run status to follow it.");

    expect(logSpy.mock.calls).toEqual([["OK: Triggered build."]]);
    expect(errorSpy.mock.calls).toEqual([["HINT: Run status to follow it."]]);
  });

  test("cannot be combined with structured output", () => {
    for (const argv of [
      { quiet: true, json: true },
      { quiet: true, jsonl: true },
    ]) {
      expect(() => validateOutputOptions(argv)).toThrow(
        expect.objectContaining({ code: "INVALID_USAGE" }),
      );
    }
  });
});

describe("--quiet through the CLI entry point", () => {
  test("help --json rejects --quiet like every other --json command", () => {
    const result = runCli(["help", "--json", "--quiet"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: { code: "INVALID_USAGE" },
    });
  });

  test("an error still reaches stderr when --json was negated", () => {
    const result = runCli(["auth", "login", "--json", "--no-json", "--quiet"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("ERROR: Missing required --url.");
  });

  test("still prints help that was asked for", () => {
    const result = runCli(["help", "--full", "--quiet"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("--quiet");
  });
});

describe("--no-color", () => {
  let savedNoColor: string | undefined;
  let savedForceColor: string | undefined;

  beforeEach(() => {
    savedNoColor = process.env.NO_COLOR;
    savedForceColor = process.env.FORCE_COLOR;
  });

  afterEach(() => {
    restoreEnv("NO_COLOR", savedNoColor);
    restoreEnv("FORCE_COLOR", savedForceColor);
  });

  test("sets NO_COLOR and clears FORCE_COLOR", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    applyOutputOptions({ color: false });
    expect(readEnv("NO_COLOR")).toBe("1");
    expect(readEnv("FORCE_COLOR")).toBeUndefined();
  });

  test("leaves the environment alone by default", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    applyOutputOptions({ color: true });
    expect(readEnv("NO_COLOR")).toBeUndefined();
    expect(readEnv("FORCE_COLOR")).toBe("1");
  });
});

/** Reads through a key so TypeScript does not narrow on the earlier writes. */
function readEnv(key: string): string | undefined {
  return process.env[key];
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
