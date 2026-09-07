import { describe, expect, test } from "bun:test";
import {
  normalizePendingInputActions,
  resolveBuildScopedUrl,
  sanitizeInputText,
} from "../src/pipeline-inputs";

const BUILD_URL = "https://jenkins.example.com/jenkins/job/deploy/128/";

describe("resolveBuildScopedUrl", () => {
  test("resolves root-relative Jenkins links under the build", () => {
    expect(
      resolveBuildScopedUrl(
        "/jenkins/job/deploy/128/wfapi/inputSubmit?inputId=Release",
        BUILD_URL,
      ),
    ).toBe(
      "https://jenkins.example.com/jenkins/job/deploy/128/wfapi/inputSubmit?inputId=Release",
    );
    expect(
      resolveBuildScopedUrl(
        "/jenkins/job/deploy/128/input/Release/abort",
        BUILD_URL,
      ),
    ).toBe(
      "https://jenkins.example.com/jenkins/job/deploy/128/input/Release/abort",
    );
  });

  test("accepts absolute links on the same origin under the build", () => {
    expect(
      resolveBuildScopedUrl(
        `${BUILD_URL}input/`,
        "https://jenkins.example.com/jenkins/job/deploy/128",
      ),
    ).toBe(`${BUILD_URL}input/`);
  });

  test("rejects links that leave the build, the origin, or carry credentials", () => {
    const cases: unknown[] = [
      "https://evil.example.com/jenkins/job/deploy/128/input/Release/abort",
      "//evil.example.com/jenkins/job/deploy/128/input/Release/abort",
      "http://jenkins.example.com/jenkins/job/deploy/128/input/Release/abort",
      "/jenkins/job/deploy/129/input/Release/abort",
      "/jenkins/job/other/128/input/Release/abort",
      "/other/job/deploy/128/input/Release/abort",
      "https://user:pass@jenkins.example.com/jenkins/job/deploy/128/input/Release/abort",
      "/jenkins/job/deploy/128/input/Release/abort#frag",
      "",
      "   ",
      undefined,
      null,
      42,
    ];
    for (const href of cases) {
      expect(resolveBuildScopedUrl(href, BUILD_URL)).toBeUndefined();
    }
  });
});

describe("normalizePendingInputActions", () => {
  test("keeps ids, messages, parameters, and validated links", () => {
    const actions = normalizePendingInputActions(
      [
        {
          id: "Release",
          proceedText: "Ship it",
          message: "Deploy to production?",
          inputs: [],
          proceedUrl:
            "/jenkins/job/deploy/128/wfapi/inputSubmit?inputId=Release",
          abortUrl: "/jenkins/job/deploy/128/input/Release/abort",
          redirectApprovalUrl: "/jenkins/job/deploy/128/input/",
        },
        {
          id: "Pick",
          message: "Choose",
          inputs: [
            {
              type: "StringParameterDefinition",
              name: "TAG",
              description: "tag",
            },
            { type: "BooleanParameterDefinition" },
          ],
          proceedUrl:
            "https://evil.example.com/job/deploy/128/wfapi/inputSubmit?inputId=Pick",
          abortUrl: "/jenkins/job/deploy/128/input/Pick/abort",
        },
      ],
      BUILD_URL,
    );

    expect(actions).toEqual([
      {
        id: "Release",
        message: "Deploy to production?",
        proceedText: "Ship it",
        parameters: [],
        proceedUrl:
          "https://jenkins.example.com/jenkins/job/deploy/128/wfapi/inputSubmit?inputId=Release",
        abortUrl:
          "https://jenkins.example.com/jenkins/job/deploy/128/input/Release/abort",
        approvalUrl:
          "https://jenkins.example.com/jenkins/job/deploy/128/input/",
      },
      {
        id: "Pick",
        message: "Choose",
        proceedText: undefined,
        parameters: [
          {
            name: "TAG",
            type: "StringParameterDefinition",
            description: "tag",
          },
          {
            name: "(unnamed)",
            type: "BooleanParameterDefinition",
            description: undefined,
          },
        ],
        proceedUrl: undefined,
        abortUrl:
          "https://jenkins.example.com/jenkins/job/deploy/128/input/Pick/abort",
        approvalUrl: undefined,
      },
    ]);
  });

  test("treats missing parameter metadata as unknown, never as parameterless", () => {
    const [action] = normalizePendingInputActions(
      [{ id: "Release", message: "Deploy?" }],
      BUILD_URL,
    );
    expect(action?.parameters).toBeNull();
  });

  test("skips entries without a usable id", () => {
    expect(
      normalizePendingInputActions(
        [
          { message: "no id" },
          { id: "   ", message: "blank id" },
          null as unknown as { id: string },
          { id: "Ok", message: "" },
        ],
        BUILD_URL,
      ).map((action) => action.id),
    ).toEqual(["Ok"]);
  });
});

describe("sanitizeInputText", () => {
  test("strips ANSI and control sequences and collapses whitespace", () => {
    expect(
      sanitizeInputText(
        "\u001b[31mDeploy\u001b[0m\r\nto\tprod? \u001b]0;title\u0007 ok",
      ),
    ).toBe("Deploy to prod? ok");
  });

  test("truncates long messages", () => {
    const sanitized = sanitizeInputText("x".repeat(500));
    expect(sanitized.length).toBe(200);
    expect(sanitized.endsWith("…")).toBeTrue();
  });
});
