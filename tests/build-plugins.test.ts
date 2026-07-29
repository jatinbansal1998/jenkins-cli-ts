import { describe, expect, test } from "bun:test";
import { embedCrossKeychainCredman } from "../scripts/build-plugins";

const loader = `let credmanBootstrap = null;
async function getCredmanBootstrap() {
    if (!credmanBootstrap) {
        const scriptPath = path.join(__dirname, "scripts", "credman.ps1");
        credmanBootstrap = await promises.readFile(scriptPath, "utf-8");
    }
    return credmanBootstrap;
}`;

describe("build plugins", () => {
  test("embeds the Credential Manager bootstrap without a runtime file lookup", () => {
    const transformed = embedCrossKeychainCredman(
      loader,
      "Write-Output 'credential helper'",
    );

    expect(transformed).toContain("Write-Output 'credential helper'");
    expect(transformed).not.toContain("promises.readFile");
    expect(transformed).not.toContain("credman.ps1");
  });

  test("fails when a cross-keychain update changes the loader shape", () => {
    expect(() =>
      embedCrossKeychainCredman("export const changed = true;", "script"),
    ).toThrow("no longer matches the expected shape");
  });
});
