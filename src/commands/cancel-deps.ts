import { confirm, isCancel, multiselect, select } from "../clack";
import { resolveJobTarget } from "./ops-helpers";
import { waitForBuild } from "./wait";

export const cancelDeps = {
  confirm,
  isCancel,
  multiselect,
  select,
  resolveJobTarget,
  waitForBuild,
};
