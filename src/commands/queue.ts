/**
 * Queue command implementation.
 * Shows the Jenkins build queue with humanized wait times and item state,
 * and (interactively) lets you cancel or open a queued item.
 */
import { isCancel, select } from "../clack";
import { printOk } from "../cli";
import type { EnvConfig } from "../env";
import type { JenkinsClient } from "../jenkins/api-wrapper";
import { formatTable, truncateCell } from "../table";
import { withPromptTarget } from "../tui-target";
import type { QueueItemSummary } from "../types/jenkins";
import { runCancel } from "./cancel-core";

const BACK_VALUE = "__jenkins_cli_queue_back__";
const CANCEL_VALUE = "__jenkins_cli_queue_cancel__";
const URL_VALUE = "__jenkins_cli_queue_url__";
const WHY_COLUMN_WIDTH = 48;

type QueueOptions = {
  client: JenkinsClient;
  env: EnvConfig;
  job?: string;
  nonInteractive: boolean;
};

export async function runQueue(options: QueueOptions): Promise<void> {
  const jobFilter = options.job?.trim() ?? "";

  if (options.nonInteractive) {
    const items = await loadQueueItems(options.client, jobFilter);
    renderQueue(items, jobFilter);
    return;
  }

  while (true) {
    const items = await loadQueueItems(options.client, jobFilter);
    renderQueue(items, jobFilter);
    if (items.length === 0) {
      return;
    }

    const selection = await select({
      message: withPromptTarget("Select a queued item", options.env),
      options: [
        ...items.map((item) => ({
          value: String(item.id),
          label: formatQueueOptionLabel(item),
        })),
        { value: BACK_VALUE, label: "Back" },
      ],
    });
    if (isCancel(selection) || selection === BACK_VALUE) {
      return;
    }

    const selected = items.find((item) => String(item.id) === selection);
    if (!selected) {
      continue;
    }

    await runQueueItemAction({
      client: options.client,
      env: options.env,
      item: selected,
    });
  }
}

async function runQueueItemAction(options: {
  client: JenkinsClient;
  env: EnvConfig;
  item: QueueItemSummary;
}): Promise<void> {
  const { item } = options;
  printQueueItemDetails(item);

  const action = await select({
    message: withPromptTarget(
      `Queue item #${item.id} (${item.jobName ?? "unknown job"})`,
      options.env,
    ),
    options: [
      { value: CANCEL_VALUE, label: "Cancel" },
      { value: URL_VALUE, label: "Open URL" },
      { value: BACK_VALUE, label: "Back" },
    ],
  });
  if (isCancel(action) || action === BACK_VALUE) {
    return;
  }
  if (action === URL_VALUE) {
    printOk(`Queue item URL: ${item.queueUrl}`);
    return;
  }
  if (action === CANCEL_VALUE) {
    await runCancel({
      client: options.client,
      env: options.env,
      queueUrl: item.queueUrl,
      nonInteractive: false,
    });
  }
}

async function loadQueueItems(
  client: JenkinsClient,
  jobFilter: string,
): Promise<QueueItemSummary[]> {
  const items = await client.listQueueItems();
  if (!jobFilter) {
    return items;
  }
  const needle = jobFilter.toLowerCase();
  return items.filter((item) =>
    (item.jobName ?? "").toLowerCase().includes(needle),
  );
}

function renderQueue(items: QueueItemSummary[], jobFilter: string): void {
  if (items.length === 0) {
    if (jobFilter) {
      printOk(`No queued items match "${jobFilter}".`);
      return;
    }
    printOk("queue is empty");
    return;
  }

  console.log(formatQueueTable(items));

  if (items.length === 1) {
    const only = items[0];
    if (only?.reason) {
      console.log("");
      console.log(`Why: ${only.reason}`);
    }
  }

  const suffix = jobFilter ? ` matching "${jobFilter}"` : "";
  const noun = items.length === 1 ? "item" : "items";
  printOk(`${items.length} queued ${noun}${suffix}.`);
}

function formatQueueTable(items: QueueItemSummary[]): string {
  const now = Date.now();
  const rows = [
    ["ID", "Job", "Queued", "State", "Why"],
    ...items.map((item) => [
      String(item.id),
      truncateCell(item.jobName ?? "-", 30),
      formatQueuedFor(item.inQueueSince, now),
      resolveQueueState(item),
      truncateCell(item.reason ?? "-", WHY_COLUMN_WIDTH),
    ]),
  ];
  return formatTable(rows);
}

function formatQueueOptionLabel(item: QueueItemSummary): string {
  const state = resolveQueueState(item);
  return `#${item.id} ${item.jobName ?? "unknown"} [${state}]`;
}

function printQueueItemDetails(item: QueueItemSummary): void {
  const now = Date.now();
  printOk(
    `Queue item #${item.id} for ${
      item.jobName ?? "unknown job"
    } (${resolveQueueState(item)}), queued ${formatQueuedFor(
      item.inQueueSince,
      now,
    )}.`,
  );
  if (item.reason) {
    console.log(`Why: ${item.reason}`);
  }
}

export function resolveQueueState(item: QueueItemSummary): string {
  if (item.stuck) {
    return "stuck";
  }
  if (item.blocked) {
    return "blocked";
  }
  if (item.buildable) {
    return "buildable";
  }
  return "waiting";
}

export function formatQueuedFor(
  inQueueSince: number | undefined,
  now: number,
): string {
  if (typeof inQueueSince !== "number" || inQueueSince <= 0) {
    return "-";
  }
  const elapsedMs = Math.max(0, now - inQueueSince);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}
