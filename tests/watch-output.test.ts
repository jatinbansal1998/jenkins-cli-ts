import { describe, expect, test } from "bun:test";
import {
  createWatchSpinner,
  fitWatchSpinnerMessage,
} from "../src/commands/watch-output";

function createOutput(columns = 80) {
  const writes: string[] = [];
  return {
    output: {
      columns,
      write(chunk: string) {
        writes.push(chunk);
      },
    },
    writes,
  };
}

describe("watch spinner output", () => {
  test("updates one terminal line without an animation timer", () => {
    const { output, writes } = createOutput();
    const spinner = createWatchSpinner(output);

    spinner.start("Watching api");
    spinner.message("api: #34 | RUNNING");
    spinner.message("api");

    expect(writes).toHaveLength(3);
    expect(writes[0]).toBe("\r◒  Watching api");
    expect(writes[1]).toBe("\r◒  api: #34 | RUNNING");
    expect(writes[2]?.trimEnd()).toBe("\r◒  api");
    expect(writes[2]).toHaveLength(writes[1]?.length ?? 0);
    expect(writes.every((write) => !write.includes("\n"))).toBe(true);
  });

  test("pads the live row before writing a persistent result", () => {
    const { output, writes } = createOutput();
    const spinner = createWatchSpinner(output);

    spinner.start("Watching api");
    spinner.stop("Done.");
    spinner.message("ignored after stop");

    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe("\r◇  Done.       \n");
  });

  test("clears every row occupied by a line reflowed after resize", () => {
    const { output, writes } = createOutput(50);
    const spinner = createWatchSpinner(output);

    spinner.start("x".repeat(80));
    output.columns = 20;
    spinner.message("resized");

    expect(Bun.stringWidth((writes[0] ?? "").slice(1))).toBeLessThanOrEqual(49);
    expect(writes[1]).toStartWith(
      "\r\u001B[2K\u001B[1A\r\u001B[2K\u001B[1A\r\u001B[2K",
    );
    expect(writes[1]).toEndWith("◒  resized");
  });

  test("leaves room for the live prefix and terminal margin", () => {
    const message =
      "https://jenkins.example.com/job/a-very-long-job-name: #34 | RUNNING | [4/10]";

    const fitted = fitWatchSpinnerMessage(message, 50);

    expect(Bun.stringWidth(fitted)).toBeLessThanOrEqual(46);
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

    expect(Bun.stringWidth(fitted)).toBeLessThanOrEqual(14);
  });

  test("handles extremely narrow terminals", () => {
    expect(fitWatchSpinnerMessage("status", 4)).toBe("");
    expect(fitWatchSpinnerMessage("status", 5)).toBe("…");
    expect(Bun.stringWidth(fitWatchSpinnerMessage("status", 6))).toBe(2);
  });
});
