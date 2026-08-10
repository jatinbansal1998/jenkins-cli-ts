import { describe, expect, test } from "bun:test";
import { CliError } from "../src/cli";
import {
  filterLogSince,
  filterTimestampedLog,
  parseSinceCutoff,
  splitLogLines,
  tailLogLines,
  transformLogLine,
} from "../src/log-filters";

describe("log filters", () => {
  test("keeps the last complete logical lines without inventing a trailing line", () => {
    expect(tailLogLines("one\ntwo\nthree\n", 2)).toEqual({
      text: "two\nthree\n",
      skippedBytes: 4,
    });
    expect(tailLogLines("one\r\ntwo\r\npartial", 2)).toEqual({
      text: "two\r\npartial",
      skippedBytes: 5,
    });
  });

  test("counts skipped UTF-8 bytes rather than JavaScript characters", () => {
    expect(tailLogLines("🚀 first\nsecond\n", 1)).toEqual({
      text: "second\n",
      skippedBytes: Buffer.byteLength("🚀 first\n"),
    });
  });

  test("filters raw text using aligned Jenkins timestamp metadata", () => {
    expect(
      filterLogSince(
        "old\nnew\nnewer\n",
        [
          "2026-08-01T11:59:00.000Z",
          "2026-08-01T12:00:00.000Z",
          "2026-08-01T12:01:00.000Z",
        ].join("\n"),
        Date.parse("2026-08-01T12:00:00Z"),
      ),
    ).toEqual({ text: "new\nnewer\n", skippedBytes: 4 });
  });

  test("rejects missing or malformed timestamp alignment", () => {
    for (const timestamps of [
      "2026-08-01T12:00:00.000Z\n",
      "not-a-time\n2026-08-01T12:00:00.000Z\n",
    ]) {
      expect(() =>
        filterLogSince("one\ntwo\n", timestamps, Date.now()),
      ).toThrow(CliError);
    }
  });

  test("strips Timestamper prefixes and ignores lines without timestamps", () => {
    expect(
      filterTimestampedLog(
        [
          "  Started by user",
          "2026-08-01T11:59:00.000Z  old",
          "2026-08-01T12:01:00.000Z  raw output",
          "  Finished: SUCCESS",
        ].join("\n"),
        Date.parse("2026-08-01T12:00:00Z"),
      ),
    ).toEqual({ text: "raw output\n", skippedBytes: 0 });
  });

  test("parses relative durations against controller time and ISO timestamps", () => {
    const now = Date.parse("2026-08-01T12:00:00Z");
    expect(parseSinceCutoff("30m", now)).toBe(now - 30 * 60_000);
    expect(parseSinceCutoff("1d", now)).toBe(now - 86_400_000);
    expect(parseSinceCutoff("2026-08-01T10:00:00Z", now)).toBe(
      Date.parse("2026-08-01T10:00:00Z"),
    );
  });

  test("splits LF, CRLF, and partial final lines while preserving bytes", () => {
    expect(splitLogLines("one\r\ntwo\npartial")).toEqual([
      "one\r\n",
      "two\n",
      "partial",
    ]);
  });

  test("plain output removes Jenkins metadata, terminal sequences, and Pipeline framing", () => {
    expect(
      transformLogLine(
        "[2026-08-10T12:34:56.789Z] \x1b[8mha:////metadata\x1b[0m\x1b[36mINFO\x1b[0m pushed\n",
        { plain: true, noTimestamps: false },
      ),
    ).toBe("[2026-08-10T12:34:56.789Z] INFO pushed\n");
    expect(
      transformLogLine("[2026-08-10T12:34:56.789Z] [Pipeline] // stage\n", {
        plain: true,
        noTimestamps: false,
      }),
    ).toBeNull();
  });

  test("no-timestamps removes only a leading bracketed ISO-8601 prefix", () => {
    expect(
      transformLogLine("[2026-08-10T12:34:56.789+05:30] output\r\n", {
        plain: false,
        noTimestamps: true,
      }),
    ).toBe("output\r\n");
    expect(
      transformLogLine("prefix [2026-08-10T12:34:56.789Z] output\n", {
        plain: false,
        noTimestamps: true,
      }),
    ).toBe("prefix [2026-08-10T12:34:56.789Z] output\n");
  });
});
