import { describe, expect, test } from "bun:test";
import {
  normalizeJobParameterDefinitions,
  parseBooleanParameter,
  validateBuildParameters,
} from "../src/job-parameters";

describe("job parameter normalization", () => {
  test("normalizes supported Jenkins parameter definitions", () => {
    expect(
      normalizeJobParameterDefinitions({
        property: [
          {
            parameterDefinitions: [
              {
                _class: "hudson.model.StringParameterDefinition",
                name: "TAG",
                description: "Image tag",
                defaultParameterValue: { value: "latest" },
              },
              {
                _class: "hudson.model.TextParameterDefinition",
                name: "NOTES",
                defaultValue: "hello\nworld",
              },
              {
                type: "BooleanParameterDefinition",
                name: "DRY_RUN",
                defaultParameterValue: { value: true },
              },
              {
                _class: "hudson.model.ChoiceParameterDefinition",
                name: "ENV",
                choices: ["dev", "staging", "prod"],
                defaultParameterValue: { value: "staging" },
              },
              {
                _class: "hudson.model.PasswordParameterDefinition",
                name: "TOKEN",
                defaultParameterValue: { value: "must-not-escape" },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        name: "TAG",
        type: "string",
        description: "Image tag",
        defaultValue: "latest",
        sensitive: false,
        jenkinsClass: "hudson.model.StringParameterDefinition",
      },
      {
        name: "NOTES",
        type: "text",
        defaultValue: "hello\nworld",
        sensitive: false,
        jenkinsClass: "hudson.model.TextParameterDefinition",
      },
      {
        name: "DRY_RUN",
        type: "boolean",
        defaultValue: true,
        sensitive: false,
        jenkinsClass: "BooleanParameterDefinition",
      },
      {
        name: "ENV",
        type: "choice",
        defaultValue: "staging",
        choices: ["dev", "staging", "prod"],
        sensitive: false,
        jenkinsClass: "hudson.model.ChoiceParameterDefinition",
      },
      {
        name: "TOKEN",
        type: "password",
        sensitive: true,
        jenkinsClass: "hudson.model.PasswordParameterDefinition",
      },
    ]);
  });

  test("handles missing metadata, missing optional fields, and unknown types", () => {
    expect(normalizeJobParameterDefinitions({})).toEqual([]);
    expect(normalizeJobParameterDefinitions({ property: [{}] })).toEqual([]);
    expect(
      normalizeJobParameterDefinitions({
        property: [
          {
            parameterDefinitions: [
              { _class: "com.example.FileParameterDefinition", name: "FILE" },
              { _class: "ignored", description: "missing name" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        name: "FILE",
        type: "unknown",
        sensitive: false,
        jenkinsClass: "com.example.FileParameterDefinition",
      },
    ]);
  });
});

describe("job parameter validation", () => {
  const definitions = normalizeJobParameterDefinitions({
    property: [
      {
        parameterDefinitions: [
          {
            _class: "hudson.model.ChoiceParameterDefinition",
            name: "ENV",
            choices: ["dev", "prod"],
          },
          { _class: "hudson.model.BooleanParameterDefinition", name: "FORCE" },
          { _class: "hudson.model.PasswordParameterDefinition", name: "TOKEN" },
        ],
      },
    ],
  });

  test("normalizes recognized booleans and keeps unknown names", () => {
    expect(parseBooleanParameter("YES")).toBe(true);
    expect(parseBooleanParameter("0")).toBe(false);
    expect(
      validateBuildParameters(definitions, {
        ENV: "prod",
        FORCE: "on",
        EXTRA: "value",
        API_TOKEN: "secret",
      }),
    ).toEqual({
      params: {
        ENV: "prod",
        FORCE: "true",
        EXTRA: "value",
        API_TOKEN: "secret",
      },
      unknownNames: ["EXTRA", "API_TOKEN"],
      sensitiveNames: new Set(["TOKEN", "API_TOKEN"]),
    });
  });

  test("rejects invalid choice and boolean values without echoing values", () => {
    expect(() =>
      validateBuildParameters(definitions, { ENV: "root-secret" }),
    ).toThrow('Invalid value for choice parameter "ENV".');
    try {
      validateBuildParameters(definitions, { FORCE: "private-value" });
    } catch (error) {
      expect(String(error)).not.toContain("private-value");
    }
  });
});
