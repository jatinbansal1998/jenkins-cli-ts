/**
 * Nodes command implementation.
 * Shows Jenkins agents/computers with online/offline status, per-node
 * executor usage, and labels. Read-only.
 */
import { printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { formatTable, truncateCell } from "../table";
import type { NodeSummary, NodesSummary } from "../types/jenkins";

const LABELS_COLUMN_WIDTH = 40;
const STATUS_COLUMN_WIDTH = 40;

type NodesOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  offlineOnly: boolean;
  nonInteractive: boolean;
};

export async function runNodes(options: NodesOptions): Promise<void> {
  const summary = await options.client.listNodes();
  const nodes = options.offlineOnly
    ? summary.nodes.filter((node) => node.offline || node.temporarilyOffline)
    : summary.nodes;

  if (nodes.length === 0) {
    printOk(options.offlineOnly ? "no offline nodes" : "no nodes found");
    return;
  }

  console.log(formatNodesTable(nodes));
  printOk(formatNodesSummary(summary));
}

function formatNodesTable(nodes: NodeSummary[]): string {
  const rows = [
    ["Name", "Status", "Executors", "Labels"],
    ...nodes.map((node) => [
      truncateCell(node.displayName, 28),
      truncateCell(resolveNodeStatus(node), STATUS_COLUMN_WIDTH),
      `${node.busyExecutors}/${node.totalExecutors}`,
      truncateCell(node.labels.join(", ") || "-", LABELS_COLUMN_WIDTH),
    ]),
  ];
  return formatTable(rows);
}

export function resolveNodeStatus(node: NodeSummary): string {
  if (node.temporarilyOffline) {
    return node.offlineCauseReason
      ? `temp-offline (${node.offlineCauseReason})`
      : "temp-offline";
  }
  if (node.offline) {
    return node.offlineCauseReason
      ? `offline (${node.offlineCauseReason})`
      : "offline";
  }
  return "online";
}

function formatNodesSummary(summary: NodesSummary): string {
  const nodeNoun = summary.totalNodes === 1 ? "node" : "nodes";
  return `${summary.totalNodes} ${nodeNoun}, ${summary.offlineNodes} offline, ${summary.busyExecutors}/${summary.totalExecutors} executors busy.`;
}
