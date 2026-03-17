import type { JenkinsJob } from "../types/jenkins";
import type { EnvConfig } from "../env";

/** All supported interactive flow definitions in the CLI. */
export type FlowId =
  | "listInteractive"
  | "buildPre"
  | "buildPost"
  | "statusPost";

/** Unique identifier for a state within a flow definition. */
export type StateId = string;

/** Event key used to resolve state transitions. */
export type EventId = string;

/** Terminal outcomes that stop flow execution. */
export type TerminalState =
  | "exit_command"
  | "return_to_caller"
  | "return_to_caller_root"
  | "repeat"
  | "root"
  | "complete";

export type AutocompletePromptValue = {
  value: string;
  userInput: string;
};

/** Primitive prompt values returned by the prompt adapter. */
export type FlowPromptValue = string | boolean | AutocompletePromptValue;

/** Autocomplete can also surface the prompt library's cancel token. */
export type AutocompletePromptResult = FlowPromptValue | symbol;

/** Select-option shape used by `select` prompts. */
export type PromptOption = {
  value: string;
  label: string;
};

type PromptFilterOption = {
  value: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

type PromptAutocompleteOptions<Ctx> =
  | PromptOption[]
  | ((context: Ctx, search: string) => PromptOption[]);

/** Declarative prompt spec for a flow state. */
export type PromptSpec<Ctx> =
  | {
      /** Option picker prompt. */
      kind: "select";
      message: string | ((context: Ctx) => string);
      options: PromptOption[] | ((context: Ctx) => PromptOption[]);
    }
  | {
      /** Yes/no confirmation prompt. */
      kind: "confirm";
      message: string | ((context: Ctx) => string);
      initialValue?: boolean | ((context: Ctx) => boolean);
    }
  | {
      /** Free-form text input prompt. */
      kind: "text";
      message: string | ((context: Ctx) => string);
      placeholder?: string | ((context: Ctx) => string);
      initialValue?: string | ((context: Ctx) => string);
    }
  | {
      /** Searchable type-ahead selector. */
      kind: "autocomplete";
      message: string | ((context: Ctx) => string);
      options: PromptAutocompleteOptions<Ctx>;
      maxItems?: number | ((context: Ctx) => number);
      placeholder?: string | ((context: Ctx) => string);
      initialValue?: string | ((context: Ctx) => string);
      initialUserInput?: string | ((context: Ctx) => string);
      validate?:
        | ((
            value: string | string[] | undefined,
            context: Ctx,
          ) => string | Error | undefined)
        | undefined;
    };

/** Single state in a flow state machine. */
export type StateDefinition<Ctx> = {
  /** Marks state as a root/return point for escape-driven navigation. */
  root?: boolean;
  /** Prompt shown in this state (if state is prompt-driven). */
  prompt?: PromptSpec<Ctx>;
  /** Handler called automatically when entering the state. */
  onEnter?: string;
  /** Handler called after prompt value is captured. */
  onSelect?: string;
  /** Event -> next state/terminal transition map. */
  transitions: Record<string, StateId | TerminalState>;
};

/** Full declarative state machine for a command flow. */
export type FlowDefinition<Ctx> = {
  id: FlowId;
  initialState: StateId;
  states: Record<StateId, StateDefinition<Ctx>>;
};

/** Handler contract used by flow runner for `onEnter` and `onSelect`. */
export type FlowHandler<Ctx> = (options: {
  context: Ctx;
  input?: FlowPromptValue;
}) => Promise<EventId> | EventId;

/** Registry that maps handler ids to implementations. */
export type FlowHandlerRegistry<Ctx> = Record<string, FlowHandler<Ctx>>;

/** Prompt runtime adapter (implemented with `@clack/prompts`). */
export type PromptAdapter = {
  select: (options: {
    message: string;
    options: PromptOption[];
  }) => Promise<unknown>;
  autocomplete: (options: {
    message: string;
    options: PromptOption[] | ((this: { userInput: string }) => PromptOption[]);
    filter?: (search: string, option: PromptFilterOption) => boolean;
    maxItems?: number;
    placeholder?: string;
    initialValue?: string;
    initialUserInput?: string;
    validate?: (
      value: string | string[] | undefined,
    ) => string | Error | undefined;
  }) => Promise<AutocompletePromptResult>;
  confirm: (options: {
    message: string;
    initialValue?: boolean;
  }) => Promise<unknown>;
  text: (options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
  }) => Promise<unknown>;
  /** Returns true for Escape/Ctrl+C cancel payloads from the prompt library. */
  isCancel: (value: unknown) => boolean;
};

/** Final output from `runFlow(...)`. */
export type FlowRunResult<Ctx> = {
  terminal: TerminalState;
  stateId: StateId;
  context: Ctx;
};

/** Standardized outcomes for command action handlers used in menus. */
export type ActionEffectResult =
  | "action_ok"
  | "watch_cancelled"
  | "action_error"
  | "root"
  | "exit";

/** Runtime context for `listInteractive` flow. */
export type ListInteractiveContext = {
  env: EnvConfig;
  jobs: JenkinsJob[];
  searchQuery: string;
  selectedJob?: JenkinsJob;
  selectedAction?: string;
  performAction: (
    action: string,
    selectedJob: JenkinsJob,
  ) => Promise<ActionEffectResult>;
};

/** Runtime context for `buildPost` flow. */
export type BuildPostContext = {
  env: EnvConfig;
  jobLabel: string;
  returnToCaller: boolean;
  selectedAction?: string;
  performAction: (action: string) => Promise<ActionEffectResult>;
};

/** Runtime context for `buildPre` flow (job/branch selection). */
export type BuildPreContext = {
  env: EnvConfig;
  jobs: JenkinsJob[];
  recentJobs: { url: string; label: string }[];
  jobSelectionLocked: boolean;
  searchQuery: string;
  selectedJobUrl?: string;
  selectedJobLabel?: string;
  branchParam: string;
  branch?: string;
  customParams: Record<string, string>;
  defaultBranch: boolean;
  parameterMode?: "branch" | "custom" | "without";
  buildModePrompted?: boolean;
  branchChoices: string[];
  removableBranches: string[];
  pendingBranchRemoval?: string;
  pendingCustomParamKey?: string;
  lastAddedCustomParamKey?: string;
};

/** Runtime context for `statusPost` flow. */
export type StatusPostContext = {
  env: EnvConfig;
  targetLabel: string;
  selectedAction?: string;
  performAction: (action: string) => Promise<ActionEffectResult>;
};
