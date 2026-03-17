import type { FlowDefinition, PromptOption, TerminalState } from "./types";

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

function getStaticOptions<Ctx>(
  options:
    | PromptOption[]
    | ((context: Ctx) => PromptOption[])
    | ((context: Ctx, search: string) => PromptOption[]),
): PromptOption[] | null {
  if (Array.isArray(options)) {
    return options;
  }
  return null;
}

export function validateFlowDefinition<Ctx>(
  definition: FlowDefinition<Ctx>,
): void {
  const states = definition.states;
  const stateIds = new Set(Object.keys(states));

  if (!stateIds.has(definition.initialState)) {
    throw new Error(
      `Flow ${definition.id} has unknown initial state "${definition.initialState}".`,
    );
  }

  for (const [stateId, state] of Object.entries(states)) {
    const transitions = Object.entries(state.transitions);
    if (transitions.length === 0) {
      throw new Error(
        `Flow ${definition.id} state "${stateId}" has no transitions.`,
      );
    }

    if (
      state.prompt?.kind === "select" ||
      state.prompt?.kind === "autocomplete"
    ) {
      const staticOptions = getStaticOptions(state.prompt.options);
      if (staticOptions) {
        const seen = new Set<string>();
        for (const option of staticOptions) {
          if (seen.has(option.value)) {
            throw new Error(
              `Flow ${definition.id} state "${stateId}" has duplicate option value "${option.value}".`,
            );
          }
          seen.add(option.value);
        }
      }
    }

    for (const [event, target] of transitions) {
      if (!event || !event.trim()) {
        throw new Error(
          `Flow ${definition.id} state "${stateId}" has an empty transition key.`,
        );
      }
      if (!isTerminalState(target) && !stateIds.has(target)) {
        throw new Error(
          `Flow ${definition.id} state "${stateId}" transitions to unknown target "${target}" for event "${event}".`,
        );
      }
    }
  }

  const visited = new Set<string>();
  const queue: string[] = [definition.initialState];
  let terminalReachable = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const state = states[current];
    if (!state) {
      continue;
    }
    for (const target of Object.values(state.transitions)) {
      if (isTerminalState(target)) {
        terminalReachable = true;
        continue;
      }
      if (!visited.has(target)) {
        queue.push(target);
      }
    }
  }

  if (!terminalReachable) {
    throw new Error(
      `Flow ${definition.id} has no reachable terminal state from "${definition.initialState}".`,
    );
  }
}
