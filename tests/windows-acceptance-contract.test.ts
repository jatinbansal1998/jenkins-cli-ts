import { describe, expect, test } from "bun:test";

const sourceWorkflowPaths = [
  ".github/workflows/pull-request.yml",
  ".github/workflows/post-merge.yml",
];

describe("Windows Jenkins acceptance backend contract", () => {
  test.each(sourceWorkflowPaths)(
    "%s verifies source builds through native-windows",
    async (path) => {
      const workflow = await Bun.file(path).text();

      expect(workflow).toContain("expected-credential-backend: native-windows");
    },
  );

  test("release validation verifies standalone assets through windows", async () => {
    const workflow = await Bun.file(".github/workflows/release.yml").text();

    expect(workflow).toContain("expected-credential-backend: windows");
    expect(workflow).not.toContain(
      "expected-credential-backend: native-windows",
    );
  });

  test("the composite action requires and forwards the backend", async () => {
    const action = await Bun.file(
      ".github/actions/windows-jenkins-acceptance/action.yml",
    ).text();
    const acceptance = await Bun.file(
      ".github/actions/windows-jenkins-acceptance/run-acceptance.ps1",
    ).text();

    expect(action).toContain("expected-credential-backend:");
    expect(action).toContain(
      "-ExpectedCredentialBackend $env:WINDOWS_ACCEPTANCE_EXPECTED_CREDENTIAL_BACKEND",
    );
    expect(acceptance).toContain('[ValidateSet("native-windows", "windows")]');
    expect(acceptance).toContain("await useBackend(expectedBackend);");
  });
});
