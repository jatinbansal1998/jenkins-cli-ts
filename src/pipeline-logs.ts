import { CliError } from "./cli";
import type { JenkinsClient } from "./jenkins/api-wrapper";
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

export async function resolvePipelineLogSelection(options: {
  client: JenkinsClient;
  buildUrl: string;
  stage?: string;
  stageId?: string;
  failed?: boolean;
}): Promise<PipelineLogSelection> {
  const graph = await discoverPipelineGraph(options.client, options.buildUrl);
  const selected = selectGraphNode(graph, options);
  const stage =
    graph.find((node) => node.isStage && node.id === selected.stageId) ??
    selected;
  const sourceNodes =
    selected.logUrl && !options.failed
      ? [selected]
      : graph.filter(
          (node) =>
            node.stageId === stage.id &&
            Boolean(node.logUrl) &&
            (options.failed ||
              selected.isStage ||
              isDescendantOf(node, selected, graph)),
        );

  if (sourceNodes.length === 0) {
    throw pipelineCapabilityError(
      `Pipeline log metadata is unavailable for ${selected.path}.`,
      options.buildUrl,
    );
  }

  const sources: PipelineLogSource[] = [];
  for (const node of sourceNodes.sort(compareNodes)) {
    const log = await options.client.getPipelineNodeLog(node.logUrl!);
    if (!log) {
      continue;
    }
    const identity: PipelineLogIdentity = {
      stageId: stage.id,
      stageName: stage.name,
      nodeId: node.id,
      nodeName: node.name,
      path: node.path,
    };
    if (log.consoleUrl) {
      sources.push({
        identity,
        status: node.status,
        startTimeMillis: node.startTimeMillis,
        consoleUrl: log.consoleUrl,
      });
      continue;
    }
    if (typeof log.text === "string" && !log.hasMore) {
      sources.push({
        identity,
        status: node.status,
        startTimeMillis: node.startTimeMillis,
        completeText: log.text,
      });
    }
  }

  if (sources.length === 0) {
    throw pipelineCapabilityError(
      `Jenkins does not expose a readable log for ${selected.path}.`,
      options.buildUrl,
    );
  }

  const failedNode = graph
    .filter((node) => node.stageId === stage.id && isFailureStatus(node.status))
    .sort(compareDepthDescending)[0];

  return {
    stage,
    selected,
    sources,
    failureReason: failedNode?.errorMessage,
  };
}

async function discoverPipelineGraph(
  client: JenkinsClient,
  buildUrl: string,
): Promise<PipelineGraphNode[]> {
  const pipeline = await client.getPipelineDescription(buildUrl);
  const stages = pipeline?.stages ?? [];
  if (stages.length === 0) {
    throw pipelineCapabilityError(
      "Pipeline stage metadata is unavailable for this build.",
      buildUrl,
    );
  }

  const graph: PipelineGraphNode[] = stages.map(toStageNode);
  for (const stage of stages) {
    const stageId = normalizeId(stage.id);
    const selfUrl = stage._links?.self?.href;
    if (!stageId || !selfUrl) {
      continue;
    }
    const detail = await client.getPipelineNodeDescription(selfUrl);
    if (!detail) {
      continue;
    }
    mergeStageDetail(graph, stageId, detail);
    for (const node of detail.stageFlowNodes ?? []) {
      addNodeRecursively(
        graph,
        node,
        stageId,
        stage.name || `Stage ${stageId}`,
      );
    }
  }

  const byId = new Map(graph.map((node) => [node.id, node]));
  for (const node of graph) {
    node.path = buildDisplayPath(node, byId);
  }
  return graph;
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
  graph: PipelineGraphNode[],
  stageId: string,
  detail: JenkinsPipelineNodeResponse,
): void {
  const stage = graph.find((node) => node.id === stageId && node.isStage);
  if (!stage) {
    return;
  }
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

function selectGraphNode(
  graph: PipelineGraphNode[],
  options: { stage?: string; stageId?: string; failed?: boolean },
): PipelineGraphNode {
  if (options.failed) {
    const failedStages = graph.filter(
      (node) => node.isStage && isFailureStatus(node.status),
    );
    if (failedStages.length === 0) {
      throw new CliError(
        "Jenkins did not report a failed Pipeline stage for this build.",
        ["Run the whole-build log to inspect non-Pipeline failures."],
        "FAILED_STAGE_UNAVAILABLE",
      );
    }
    const stage = failedStages.sort(compareNodes)[0]!;
    return (
      graph
        .filter(
          (node) => node.stageId === stage.id && isFailureStatus(node.status),
        )
        .sort(compareDepthDescending)[0] ?? stage
    );
  }

  const requestedId = options.stageId?.trim();
  if (requestedId) {
    const match = graph.find((node) => node.id === requestedId);
    if (!match) {
      throw new CliError(
        `No Pipeline stage or node has id ${requestedId}.`,
        [formatCandidates(graph.filter((node) => node.isStage))],
        "PIPELINE_STAGE_NOT_FOUND",
      );
    }
    return match;
  }

  const requestedName = options.stage?.trim();
  const matches = graph.filter(
    (node) => node.isStage && node.name === requestedName,
  );
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
    [formatCandidates(graph.filter((node) => node.isStage))],
    "PIPELINE_STAGE_NOT_FOUND",
  );
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
    .sort(compareNodes)
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
