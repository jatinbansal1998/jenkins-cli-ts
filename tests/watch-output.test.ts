import { describe, expect, test } from "bun:test";
import { fitWatchSpinnerMessage } from "../src/commands/watch-output";

describe("watch spinner output", () => {
  test("leaves room for the spinner decoration and terminal margin", () => {
    const message =
      "https://jenkins.example.com/job/a-very-long-job-name: #34 | RUNNING | [4/10]";

    const fitted = fitWatchSpinnerMessage(message, 50);

    expect(Bun.stringWidth(fitted)).toBeLessThanOrEqual(43);
    expect(fitted).toStartWith("https://jenkins");
    expect(fitted).toEndWith("RUNNING | [4/10]");
    expect(fitted).toContain("…");
  });

  test("does not alter a message that already fits safely", () => {
    const message = "api: #34 | RUNNING";

    expect(fitWatchSpinnerMessage(message, 80)).toBe(message);
  });

  test("measures wide characters by terminal columns", () => {
    const fitted = fitWatchSpinnerMessage("測試測試測試 status", 18);

    expect(Bun.stringWidth(fitted)).toBeLessThanOrEqual(11);
  });

  test("handles extremely narrow terminals", () => {
    expect(fitWatchSpinnerMessage("status", 7)).toBe("");
    expect(fitWatchSpinnerMessage("status", 8)).toBe("…");
    expect(Bun.stringWidth(fitWatchSpinnerMessage("status", 9))).toBe(2);
  });
});
