import { describe, expect, mock, test } from "bun:test";
import type { EnvConfig } from "../src/env";
import type { PromptAdapter } from "../src/flows/types";
import { createJobPicker, type JobPickerDeps } from "../src/job-picker";
import type { JenkinsJob } from "../src/types/jenkins";

const CANCEL = Symbol("cancel");
const env = {
  jenkinsUrl: "https://jenkins.example.com",
  profileName: "work",
} as EnvConfig;
const jobs: JenkinsJob[] = [
  {
    name: "api-deploy",
    fullName: "prod/api-deploy",
    url: "https://jenkins.example.com/job/api-deploy",
  },
  {
    name: "worker",
    url: "https://jenkins.example.com/job/worker",
  },
];
const apiJob = jobs[0] as JenkinsJob;
const workerJob = jobs[1] as JenkinsJob;

function createDeps(overrides: Partial<JobPickerDeps> = {}): JobPickerDeps {
  return {
    autocomplete: mock(
      async () => jobs[0]?.url ?? "",
    ) as JobPickerDeps["autocomplete"],
    autocompleteMultiselect: mock(async () =>
      jobs.map((job) => job.url),
    ) as JobPickerDeps["autocompleteMultiselect"],
    isCancel: ((value: unknown) =>
      value === CANCEL) as PromptAdapter["isCancel"],
    getSuggestedJobs: (_query, availableJobs) =>
      availableJobs.slice().reverse(),
    loadPreferredJobs: async () => jobs.slice().reverse(),
    ...overrides,
  };
}

describe("shared job picker", () => {
  test("uses preferred ordering for blank input and fuzzy ordering while typing", async () => {
    const seenOptions: string[][] = [];
    const autocompleteMock = mock(
      async (options: Parameters<JobPickerDeps["autocomplete"]>[0]) => {
        const dynamicOptions = options.options as (this: {
          userInput: string;
        }) => { value: string }[];
        seenOptions.push(
          dynamicOptions.call({ userInput: "" }).map((entry) => entry.value),
        );
        seenOptions.push(
          dynamicOptions.call({ userInput: "api" }).map((entry) => entry.value),
        );
        expect(
          options.filter?.("unrelated", { value: jobs[0]?.url ?? "" }),
        ).toBe(true);
        return jobs[0]?.url ?? "";
      },
    ) as JobPickerDeps["autocomplete"];

    await createJobPicker(createDeps({ autocomplete: autocompleteMock }))({
      env,
      jobs,
      mode: "single",
    });

    expect(seenOptions).toEqual([
      [workerJob.url, apiJob.url],
      [workerJob.url, apiJob.url],
    ]);
  });

  test("returns one validated job in single mode", async () => {
    const result = await createJobPicker(createDeps())({
      env,
      jobs,
      mode: "single",
    });
    expect(result).toEqual({ kind: "selected", jobs: [apiJob] });
  });

  test("returns multiple jobs in picker order", async () => {
    const deps = createDeps({
      autocompleteMultiselect: mock(async () => [
        jobs[1]?.url ?? "",
        jobs[0]?.url ?? "",
      ]) as JobPickerDeps["autocompleteMultiselect"],
    });
    const result = await createJobPicker(deps)({
      env,
      jobs,
      mode: "multiple",
    });
    expect(result).toEqual({ kind: "selected", jobs: [workerJob, apiJob] });
  });

  test("requires a selection and validates stale values", async () => {
    let callCount = 0;
    const autocompleteMock = mock(
      async (options: Parameters<JobPickerDeps["autocomplete"]>[0]) => {
        callCount += 1;
        expect(options.validate?.(undefined)).toBe("Select a job to continue.");
        expect(
          options.validate?.("https://jenkins.example.com/job/stale"),
        ).toBe("Selected job is no longer available.");
        return callCount === 1
          ? "https://jenkins.example.com/job/stale"
          : (jobs[0]?.url ?? "");
      },
    ) as JobPickerDeps["autocomplete"];

    const result = await createJobPicker(
      createDeps({ autocomplete: autocompleteMock }),
    )({ env, jobs, mode: "single" });

    expect(autocompleteMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ kind: "selected", jobs: [apiJob] });
  });

  test("preserves typed input when cancelled", async () => {
    const autocompleteMock = mock(
      async (options: Parameters<JobPickerDeps["autocomplete"]>[0]) => {
        const dynamicOptions = options.options as (this: {
          userInput: string;
        }) => unknown;
        dynamicOptions.call({ userInput: "prod api" });
        expect(options.message).toBe("Job name or description");
        expect(options.placeholder).toBe("e.g. api prod deploy");
        return CANCEL;
      },
    ) as JobPickerDeps["autocomplete"];

    const result = await createJobPicker(
      createDeps({ autocomplete: autocompleteMock }),
    )({ env, jobs, mode: "single" });

    expect(result).toEqual({ kind: "cancelled", userInput: "prod api" });
  });
});
