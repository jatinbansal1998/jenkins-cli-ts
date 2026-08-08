import { describe, expect, test } from "bun:test";
import { parseKeyringEnvironment } from "../scripts/run-with-linux-keyring";

describe("Linux keyring runner", () => {
  test("parses only supported environment assignments from the daemon", () => {
    expect(
      parseKeyringEnvironment(`
GNOME_KEYRING_CONTROL=/run/user/1000/keyring
SSH_AUTH_SOCK='/run/user/1000/keyring/ssh'; export SSH_AUTH_SOCK;
UNRELATED=value
malformed output
`),
    ).toEqual({
      GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
      SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
    });
  });

  test("every Linux CI test path uses the shared runner", async () => {
    for (const path of [
      ".github/workflows/pull-request.yml",
      ".github/workflows/post-merge.yml",
      ".github/workflows/release.yml",
    ]) {
      const workflow = await Bun.file(path).text();
      expect(workflow).toContain(
        "bun scripts/run-with-linux-keyring.ts -- bun test",
      );
      expect(workflow).not.toContain("gnome-keyring-daemon --unlock");
      expect(workflow).not.toContain("dbus-run-session -- bash");
    }
  });

  test("every Jenkins package script uses the shared runner", async () => {
    const packageJson = (await Bun.file("package.json").json()) as {
      scripts: Record<string, string>;
    };

    for (const name of [
      "test:integration:jenkins",
      "test:integration:jenkins-build-errors",
      "test:mutation:jenkins",
    ]) {
      expect(packageJson.scripts[name]).toStartWith(
        "bun scripts/run-with-linux-keyring.ts -- ",
      );
    }
  });
});
