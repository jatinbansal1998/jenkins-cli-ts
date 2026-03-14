import { confirm, isCancel, select, text } from "../clack";
import { recordBranchSelection } from "../branches";
import { recordRecentJob } from "../recent-jobs";
import { runCancel } from "./cancel";
import { runLogs } from "./logs";
import { resolveJobTarget } from "./ops-helpers";
import { runWait } from "./wait";

export const historyDeps = {
  confirm,
  isCancel,
  select,
  text,
  recordBranchSelection,
  recordRecentJob,
  runCancel,
  runLogs,
  runWait,
  resolveJobTarget,
};
