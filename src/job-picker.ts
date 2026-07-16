import { autocomplete, autocompleteMultiselect, isCancel } from "./clack";
import type { EnvConfig } from "./env";
import type { PromptAdapter, PromptOption } from "./flows/types";
import { findJobByUrl } from "./job-url";
import { getJobDisplayName, getSuggestedJobs } from "./jobs";
import { loadPreferredJobs } from "./recent-jobs";
import { withPromptTarget } from "./tui-target";
import type { JenkinsJob } from "./types/jenkins";

const PICKER_MESSAGE = "Job name or description";
const PICKER_PLACEHOLDER = "e.g. api prod deploy";

export type JobPickerOptions = {
  env: EnvConfig;
  jobs: JenkinsJob[];
  mode: "single" | "multiple";
  initialQuery?: string;
};

export type JobPickerResult =
  | { kind: "selected"; jobs: JenkinsJob[] }
  | { kind: "cancelled"; userInput: string };

export type JobPickerDeps = {
  autocomplete: PromptAdapter["autocomplete"];
  autocompleteMultiselect: NonNullable<
    PromptAdapter["autocompleteMultiselect"]
  >;
  isCancel: PromptAdapter["isCancel"];
  getSuggestedJobs: typeof getSuggestedJobs;
  loadPreferredJobs: typeof loadPreferredJobs;
};

const defaultJobPickerDeps: JobPickerDeps = {
  autocomplete,
  autocompleteMultiselect,
  isCancel,
  getSuggestedJobs,
  loadPreferredJobs,
};

export function createJobPicker(deps: JobPickerDeps) {
  return async function pickJobs(
    options: JobPickerOptions,
  ): Promise<JobPickerResult> {
    const preferredJobs = await deps.loadPreferredJobs({
      env: options.env,
      jobs: options.jobs,
    });
    let latestQuery = options.initialQuery?.trim() ?? "";

    while (true) {
      const promptOptions = function (this: {
        userInput: string;
      }): PromptOption[] {
        const typedQuery = this.userInput;
        latestQuery = typedQuery || latestQuery;
        const suggestedJobs = typedQuery.trim()
          ? deps.getSuggestedJobs(typedQuery, options.jobs)
          : latestQuery
            ? deps.getSuggestedJobs(latestQuery, options.jobs)
            : preferredJobs;
        return suggestedJobs.map((job) => ({
          value: job.url,
          label: getJobDisplayName(job),
        }));
      };
      const validate = (value: string | string[] | undefined) => {
        const values = Array.isArray(value) ? value : value ? [value] : [];
        if (values.length === 0) {
          return options.mode === "single"
            ? "Select a job to continue."
            : "Select at least one job to continue.";
        }
        return values.every((jobUrl) => findJobByUrl(options.jobs, jobUrl))
          ? undefined
          : "Selected job is no longer available.";
      };
      const common = {
        message: withPromptTarget(PICKER_MESSAGE, options.env),
        placeholder: PICKER_PLACEHOLDER,
        options: promptOptions,
        filter: () => true,
        maxItems: 10,
        validate,
      };

      const response =
        options.mode === "single"
          ? await deps.autocomplete({
              ...common,
              initialUserInput: latestQuery,
            })
          : await deps.autocompleteMultiselect({
              ...common,
              required: true,
            });

      if (deps.isCancel(response)) {
        return { kind: "cancelled", userInput: latestQuery };
      }

      const selectedValues = Array.isArray(response)
        ? response.map(String)
        : [
            typeof response === "object" && response && "value" in response
              ? String(response.value)
              : String(response),
          ];
      const selectedJobs = selectedValues
        .map((jobUrl) => findJobByUrl(options.jobs, jobUrl))
        .filter((job): job is JenkinsJob => Boolean(job));
      if (
        selectedJobs.length === selectedValues.length &&
        selectedJobs.length > 0
      ) {
        return { kind: "selected", jobs: selectedJobs };
      }
    }
  };
}

export const pickJobs = createJobPicker(defaultJobPickerDeps);

export async function pickJob(
  options: Omit<JobPickerOptions, "mode">,
): Promise<
  | { kind: "selected"; job: JenkinsJob }
  | Extract<JobPickerResult, { kind: "cancelled" }>
> {
  const result = await pickJobs({ ...options, mode: "single" });
  if (result.kind === "cancelled") {
    return result;
  }
  const job = result.jobs[0];
  if (!job) {
    throw new Error("Single job picker returned no selection.");
  }
  return { kind: "selected", job };
}
