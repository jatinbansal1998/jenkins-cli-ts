import { confirm, isCancel, select, text } from "@clack/prompts";
import { getJobDisplayName, loadJobs, rankJobs } from "../jobs";
import { runBuild } from "./build";
import { runCancel } from "./cancel";
import { runHistory } from "./history";
import { runLogs } from "./logs";
import { runRerun, runRerunLastBuild } from "./rerun";
import { runStatus } from "./status";
import { runWait } from "./wait";

export const listDeps = {
  confirm,
  isCancel,
  select,
  text,
  getJobDisplayName,
  loadJobs,
  rankJobs,
  runBuild,
  runHistory,
  runStatus,
  runWait,
  runLogs,
  runCancel,
  runRerun,
  runRerunLastBuild,
};
