import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectConfigDir } from "../src/config-dir";
import { stampFreshUpdateState } from "./helpers.update-state";

const home = "/home/user";
const override = "/srv/ci/jenkins-config";
const xdg = "/home/user/.xdg";
const appData = String.raw`C:\Users\user\AppData\Roaming`;

describe("config directory resolution", () => {
  test("JENKINS_CLI_CONFIG_DIR is used as-is and beats every other source", () => {
    const env = {
      JENKINS_CLI_CONFIG_DIR: override,
      XDG_CONFIG_HOME: xdg,
      APPDATA: appData,
    };
    expect(selectConfigDir(env, home, "win32")).toBe(override);
    expect(selectConfigDir(env, home, "linux")).toBe(override);
  });

  test("XDG_CONFIG_HOME beats APPDATA", () => {
    const env = { XDG_CONFIG_HOME: xdg, APPDATA: appData };
    expect(selectConfigDir(env, home, "win32")).toBe(join(xdg, "jenkins-cli"));
  });

  test("APPDATA beats the home default on Windows only", () => {
    const env = { APPDATA: appData };
    expect(selectConfigDir(env, home, "win32")).toBe(
      join(appData, "jenkins-cli"),
    );
    expect(selectConfigDir(env, home, "linux")).toBe(
      join(home, ".config", "jenkins-cli"),
    );
  });

  test("blank values fall through to the home default", () => {
    const env = {
      JENKINS_CLI_CONFIG_DIR: " ",
      XDG_CONFIG_HOME: "",
      APPDATA: "  ",
    };
    expect(selectConfigDir(env, home, "win32")).toBe(
      join(home, ".config", "jenkins-cli"),
    );
  });

  test("an override pointing at a fresh directory ignores the home config", () => {
    const realHome = mkdtempSync(join(tmpdir(), "jenkins-cli-real-home-"));
    const sandbox = mkdtempSync(join(tmpdir(), "jenkins-cli-override-"));
    const homeConfigDir = join(realHome, ".config", "jenkins-cli");
    const homeConfigFile = join(homeConfigDir, "jenkins-cli-config.json");
    const overrideDir = join(sandbox, ".config", "jenkins-cli");
    try {
      stampFreshUpdateState(realHome);
      stampFreshUpdateState(sandbox);
      const homeConfig = JSON.stringify({
        version: 2,
        defaultProfile: "work",
        profiles: {
          work: {
            jenkinsUrl: "http://127.0.0.1:1",
            jenkinsUser: "ci",
            jenkinsApiToken: "home-token",
          },
        },
      });
      mkdirSync(homeConfigDir, { recursive: true });
      writeFileSync(homeConfigFile, homeConfig);
      const homeEntries = readdirSync(homeConfigDir).toSorted();

      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/index.ts", "auth", "status"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: realHome,
          JENKINS_CLI_CONFIG_DIR: overrideDir,
          JENKINS_URL: undefined,
          JENKINS_USER: undefined,
          JENKINS_API_TOKEN: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const output =
        new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);

      expect(result.exitCode).toBe(3);
      expect(output).toContain("Profile:          Environment");
      expect(output).toContain(
        `Config file:      ${join(overrideDir, "jenkins-cli-config.json")}`,
      );
      expect(output).toContain("ERROR: Missing JENKINS_URL.");
      expect(readFileSync(homeConfigFile, "utf8")).toBe(homeConfig);
      expect(readdirSync(homeConfigDir).toSorted()).toEqual(homeEntries);
    } finally {
      rmSync(realHome, { recursive: true, force: true });
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
