import { confirm, isCancel, select } from "../clack";
import type { PromptAdapter } from "../flows/types";
import { resolveJobTarget } from "./ops-helpers";

type InputDeps = {
  confirm: PromptAdapter["confirm"];
  isCancel: PromptAdapter["isCancel"];
  select: PromptAdapter["select"];
  resolveJobTarget: typeof resolveJobTarget;
};

export const inputDeps: InputDeps = {
  confirm,
  isCancel,
  select,
  resolveJobTarget,
};
