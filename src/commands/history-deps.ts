import { isCancel, select } from "@clack/prompts";
import { recordBranchSelection } from "../branches";
import { recordRecentJob } from "../recent-jobs";
import { runLogs } from "./logs";
import { resolveJobTarget } from "./ops-helpers";

export const historyDeps = {
  isCancel,
  select,
  recordBranchSelection,
  recordRecentJob,
  runLogs,
  resolveJobTarget,
};
