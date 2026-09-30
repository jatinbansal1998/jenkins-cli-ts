import { CliError } from "./cli";
import type { JenkinsClient } from "./jenkins/client";
import type {
  JenkinsPipelineNodeResponse,
  JenkinsPipelineStage,
} from "./types/jenkins";

export type PipelineLogIdentity = {
  stageId: string;
  stageName: string;
  nodeId: string;
  nodeName: string;
  path: string;
};

export type PipelineLogSource = {
  identity: PipelineLogIdentity;
  status?: string;
  startTimeMillis?: number;
  consoleUrl?: string;
  completeText?: string;
};

export type PipelineLogSelection = {
  stage: PipelineGraphNode;
  selected: PipelineGraphNode;
  sources: PipelineLogSource[];
  failureReason?: string;
};

type PipelineGraphNode = {
  id: string;
  name: string;
  status?: string;
  startTimeMillis?: number;
  parentIds: string[];
  stageId: string;
  stageName: string;
  isStage: boolean;
  selfUrl?: string;
  logUrl?: string;
  errorMessage?: string;
  path: string;
};

// Caps concurrent wfapi node reads so a wide Pipeline does not flood Jenkins.
const NODE_FETCH_LIMIT = 6;

export type PipelineLogSelector = {
  stage?: string;
  stageId?: string;
  failed?: boolean;
};

/**
 * One resolver serves a whole `logs` run. A follow loop calls `resolve` on
 * every poll, so it remembers what cannot change: the detail of a stage that
 * has finished and each node's console URL.
 */
export class PipelineLogResolver {
  private readonly settledStageDetails = new Map<
    string,
    JenkinsPipelineNodeResponse
  >();
  private readonly consoleUrls = new Map<string, string>();

  constructor(
    private readonly client: JenkinsClient,
    private readonly buildUrl: string,
    private readonly selector: PipelineLogSelector,
  ) {}

  async resolve(
    stages: JenkinsPipelineStage[] | undefined,
  ): Promise<PipelineLogSelection> {
    if (!stages?.length) {
      throw pipelineCapabilityError(
        "Pipeline stage metadata is unavailable for this build.",
        this.buildUrl,
      );
    }
    const graph: PipelineGraphNode[] = stages.map(toStageNode);
    const stageNodes = graph.filter((node) => node.isStage);
    const selectedStage = selectStage(stageNodes, this.selector);
    // Only a --stage-id naming a step inside some stage needs every stage.
    await this.addStageDetails(
      graph,
      selectedStage ? [selectedStage] : stageNodes,
    );
    const selected = selectedStage
      ? selectInStage(graph, selectedStage, this.selector)
      : findNode(graph, this.selector.stageId!.trim());
    const stage =
      graph.find((node) => node.isStage && node.id === selected.stageId) ??
      selected;
    const sourceNodes =
      selected.logUrl && !this.selector.failed
        ? [selected]
        : graph.filter(
            (node) =>
              node.stageId === stage.id &&
              Boolean(node.logUrl) &&
              (this.selector.failed ||
                selected.isStage ||
                isDescendantOf(node, selected, graph)),
          );

    if (sourceNodes.length === 0) {
      throw pipelineCapabilityError(
        `Pipeline log metadata is unavailable for ${selected.path}.`,
        this.buildUrl,
      );
    }

    const sources = (
      await mapWithLimit(
        sourceNodes.toSorted(compareNodes),
        NODE_FETCH_LIMIT,
        (node) => this.readSource(node, stage),
      )
    ).filter((source) => source !== null);

    if (sources.length === 0) {
      throw pipelineCapabilityError(
        `Jenkins does not expose a readable log for ${selected.path}.`,
        this.buildUrl,
      );
    }

    const failedNode = graph
      .filter(
        (node) => node.stageId === stage.id && isFailureStatus(node.status),
      )
      .toSorted(compareDepthDescending)[0];

    return {
      stage,
      selected,
      sources,
      failureReason: failedNode?.errorMessage,
    };
  }

  private async addStageDetails(
    graph: PipelineGraphNode[],
    stages: PipelineGraphNode[],
  ): Promise<void> {
    const details = await mapWithLimit(stages, NODE_FETCH_LIMIT, (stage) =>
      this.readStageDetail(stage),
    );
    // Merged in stage order: a node reported under two stages keeps the first.
    stages.forEach((stage, index) => {
      const detail = details[index];
      if (!detail) {
        return;
      }
      mergeStageDetail(stage, detail);
      for (const node of detail.stageFlowNodes ?? []) {
        addNodeRecursively(graph, node, stage.id, stage.name);
      }
    });

    const byId = new Map(graph.map((node) => [node.id, node]));
    for (const node of graph) {
      node.path = buildDisplayPath(node, byId);
    }
  }

  private async readStageDetail(
    stage: PipelineGraphNode,
  ): Promise<JenkinsPipelineNodeResponse | null> {
    const cached = this.settledStageDetails.get(stage.id);
    if (cached) {
      return cached;
    }
    if (!stage.selfUrl) {
      return null;
    }
    const detail = await this.client.getPipelineNodeDescription(stage.selfUrl);
    // A running stage keeps gaining steps, so only a finished one is kept.
    // Its steps are checked too: a cached step still marked running would be
    // re-read on every later poll.
    if (
      detail &&
      isSettledPipelineStatus(stage.status) &&
      allNodesSettled(detail.stageFlowNodes ?? [])
    ) {
      this.settledStageDetails.set(stage.id, detail);
    }
    return detail;
  }

  private async readSource(
    node: PipelineGraphNode,
    stage: PipelineGraphNode,
  ): Promise<PipelineLogSource | null> {
    const source = {
      identity: {
        stageId: stage.id,
        stageName: stage.name,
        nodeId: node.id,
        nodeName: node.name,
        path: node.path,
      },
      status: node.status,
      startTimeMillis: node.startTimeMillis,
    };
    const knownConsoleUrl = this.consoleUrls.get(node.id);
    if (knownConsoleUrl) {
      return { ...source, consoleUrl: knownConsoleUrl };
    }
    const log = await this.client.getPipelineNodeLog(node.logUrl!);
    if (log?.consoleUrl) {
      this.consoleUrls.set(node.id, log.consoleUrl);
      return { ...source, consoleUrl: log.consoleUrl };
    }
    if (typeof log?.text === "string" && !log.hasMore) {
      return { ...source, completeText: log.text };
    }
    return null;
  }
}

/** True once a wfapi node can no longer change its steps or log. */
export function isSettledPipelineStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toUpperCase();
  return (
    normalized === "SUCCESS" ||
    normalized === "UNSTABLE" ||
    normalized === "ABORTED" ||
    isFailureStatus(normalized)
  );
}

function allNodesSettled(nodes: JenkinsPipelineNodeResponse[]): boolean {
  return nodes.every(
    (node) =>
      isSettledPipelineStatus(node.status) &&
      allNodesSettled(node.stageFlowNodes ?? []),
  );
}

function toStageNode(stage: JenkinsPipelineStage): PipelineGraphNode {
  const id = normalizeId(stage.id) || "unknown";
  const name = stage.name?.trim() || `Stage ${id}`;
  return {
    id,
    name,
    status: stage.status,
    startTimeMillis: stage.startTimeMillis,
    parentIds: normalizeParentIds(stage.parentNodes),
    stageId: id,
    stageName: name,
    isStage: true,
    selfUrl: stage._links?.self?.href,
    logUrl: stage._links?.log?.href,
    path: name,
  };
}

function mergeStageDetail(
  stage: PipelineGraphNode,
  detail: JenkinsPipelineNodeResponse,
): void {
  stage.logUrl = detail._links?.log?.href ?? stage.logUrl;
  stage.selfUrl = detail._links?.self?.href ?? stage.selfUrl;
  stage.errorMessage = detail.error?.message;
  stage.parentIds = normalizeParentIds(detail.parentNodes).length
    ? normalizeParentIds(detail.parentNodes)
    : stage.parentIds;
}

function addNodeRecursively(
  graph: PipelineGraphNode[],
  node: JenkinsPipelineNodeResponse,
  stageId: string,
  stageName: string,
): void {
  const id = normalizeId(node.id);
  if (!id) {
    return;
  }
  const existing = graph.find((entry) => entry.id === id);
  if (!existing) {
    graph.push({
      id,
      name: node.name?.trim() || `Node ${id}`,
      status: node.status,
      startTimeMillis: node.startTimeMillis,
      parentIds: normalizeParentIds(node.parentNodes),
      stageId,
      stageName,
      isStage: false,
      selfUrl: node._links?.self?.href,
      logUrl: node._links?.log?.href,
      errorMessage: node.error?.message,
      path: stageName,
    });
  }
  for (const child of node.stageFlowNodes ?? []) {
    addNodeRecursively(graph, child, stageId, stageName);
  }
}

/**
 * Picks the stage a selector names from the wfapi stage list alone. Returns
 * undefined when --stage-id names no stage: it may name a step inside one.
 */
function selectStage(
  stages: PipelineGraphNode[],
  selector: PipelineLogSelector,
): PipelineGraphNode | undefined {
  if (selector.failed) {
    const failedStages = stages.filter((node) => isFailureStatus(node.status));
    if (failedStages.length === 0) {
      throw new CliError(
        "Jenkins did not report a failed Pipeline stage for this build.",
        ["Run the whole-build log to inspect non-Pipeline failures."],
        "FAILED_STAGE_UNAVAILABLE",
      );
    }
    return failedStages.toSorted(compareNodes)[0]!;
  }

  const requestedId = selector.stageId?.trim();
  if (requestedId) {
    return stages.find((node) => node.id === requestedId);
  }

  const requestedName = selector.stage?.trim();
  const matches = stages.filter((node) => node.name === requestedName);
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new CliError(
      `Pipeline stage name "${requestedName}" is ambiguous.`,
      [formatCandidates(matches), "Use --stage-id <id> to select one."],
      "AMBIGUOUS_STAGE_SELECTOR",
    );
  }
  throw new CliError(
    `Pipeline stage "${requestedName}" was not found.`,
    [formatCandidates(stages)],
    "PIPELINE_STAGE_NOT_FOUND",
  );
}

function selectInStage(
  graph: PipelineGraphNode[],
  stage: PipelineGraphNode,
  selector: PipelineLogSelector,
): PipelineGraphNode {
  if (!selector.failed) {
    return stage;
  }
  return (
    graph
      .filter(
        (node) => node.stageId === stage.id && isFailureStatus(node.status),
      )
      .toSorted(compareDepthDescending)[0] ?? stage
  );
}

function findNode(graph: PipelineGraphNode[], id: string): PipelineGraphNode {
  const match = graph.find((node) => node.id === id);
  if (!match) {
    throw new CliError(
      `No Pipeline stage or node has id ${id}.`,
      [formatCandidates(graph.filter((node) => node.isStage))],
      "PIPELINE_STAGE_NOT_FOUND",
    );
  }
  return match;
}

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function buildDisplayPath(
  node: PipelineGraphNode,
  byId: Map<string, PipelineGraphNode>,
): string {
  const parts = [node.name];
  const visited = new Set([node.id]);
  let parent = findNearestParent(node, byId);
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    parts.unshift(parent.name);
    if (parent.isStage) {
      break;
    }
    parent = findNearestParent(parent, byId);
  }
  if (parts[0] !== node.stageName) {
    parts.unshift(node.stageName);
  }
  return parts.join(" / ");
}

function findNearestParent(
  node: PipelineGraphNode,
  byId: Map<string, PipelineGraphNode>,
): PipelineGraphNode | undefined {
  for (const id of node.parentIds) {
    const parent = byId.get(id);
    if (parent && parent.stageId === node.stageId) {
      return parent;
    }
  }
  return byId.get(node.stageId);
}

function isDescendantOf(
  node: PipelineGraphNode,
  ancestor: PipelineGraphNode,
  graph: PipelineGraphNode[],
): boolean {
  const byId = new Map(graph.map((entry) => [entry.id, entry]));
  const pending = [...node.parentIds];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (id === ancestor.id) {
      return true;
    }
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    pending.push(...(byId.get(id)?.parentIds ?? []));
  }
  return ancestor.isStage && node.stageId === ancestor.id;
}

function normalizeId(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).trim();
}

function normalizeParentIds(
  values: Array<string | number> | undefined,
): string[] {
  return (values ?? []).map(String).filter(Boolean);
}

function compareNodes(a: PipelineGraphNode, b: PipelineGraphNode): number {
  return (
    (a.startTimeMillis ?? 0) - (b.startTimeMillis ?? 0) ||
    a.id.localeCompare(b.id, undefined, { numeric: true })
  );
}

function compareDepthDescending(
  a: PipelineGraphNode,
  b: PipelineGraphNode,
): number {
  return b.parentIds.length - a.parentIds.length || compareNodes(a, b);
}

function isFailureStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toUpperCase();
  return normalized === "FAILED" || normalized === "FAILURE";
}

function formatCandidates(nodes: PipelineGraphNode[]): string {
  const candidates = nodes
    .toSorted(compareNodes)
    .map((node) => `${node.path} (id ${node.id})`)
    .join(", ");
  return candidates
    ? `Available Pipeline stages: ${candidates}.`
    : "No Pipeline stages were reported.";
}

function pipelineCapabilityError(message: string, buildUrl: string): CliError {
  return new CliError(
    message,
    [`Run logs --build-url ${buildUrl} without --stage or --failed.`],
    "PIPELINE_STAGE_LOG_UNAVAILABLE",
  );
}
