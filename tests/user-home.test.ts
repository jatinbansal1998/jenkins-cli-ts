import { describe, expect, test } from "bun:test";
import { selectUserHome } from "../src/user-home";

describe("user home resolution", () => {
  test("uses an explicit native home override on every platform", () => {
    expect(selectUserHome("/tmp/test-home", "/home/user", "linux")).toBe(
      "/tmp/test-home",
    );
    expect(
      selectUserHome(
        String.raw`D:\isolated-home`,
        String.raw`C:\Users\user`,
        "win32",
      ),
    ).toBe(String.raw`D:\isolated-home`);
  });

  test("falls back to the native home when HOME is missing or blank", () => {
    expect(selectUserHome(undefined, "/home/user", "linux")).toBe("/home/user");
    expect(selectUserHome("  ", "/home/user", "linux")).toBe("/home/user");
  });

  test("ignores an MSYS-style HOME on Windows", () => {
    expect(
      selectUserHome("/c/Users/user", String.raw`C:\Users\user`, "win32"),
    ).toBe(String.raw`C:\Users\user`);
  });
});
