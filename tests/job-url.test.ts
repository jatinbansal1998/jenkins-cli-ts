import { describe, expect, test } from "bun:test";
import {
  areSameJobUrls,
  findJobByUrl,
  jobUrlToFullName,
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

  test("derives an item's full name from its URL", () => {
    expect(jobUrlToFullName("https://jenkins.example.com/job/api/")).toBe(
      "api",
    );
    expect(
      jobUrlToFullName("https://jenkins.example.com/job/team/job/api"),
    ).toBe("team/api");
    expect(
      jobUrlToFullName("https://ci.example.com/jenkins/job/cli%20space%20job/"),
    ).toBe("cli space job");
    expect(jobUrlToFullName("https://jenkins.example.com/")).toBeUndefined();
    expect(jobUrlToFullName("not a url")).toBeUndefined();
    expect(
      jobUrlToFullName("https://jenkins.example.com/job/%"),
    ).toBeUndefined();
  });

  test("derives the job URL from a build URL", () => {
    expect(
      resolveJobUrlFromBuildUrl(
        " https://jenkins.example.com/job/api/42/?delay=0sec ",
      ),
    ).toBe("https://jenkins.example.com/job/api");
  });
});
