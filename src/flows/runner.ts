import type {
  AutocompletePromptValue,
  EventId,
  FlowDefinition,
  FlowHandlerRegistry,
  FlowPromptValue,
  FlowRunResult,
  PromptAdapter,
  PromptOption,
  PromptSpec,
  StateId,
  TerminalState,
} from "./types";
import { validateFlowDefinition } from "./validate";

const VALIDATED_FLOWS = new Set<string>();
const ESC_SENTINEL = Symbol("flow_esc");

export function resetValidatedFlowsForTesting(): void {
  VALIDATED_FLOWS.clear();
}

const TERMINAL_STATES = new Set<TerminalState>([
  "exit_command",
  "return_to_caller",
  "return_to_caller_root",
  "repeat",
  "root",
  "complete",
]);

function isTerminalState(value: string): value is TerminalState {
  return TERMINAL_STATES.has(value as TerminalState);
}

function resolveValue<Ctx, T>(
  value: T | ((context: Ctx) => T),
  context: Ctx,
): T {
  if (typeof value === "function") {
    return (value as (context: Ctx) => T)(context);
  }
  return value;
}

function isAutocompletePromptValue(
  value: unknown,
): value is AutocompletePromptValue {
  return Boolean(
    value &&
    typeof value === "object" &&
    "value" in value &&
    "userInput" in value &&
    typeof (value as AutocompletePromptValue).value === "string" &&
    typeof (value as AutocompletePromptValue).userInput === "string",
  );
}

async function resolvePromptValue<Ctx>(
  prompt: PromptSpec<Ctx>,
  context: Ctx,
  prompts: PromptAdapter,
): Promise<FlowPromptValue | typeof ESC_SENTINEL> {
  if (prompt.kind === "select") {
    const response = await prompts.select({
      message: resolveValue(prompt.message, context),
      options: resolveValue(prompt.options, context),
    });
    if (prompts.isCancel(response)) {
      return ESC_SENTINEL;
    }
    return String(response);
  }

  if (prompt.kind === "confirm") {
    const response = await prompts.confirm({
      message: resolveValue(prompt.message, context),
      ...(typeof prompt.initialValue !== "undefined"
        ? { initialValue: resolveValue(prompt.initialValue, context) }
        : {}),
    });
    if (prompts.isCancel(response)) {
      return ESC_SENTINEL;
    }
    return Boolean(response);
  }

  if (prompt.kind === "autocomplete") {
    let latestSearch = resolveValue(prompt.initialUserInput ?? "", context);
    const response = await prompts.autocomplete({
      message: resolveValue(prompt.message, context),
      options: Array.isArray(prompt.options)
        ? function (this: { userInput: string }): PromptOption[] {
            latestSearch = this.userInput;
            return prompt.options as PromptOption[];
          }
        : function (this: { userInput: string }): PromptOption[] {
            latestSearch = this.userInput;
            return (
              prompt.options as (context: Ctx, search: string) => PromptOption[]
            )(context, latestSearch);
          },
      ...(!Array.isArray(prompt.options)
        ? {
            // Dynamic option resolvers already apply fuzzy ranking, so disable
            // Clack's default substring filter to avoid double-filtering.
            filter: () => true,
          }
        : {}),
      ...(typeof prompt.maxItems !== "undefined"
        ? { maxItems: resolveValue(prompt.maxItems, context) }
        : {}),
      ...(typeof prompt.placeholder !== "undefined"
        ? { placeholder: resolveValue(prompt.placeholder, context) }
        : {}),
      ...(typeof prompt.initialValue !== "undefined"
        ? { initialValue: resolveValue(prompt.initialValue, context) }
        : {}),
      ...(typeof prompt.initialUserInput !== "undefined"
        ? { initialUserInput: resolveValue(prompt.initialUserInput, context) }
        : {}),
      ...(typeof prompt.validate !== "undefined"
        ? {
            validate: (value: string | string[] | undefined) =>
              prompt.validate?.(value, context),
          }
        : {}),
    });
    if (prompts.isCancel(response)) {
      return ESC_SENTINEL;
    }
    if (isAutocompletePromptValue(response)) {
      return response;
    }
    return {
      value: String(response),
      userInput: latestSearch,
    } satisfies AutocompletePromptValue;
  }

  const response = await prompts.text({
    message: resolveValue(prompt.message, context),
    ...(typeof prompt.placeholder !== "undefined"
      ? { placeholder: resolveValue(prompt.placeholder, context) }
      : {}),
    ...(typeof prompt.initialValue !== "undefined"
      ? { defaultValue: resolveValue(prompt.initialValue, context) }
      : {}),
  });
  if (prompts.isCancel(response)) {
    return ESC_SENTINEL;
  }
  return String(response);
}

function resolveTransitionTarget<Ctx>(
  definition: FlowDefinition<Ctx>,
  stateId: StateId,
  event: EventId,
): StateId | TerminalState {
  const state = definition.states[stateId];
  if (!state) {
    throw new Error(
      `Flow ${definition.id} attempted to resolve transition for unknown state "${stateId}".`,
    );
  }
  const exactTarget = state.transitions[event];
  if (exactTarget) {
    return exactTarget;
  }
  const wildcardTarget = state.transitions["*"];
  if (wildcardTarget) {
    return wildcardTarget;
  }
  throw new Error(
    `Flow ${definition.id} state "${stateId}" has no transition for event "${event}".`,
  );
}

async function resolveEventFromPrompt<Ctx>(
  definition: FlowDefinition<Ctx>,
  handlers: FlowHandlerRegistry<Ctx>,
  stateId: StateId,
  context: Ctx,
  input: FlowPromptValue,
): Promise<EventId> {
  const state = definition.states[stateId];
  if (!state) {
    throw new Error(
      `Flow ${definition.id} attempted to resolve prompt event for unknown state "${stateId}".`,
    );
  }
  if (state.onSelect) {
    const handler = handlers[state.onSelect];
    if (!handler) {
      throw new Error(
        `Flow ${definition.id} missing onSelect handler "${state.onSelect}" in state "${stateId}".`,
      );
    }
    return await handler({ context, input });
  }

  const prompt = state.prompt;
  if (!prompt) {
    throw new Error(
      `Flow ${definition.id} state "${stateId}" has no prompt for prompt event resolution.`,
    );
  }
  if (prompt.kind === "confirm") {
    return input ? "confirm:yes" : "confirm:no";
  }
  if (prompt.kind === "select") {
    return `select:${String(input)}`;
  }
  if (prompt.kind === "autocomplete") {
    if (isAutocompletePromptValue(input)) {
      return `select:${input.value}`;
    }
    throw new Error(
      `Flow ${definition.id} state "${stateId}" expected resolvePromptValue to return an AutocompletePromptValue for autocomplete prompt resolution.`,
    );
  }
  return "text:submit";
}

export async function runFlow<Ctx>(options: {
  definition: FlowDefinition<Ctx>;
  handlers: FlowHandlerRegistry<Ctx>;
  prompts: PromptAdapter;
  context: Ctx;
  startStateId?: StateId;
}): Promise<FlowRunResult<Ctx>> {
  if (!VALIDATED_FLOWS.has(options.definition.id)) {
    validateFlowDefinition(options.definition);
    VALIDATED_FLOWS.add(options.definition.id);
  }

  let stateId = options.startStateId ?? options.definition.initialState;

  while (true) {
    const state = options.definition.states[stateId];
    if (!state) {
      throw new Error(
        `Flow ${options.definition.id} entered unknown state "${stateId}".`,
      );
    }

    if (state.onEnter) {
      const handler = options.handlers[state.onEnter];
      if (!handler) {
        throw new Error(
          `Flow ${options.definition.id} missing onEnter handler "${state.onEnter}" in state "${stateId}".`,
        );
      }
      const event = await handler({ context: options.context });
      const target = resolveTransitionTarget(
        options.definition,
        stateId,
        event,
      );
      if (isTerminalState(target)) {
        return { terminal: target, stateId, context: options.context };
      }
      stateId = target;
      continue;
    }

    if (!state.prompt) {
      throw new Error(
        `Flow ${options.definition.id} state "${stateId}" has neither prompt nor onEnter handler.`,
      );
    }

    const input = await resolvePromptValue(
      state.prompt,
      options.context,
      options.prompts,
    );
    const event =
      input === ESC_SENTINEL
        ? "esc"
        : await resolveEventFromPrompt(
            options.definition,
            options.handlers,
            stateId,
            options.context,
            input,
          );
    const target = resolveTransitionTarget(options.definition, stateId, event);
    if (isTerminalState(target)) {
      return { terminal: target, stateId, context: options.context };
    }
    stateId = target;
  }
}
