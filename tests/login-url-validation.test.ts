import { describe, expect, test } from "bun:test";
import { validateLoginUrl } from "../src/commands/login";

describe("login URL validation", () => {
  test("guides URLs that omit the scheme", () => {
    expect(validateLoginUrl("jenkins.example.com")).toBe(
      "Invalid JENKINS_URL. Use a full URL like https://jenkins.example.com.",
    );
  });

  test("guides URLs that use an unsupported protocol", () => {
    expect(validateLoginUrl("ftp://jenkins.example.com")).toBe(
      "Invalid JENKINS_URL protocol. Use http:// or https:// for JENKINS_URL.",
    );
  });

  test("accepts HTTP and HTTPS URLs", () => {
    expect(validateLoginUrl("http://jenkins.example.com:8080")).toBeUndefined();
    expect(validateLoginUrl("https://jenkins.example.com")).toBeUndefined();
  });

  test("requires empty input when there is no existing profile URL", () => {
    expect(validateLoginUrl("  ")).toBe("Value required.");
  });

  test("accepts empty input when an existing profile URL is available", () => {
    expect(
      validateLoginUrl("", "https://existing-jenkins.example.com"),
    ).toBeUndefined();
  });
});
