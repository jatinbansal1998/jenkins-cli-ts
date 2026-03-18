import { describe, expect, test } from "bun:test";
import {
  areSameJobUrls,
  findJobByUrl,
  resolveJobUrlFromBuildUrl,
} from "../src/job-url";

describe("job-url helpers", () => {
  test("compares job URLs after trimming and removing trailing slashes", () => {
    expect(
      areSameJobUrls(
        " https://jenkins.example.com/job/api/ ",
        "https://jenkins.example.com/job/api",
      ),
    ).toBe(true);
  });

  test("finds a job by URL across trailing-slash variants", () => {
    expect(
      findJobByUrl(
        [{ url: "https://jenkins.example.com/job/api/", name: "api" }],
        "https://jenkins.example.com/job/api",
      ),
    ).toEqual({
      url: "https://jenkins.example.com/job/api/",
      name: "api",
    });
  });

  test("derives the job URL from a build URL", () => {
    expect(
      resolveJobUrlFromBuildUrl(
        " https://jenkins.example.com/job/api/42/?delay=0sec ",
      ),
    ).toBe("https://jenkins.example.com/job/api");
  });
});
