import { autocomplete, confirm, isCancel, select, text } from "../clack";
import {
  getJobDisplayName,
  loadJobs,
  rankJobs,
  sortJobsByDisplayName,
} from "../jobs";
import { loadPreferredJobs } from "../recent-jobs";
import { runBuild } from "./build";
import { runCancel } from "./cancel";
import { runHistory } from "./history";
import { runLogs } from "./logs";
import { runRerun, runRerunLastBuild } from "./rerun";
import { runStatus } from "./status";
import { runWait } from "./wait";

export const listDeps = {
  autocomplete,
  confirm,
  isCancel,
  select,
  text,
  getJobDisplayName,
  loadJobs,
  loadPreferredJobs,
  rankJobs,
  sortJobsByDisplayName,
  runBuild,
  runHistory,
  runStatus,
  runWait,
  runLogs,
  runCancel,
  runRerun,
  runRerunLastBuild,
};
