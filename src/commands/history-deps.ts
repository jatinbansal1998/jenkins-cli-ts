import { autocomplete, confirm, isCancel, select, text } from "../clack";
import { recordBranchSelection } from "../branches";
import { recordRecentJob } from "../recent-jobs";
import { runCancel } from "./cancel";
import { runLogs } from "./logs";
import { resolveJobTarget } from "./ops-helpers";
import { runWait } from "./wait";
import type { PromptAdapter } from "../flows/types";

type HistoryDeps = {
  autocomplete: PromptAdapter["autocomplete"];
  confirm: PromptAdapter["confirm"];
  isCancel: PromptAdapter["isCancel"];
  select: PromptAdapter["select"];
  text: PromptAdapter["text"];
  recordBranchSelection: typeof recordBranchSelection;
  recordRecentJob: typeof recordRecentJob;
  runCancel: typeof runCancel;
  runLogs: typeof runLogs;
  runWait: typeof runWait;
  resolveJobTarget: typeof resolveJobTarget;
};

export const historyDeps: HistoryDeps = {
  autocomplete,
  confirm,
  isCancel,
  select,
  text,
  recordRecentJob,
  recordBranchSelection,
  runCancel,
  runLogs,
  runWait,
  resolveJobTarget,
};
