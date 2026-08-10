import { withTimeout } from "../with-timeout";
import { extractBranchParam } from "../job-parameters";
/**
 * Jenkins REST API client.
 * Handles authentication, CSRF crumbs, and provides methods for
 * listing jobs, fetching status, and triggering builds.
 */
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { CliError } from "../cli";
import { recordJenkinsApiCall, recordJenkinsApiFailure } from "../analytics";
import { normalizeJobParameterDefinitions } from "../job-parameters";
import {
  logApiRequest,
  logApiResponse,
  logApiError,
  logNetworkError,
} from "../logger";
import type {
  ArtifactEntry,
  BuildArtifacts,
  BuildHistoryEntry,
  BuildHistoryPage,
  BuildStatus,
  ConsoleChunk,
  Crumb,
  JenkinsApiArtifact,
  JenkinsApiBuild,
  JenkinsApiBuildAction,
  JenkinsApiBuildsResponse,
  JenkinsApiComputer,
  JenkinsApiJob,
  JenkinsBuildArtifactsResponse,
  JenkinsLastCompletedBuildResponse,
  JenkinsPipelineNodeResponse,
  JenkinsPipelineNodeLogResponse,
  JenkinsApiQueueItem,
  JenkinsBuildFailure,
  JenkinsBuildParameter,
  JenkinsClientOptions,
  JenkinsComputerResponse,
  JenkinsCrumbResponse,
  JenkinsJob,
  JenkinsJobLastBuild,
  JenkinsRevision,
  JenkinsJobParametersResponse,
  JobParameterDefinition,
  JenkinsJobsResponse,
  JenkinsJobStatusResponse,
  JenkinsLastFailedBuildResponse,
  JenkinsPipelineDescribeResponse,
  JenkinsQueueItemsResponse,
  JenkinsQueueWaitTimeResponse,
  JobStatus,
  LastFailedBuildReference,
  NodeSummary,
  NodesSummary,
  PipelineInfo,
  QueueBuildReference,
  QueueItemSummary,
  RunningBuildSummary,
  TriggerBuildParams,
  TriggerBuildResult,
} from "../types/jenkins";

export type {
  BuildArtifacts,
  BuildHistoryPage,
  BuildStatus,
  ConsoleChunk,
  JenkinsClientOptions,
  JenkinsJob,
  JobParameterDefinition,
  JobStatus,
  NodesSummary,
  QueueBuildReference,
  QueueItemSummary,
  RunningBuildSummary,
  TriggerBuildParams,
  TriggerBuildResult,
} from "../types/jenkins";

export class JenkinsClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly useCrumb: boolean;
  private readonly folderDepth: number;
  private crumbCache?: Crumb;

  constructor(options: JenkinsClientOptions) {
    this.baseUrl = options.baseUrl;
    const token = Buffer.from(`${options.user}:${options.apiToken}`).toString(
      "base64",
    );
    this.authHeader = `Basic ${token}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.useCrumb = options.useCrumb === true;
    const inDepth = options.folderDepth;
    if (typeof inDepth !== "number" || !Number.isFinite(inDepth)) {
      this.folderDepth = DEFAULT_FOLDER_DEPTH;
    } else {
      const parsedDepth = Math.max(0, Math.floor(inDepth));
      this.folderDepth =
        parsedDepth > MAX_FOLDER_DEPTH ? MAX_FOLDER_DEPTH : parsedDepth;
    }
  }

  async listJobs(): Promise<JenkinsJob[]> {
    const treeFields = buildFolderTree(FOLDER_LEAF_FIELDS, this.folderDepth);
    const url = this.withBase(`api/json?tree=jobs[${treeFields}]`);
    const data = await this.requestJson<JenkinsJobsResponse>(url, "list jobs");
    if (!Array.isArray(data.jobs)) {
      throw new CliError("Unexpected Jenkins response when listing jobs.", [
        "Try `jenkins-cli --refresh` again.",
      ]);
    }

    const jobs: JenkinsJob[] = [];
    const seen = new Set<string>();
    for (const item of data.jobs) {
      await this.collectFolderJobs(item, jobs, seen);
    }

    if (jobs.length === 0) {
      throw new CliError("Unexpected Jenkins response: no valid jobs found.", [
        "Try `jenkins-cli --refresh` again.",
      ]);
    }

    return jobs;
  }

  async listRunningBuilds(): Promise<RunningBuildSummary[]> {
    const treeFields = buildFolderTree(
      RUNNING_BUILD_LEAF_FIELDS,
      this.folderDepth,
    );
    const url = this.withBase(`api/json?tree=jobs[${treeFields}]`);
    const data = await this.requestJson<JenkinsJobsResponse>(
      url,
      "list running builds",
    );
    if (!Array.isArray(data.jobs)) {
      throw new CliError(
        "Unexpected Jenkins response when listing running builds.",
        ["Try again after checking the Jenkins connection."],
      );
    }

    const builds: RunningBuildSummary[] = [];
    const seen = new Set<string>();
    for (const item of data.jobs) {
      await this.collectRunningBuilds(item, builds, seen);
    }

    builds.sort((left, right) => {
      const byName = runningBuildDisplayName(left).localeCompare(
        runningBuildDisplayName(right),
      );
      return byName || left.buildNumber - right.buildNumber;
    });
    return builds;
  }

  private async collectFolderJobs(
    item: JenkinsApiJob,
    out: JenkinsJob[],
    seen: Set<string>,
  ): Promise<void> {
    if (item._class === CLOUDBEES_FOLDER_CLASS) {
      let children: JenkinsApiJob[];
      if (Array.isArray(item.jobs)) {
        children = item.jobs;
      } else if (typeof item.url === "string") {
        const treeFields = buildFolderTree(
          FOLDER_LEAF_FIELDS,
          this.folderDepth,
        );
        const folderUrl = this.withJob(
          item.url,
          `api/json?tree=jobs[${treeFields}]`,
        );
        const folderData = await this.requestJson<JenkinsJobsResponse>(
          folderUrl,
          `list jobs in folder ${item.fullName ?? item.name ?? item.url}`,
        );
        children = Array.isArray(folderData.jobs) ? folderData.jobs : [];
      } else {
        return;
      }
      for (const child of children) {
        await this.collectFolderJobs(child, out, seen);
      }
      return;
    }

    const normalized = normalizeJob(item);
    if (!normalized) {
      console.warn("Skipping malformed job entry:", item);
      return;
    }
    const key = normalizeUrl(normalized.url);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  }

  private async collectRunningBuilds(
    item: JenkinsApiJob,
    out: RunningBuildSummary[],
    seen: Set<string>,
  ): Promise<void> {
    if (item._class === CLOUDBEES_FOLDER_CLASS) {
      let children: JenkinsApiJob[];
      if (Array.isArray(item.jobs)) {
        children = item.jobs;
      } else if (typeof item.url === "string") {
        const treeFields = buildFolderTree(
          RUNNING_BUILD_LEAF_FIELDS,
          this.folderDepth,
        );
        const folderUrl = this.withJob(
          item.url,
          `api/json?tree=jobs[${treeFields}]`,
        );
        const folderData = await this.requestJson<JenkinsJobsResponse>(
          folderUrl,
          `list running builds in folder ${item.fullName ?? item.name ?? item.url}`,
        );
        children = Array.isArray(folderData.jobs) ? folderData.jobs : [];
      } else {
        return;
      }
      for (const child of children) {
        await this.collectRunningBuilds(child, out, seen);
      }
      return;
    }

    const normalized = normalizeRunningBuild(item);
    if (!normalized) {
      return;
    }
    const key = normalizeUrl(normalized.buildUrl);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  }

  async getJobStatus(jobUrl: string): Promise<JobStatus> {
    const url = this.withJob(
      jobUrl,
      "api/json?tree=disabled,lastBuild[number,url,result,building,timestamp,duration,estimatedDuration]",
    );
    const data = await this.requestJson<JenkinsJobStatusResponse>(
      url,
      "job status",
    );

    const lastBuild = data.lastBuild;
    if (!lastBuild) {
      return { disabled: data.disabled };
    }

    const buildUrl = lastBuild.url;
    const buildDetails = buildUrl ? await this.getBuildDetails(buildUrl) : null;
    const pipeline = buildUrl ? await this.getPipelineInfo(buildUrl) : null;
    let queueTimeMs: number | undefined;
    if (
      typeof pipeline?.queueDurationMillis === "number" &&
      pipeline.queueDurationMillis >= 0
    ) {
      queueTimeMs = pipeline.queueDurationMillis;
    } else if (
      typeof buildDetails?.queueId === "number" &&
      typeof lastBuild.timestamp === "number"
    ) {
      queueTimeMs = await this.getQueueWaitTimeMs(
        buildDetails.queueId,
        lastBuild.timestamp,
      );
    }
    const { parameters, branch, revisions, triggeredBy } =
      extractBuildMetadata(buildDetails);

    return {
      disabled: data.disabled,
      buildNumber: lastBuild.number,
      buildUrl: lastBuild.url,
      result: lastBuild.result ?? null,
      building: lastBuild.building ?? false,
      timestampMs: lastBuild.timestamp,
      durationMs: lastBuild.duration,
      estimatedDurationMs: lastBuild.estimatedDuration,
      queueTimeMs,
      parameters,
      branch,
      revisions,
      stages: pipeline?.stages,
      triggeredBy,
    };
  }

  async getJobParameterDefinitions(
    jobUrl: string,
  ): Promise<JobParameterDefinition[]> {
    const url = this.withJob(
      jobUrl,
      "api/json?tree=property[_class,parameterDefinitions[_class,type,name,description,defaultValue,defaultParameterValue[value],choices]]",
    );
    const data = await this.requestJson<JenkinsJobParametersResponse>(
      url,
      "fetch job parameters",
    );
    return normalizeJobParameterDefinitions(data);
  }

  async getBuildStatus(buildUrl: string): Promise<BuildStatus> {
    const url = this.withJob(buildUrl, `api/json?tree=${BUILD_DETAILS_FIELDS}`);
    const buildDetails = await this.requestJson<JenkinsApiBuild>(
      url,
      "fetch build status",
    );

    const pipeline = await this.getPipelineInfo(buildUrl);
    let queueTimeMs: number | undefined;
    if (
      typeof pipeline?.queueDurationMillis === "number" &&
      pipeline.queueDurationMillis >= 0
    ) {
      queueTimeMs = pipeline.queueDurationMillis;
    } else if (
      typeof buildDetails.queueId === "number" &&
      typeof buildDetails.timestamp === "number"
    ) {
      queueTimeMs = await this.getQueueWaitTimeMs(
        buildDetails.queueId,
        buildDetails.timestamp,
      );
    }
    const { parameters, branch, revisions, triggeredBy } =
      extractBuildMetadata(buildDetails);

    return {
      buildNumber: buildDetails.number,
      buildUrl: buildDetails.url ?? buildUrl,
      result: buildDetails.result ?? null,
      building: buildDetails.building ?? false,
      timestampMs: buildDetails.timestamp,
      durationMs: buildDetails.duration,
      estimatedDurationMs: buildDetails.estimatedDuration,
      queueTimeMs,
      parameters,
      branch,
      revisions,
      stages: pipeline?.stages,
      triggeredBy,
    };
  }

  async listBuildHistory(
    jobUrl: string,
    options: {
      offset?: number;
      limit?: number;
    } = {},
  ): Promise<BuildHistoryPage> {
    const limit = normalizePageLimit(options.limit);
    const offset = normalizePageOffset(options.offset);
    const url = this.withJob(
      jobUrl,
      `api/json?tree=builds[${BUILD_HISTORY_FIELDS}]`,
    );
    const payload = await this.requestJson<JenkinsApiBuildsResponse>(
      url,
      "list build history",
    );
    const normalizedBuilds = (
      Array.isArray(payload.builds) ? payload.builds : []
    )
      .map(normalizeBuildHistoryEntry)
      .filter((entry): entry is BuildHistoryEntry => Boolean(entry));
    const pageBuilds = normalizedBuilds.slice(offset, offset + limit);
    const enrichedBuilds = await Promise.all(
      pageBuilds.map(async (entry) => {
        const pipeline = await this.getPipelineInfo(entry.buildUrl, {
          includeFailure: true,
        });
        return {
          ...entry,
          ...(pipeline?.stages ? { stages: pipeline.stages } : {}),
          ...(pipeline?.failure ? { failure: pipeline.failure } : {}),
        };
      }),
    );

    return {
      builds: enrichedBuilds,
      total: normalizedBuilds.length,
      offset,
      limit,
      hasNext: offset + limit < normalizedBuilds.length,
      hasPrevious: offset > 0,
    };
  }

  async getLastCompletedBuild(
    jobUrl: string,
  ): Promise<{ buildUrl: string; buildNumber?: number } | null> {
    const url = this.withJob(
      jobUrl,
      "api/json?tree=lastCompletedBuild[number,url]",
    );
    const payload = await this.requestJson<JenkinsLastCompletedBuildResponse>(
      url,
      "fetch last completed build",
    );
    const build = payload.lastCompletedBuild;
    if (!build?.url) {
      return null;
    }
    return {
      buildUrl: build.url,
      buildNumber: build.number,
    };
  }

  async listArtifacts(buildUrl: string): Promise<BuildArtifacts> {
    const url = this.withJob(
      buildUrl,
      "api/json?tree=artifacts[fileName,relativePath],number,url",
    );
    const data = await this.requestJson<JenkinsBuildArtifactsResponse>(
      url,
      "list build artifacts",
    );
    const artifacts = (Array.isArray(data.artifacts) ? data.artifacts : [])
      .map(normalizeArtifact)
      .filter((entry): entry is ArtifactEntry => Boolean(entry));
    return {
      buildNumber: data.number,
      buildUrl: data.url ?? buildUrl,
      artifacts,
    };
  }

  /**
   * Stream a single build artifact to disk. The response body is piped to the
   * destination file rather than buffered in memory, so large artifacts do not
   * inflate the process heap. The destination directory is created if needed.
   * Returns the number of bytes written.
   */
  async downloadArtifact(
    buildUrl: string,
    relativePath: string,
    destPath: string,
  ): Promise<number> {
    const encodedPath = relativePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const url = this.withJob(buildUrl, `artifact/${encodedPath}`);
    const headers: Record<string, string> = { Authorization: this.authHeader };

    recordJenkinsApiCall();
    logApiRequest("GET", url, headers);

    const { controller, cleanup } = withTimeout(this.timeoutMs);
    let response: Response;
    try {
      // Only the response headers are guarded by the timeout; once the stream
      // starts we clear it so large downloads are not aborted mid-flight.
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logNetworkError("GET", url, "TIMEOUT");
        recordJenkinsApiFailure({
          operation: "download_artifact",
          errorType: "timeout",
        });
        throw new CliError(
          `Request timed out while trying to download artifact ${relativePath}.`,
          [`Check your network and that ${this.baseUrl} is reachable.`],
        );
      }
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logNetworkError("GET", url, errorMsg);
      recordJenkinsApiFailure({
        operation: "download_artifact",
        errorType: "network_error",
      });
      throw new CliError(
        `Network error while trying to download artifact ${relativePath}.`,
        [`Check your network and that ${this.baseUrl} is reachable.`],
      );
    } finally {
      cleanup();
    }

    if (!response.ok) {
      logApiError("GET", url, response.status, response.headers);
      recordJenkinsApiFailure({
        operation: "download_artifact",
        errorType: "http_error",
        httpStatus: response.status,
      });
      await this.raiseHttpError(response, `download artifact ${relativePath}`);
    }
    logApiResponse("GET", url, response.status, response.headers);

    // FileSink writes from offset 0 but does not truncate, so a smaller new
    // payload could leave trailing bytes from a previous file. Removing any
    // existing file first guarantees the artifact is written cleanly.
    mkdirSync(dirname(destPath), { recursive: true });
    await rm(destPath, { force: true });
    const file = Bun.file(destPath);
    const writer = file.writer();
    let bytesWritten = 0;
    try {
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value && value.byteLength > 0) {
            // write() returns a promise when the sink must flush to disk;
            // awaiting it applies backpressure and surfaces write errors here
            // instead of as unhandled (fatal) rejections.
            await writer.write(value);
            bytesWritten += value.byteLength;
          }
        }
      }
    } finally {
      await writer.end();
    }
    return bytesWritten;
  }

  async getQueueBuild(queueUrl: string): Promise<QueueBuildReference | null> {
    const queueItem = await this.getQueueItem(queueUrl);
    if (!queueItem) {
      return null;
    }
    return {
      buildUrl: queueItem.executable?.url,
      buildNumber: queueItem.executable?.number,
    };
  }

  async listQueueItems(): Promise<QueueItemSummary[]> {
    const url = this.withBase(
      "queue/api/json?tree=items[id,url,why,inQueueSince,blocked,buildable,stuck,cancelled,task[name,url]]",
    );
    const payload = await this.requestJson<JenkinsQueueItemsResponse>(
      url,
      "list queue items",
    );
    if (!Array.isArray(payload.items)) {
      return [];
    }

    return payload.items
      .filter(
        (item): item is JenkinsApiQueueItem & { id: number } =>
          typeof item.id === "number" && Number.isFinite(item.id),
      )
      .filter((item) => !item.cancelled)
      .map((item) => ({
        id: item.id,
        queueUrl: item.url
          ? this.resolveUrl(item.url)
          : this.withBase(`queue/item/${item.id}/`),
        jobName: item.task?.name,
        jobUrl: item.task?.url,
        reason: item.why,
        inQueueSince: item.inQueueSince,
        blocked: item.blocked,
        buildable: item.buildable,
        stuck: item.stuck,
      }));
  }

  async listNodes(): Promise<NodesSummary> {
    const url = this.withBase(
      "computer/api/json?tree=busyExecutors,totalExecutors,computer[displayName,offline,temporarilyOffline,offlineCauseReason,numExecutors,assignedLabels[name],executors[currentExecutable[url]],oneOffExecutors[currentExecutable[url]]]",
    );
    const payload = await this.requestJson<JenkinsComputerResponse>(
      url,
      "list nodes",
    );
    const computers = Array.isArray(payload.computer) ? payload.computer : [];
    const nodes = computers.map(normalizeNodeSummary);
    const offlineNodes = nodes.filter(
      (node) => node.offline || node.temporarilyOffline,
    ).length;
    const busyExecutors =
      typeof payload.busyExecutors === "number"
        ? payload.busyExecutors
        : nodes.reduce((sum, node) => sum + node.busyExecutors, 0);
    const totalExecutors =
      typeof payload.totalExecutors === "number"
        ? payload.totalExecutors
        : nodes.reduce((sum, node) => sum + node.totalExecutors, 0);

    return {
      nodes,
      totalNodes: nodes.length,
      offlineNodes,
      busyExecutors,
      totalExecutors,
    };
  }

  async cancelQueueItem(queueUrl: string): Promise<boolean> {
    const queueItem = await this.getQueueItem(queueUrl);
    if (!queueItem || typeof queueItem.id !== "number") {
      return false;
    }
    await this.cancelQueueItemById(queueItem.id);
    return true;
  }

  async cancelQueueItemById(queueId: number): Promise<void> {
    if (!Number.isFinite(queueId) || queueId <= 0) {
      throw new CliError("Invalid queue id.", [
        "Provide a valid queue item id (e.g. 123).",
      ]);
    }
    const url = this.withBase(`queue/cancelItem?id=${queueId}`);
    await this.postWithCrumb(url, "cancel queue item");
  }

  async stopBuild(buildUrl: string): Promise<void> {
    const url = this.withJob(buildUrl, "stop");
    await this.postWithCrumb(url, "stop build");
  }

  async getConsoleChunk(buildUrl: string, start = 0): Promise<ConsoleChunk> {
    return await this.getProgressiveLogChunk(
      this.withJob(buildUrl, "logText/progressiveText"),
      start,
      "fetch build logs",
    );
  }

  async getPipelineDescription(buildUrl: string): Promise<PipelineInfo | null> {
    return await this.getPipelineInfo(buildUrl);
  }

  async getPipelineNodeDescription(
    nodeUrl: string,
  ): Promise<JenkinsPipelineNodeResponse | null> {
    return await this.getPipelineNode(this.resolveUrl(nodeUrl));
  }

  async getPipelineNodeLog(
    logUrl: string,
  ): Promise<JenkinsPipelineNodeLogResponse | null> {
    const url = this.resolveUrl(logUrl);
    const response = await this.fetchWithTimeout(
      url,
      { method: "GET", headers: this.authHeaders() },
      0,
      "fetch pipeline node logs",
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      await this.raiseHttpError(response, "fetch pipeline node logs");
    }
    try {
      return (await response.json()) as JenkinsPipelineNodeLogResponse;
    } catch {
      throw new CliError(
        "Invalid JSON response while trying to fetch pipeline node logs.",
        ["Try the whole-build log instead."],
        "PIPELINE_STAGE_LOG_UNAVAILABLE",
      );
    }
  }

  async getPipelineNodeConsoleChunk(
    consoleUrl: string,
    start = 0,
  ): Promise<ConsoleChunk> {
    return await this.getProgressiveLogChunk(
      this.withJob(this.resolveUrl(consoleUrl), "logText/progressiveText"),
      start,
      "fetch pipeline node logs",
    );
  }

  async getConsoleTimestamps(
    buildUrl: string,
    options: {
      endLine?: number;
      currentTime?: boolean;
      appendLog?: boolean;
    } = {},
  ): Promise<string | null> {
    const url = new URL(this.withJob(buildUrl, "timestamps/"));
    url.searchParams.set("time", "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
    url.searchParams.set("timeZone", "UTC");
    if (typeof options.endLine === "number") {
      url.searchParams.set("endLine", String(Math.max(0, options.endLine)));
    }
    if (options.currentTime) {
      url.searchParams.set("currentTime", "true");
    }
    if (options.appendLog) {
      url.searchParams.set("appendLog", "true");
    }
    const response = await this.fetchWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers: { ...this.authHeaders(), Accept: "text/plain" },
      },
      0,
      "fetch build timestamps",
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      await this.raiseHttpError(response, "fetch build timestamps");
    }
    return await response.text();
  }

  private async getProgressiveLogChunk(
    progressiveUrl: string,
    start: number,
    context: string,
  ): Promise<ConsoleChunk> {
    const normalizedStart =
      Number.isFinite(start) && start > 0 ? Math.floor(start) : 0;
    const url = new URL(progressiveUrl);
    url.searchParams.set("start", String(normalizedStart));

    const response = await this.fetchWithTimeout(
      url.toString(),
      { method: "GET", headers: this.authHeaders() },
      1,
      context,
    );
    if (!response.ok) {
      recordJenkinsApiFailure({
        operation: toAnalyticsOperation(context),
        errorType: "http_error",
        httpStatus: response.status,
      });
      await this.raiseHttpError(response, context);
    }

    const text = await response.text();
    const textSizeHeader = response.headers.get("x-text-size");
    const parsedNextStart = textSizeHeader
      ? Number(textSizeHeader)
      : Number.NaN;
    const nextStart = Number.isFinite(parsedNextStart)
      ? parsedNextStart
      : normalizedStart + Buffer.byteLength(text);
    const hasMore = (response.headers.get("x-more-data") || "")
      .toLowerCase()
      .trim();

    return {
      text,
      nextStart,
      hasMore: hasMore === "true",
    };
  }

  async getLastFailedBuild(
    jobUrl: string,
  ): Promise<LastFailedBuildReference | null> {
    const url = this.withJob(
      jobUrl,
      "api/json?tree=lastFailedBuild[url,number]",
    );
    const payload = await this.requestJson<JenkinsLastFailedBuildResponse>(
      url,
      "fetch last failed build",
    );
    const build = payload.lastFailedBuild;
    if (!build?.url) {
      return null;
    }
    return {
      buildUrl: build.url,
      buildNumber: build.number,
    };
  }

  async triggerBuild(
    jobUrl: string,
    params: TriggerBuildParams,
  ): Promise<TriggerBuildResult> {
    const filteredParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const normalizedKey = key.trim();
      if (!normalizedKey) {
        continue;
      }
      filteredParams.set(normalizedKey, value);
    }
    const hasParams = Array.from(filteredParams.keys()).length > 0;
    const triggerPath = hasParams ? "buildWithParameters" : "build";
    const buildUrl = this.withJob(jobUrl, triggerPath);
    const url = new URL(buildUrl);
    url.searchParams.set("delay", "0sec");
    const body = hasParams ? filteredParams.toString() : undefined;
    const response = await this.sendPostWithCrumbRetry({
      url: url.toString(),
      context: "trigger build",
      body,
    });

    if (!response.ok) {
      recordJenkinsApiFailure({
        operation: "trigger_build",
        errorType: "http_error",
        httpStatus: response.status,
        retryAttempted: this.useCrumb && response.status === 403,
      });
      await this.raiseHttpError(response, "trigger build");
    }

    const location = response.headers.get("location") ?? undefined;
    const queueUrl = location ? this.resolveUrl(location) : undefined;
    const queueItem = queueUrl ? await this.getQueueItem(queueUrl) : null;

    return {
      queueUrl,
      queueId: queueItem?.id,
      jobUrl: queueItem?.task?.url ?? jobUrl,
      buildUrl: queueItem?.executable?.url,
      buildNumber: queueItem?.executable?.number,
    };
  }

  private async postWithCrumb(
    url: string,
    context: string,
    body?: string,
  ): Promise<void> {
    const response = await this.sendPostWithCrumbRetry({ url, context, body });
    if (!response.ok) {
      recordJenkinsApiFailure({
        operation: toAnalyticsOperation(context),
        errorType: "http_error",
        httpStatus: response.status,
        retryAttempted: this.useCrumb && response.status === 403,
      });
      await this.raiseHttpError(response, context);
    }
  }

  private async sendPostWithCrumbRetry(options: {
    url: string;
    context: string;
    body?: string;
  }): Promise<Response> {
    if (!this.useCrumb) {
      const headers: Record<string, string> = {
        Authorization: this.authHeader,
      };
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
      return await this.fetchWithTimeout(
        options.url,
        {
          method: "POST",
          headers,
          ...(options.body !== undefined ? { body: options.body } : {}),
        },
        1,
        options.context,
      );
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const crumb = await this.getCrumb();
      const headers: Record<string, string> = {
        Authorization: this.authHeader,
      };
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
      if (crumb) {
        headers[crumb.field] = crumb.value;
      }
      const response = await this.fetchWithTimeout(
        options.url,
        {
          method: "POST",
          headers,
          ...(options.body !== undefined ? { body: options.body } : {}),
        },
        1,
        options.context,
      );
      if (response.status === 403 && attempt === 0) {
        this.crumbCache = undefined;
        continue;
      }
      return response;
    }

    throw new CliError(
      `Unable to complete request while trying to ${options.context}.`,
      ["Try again, or check the Jenkins server logs."],
    );
  }

  private async getCrumb(): Promise<Crumb | null> {
    if (this.crumbCache) {
      return this.crumbCache;
    }

    const url = this.withBase("crumbIssuer/api/json");
    const response = await this.fetchWithTimeout(
      url,
      { method: "GET", headers: this.authHeaders() },
      1,
      "fetch crumb",
    );

    if (!response.ok) {
      if (response.status === 404 || response.status === 403) {
        return null;
      }
      recordJenkinsApiFailure({
        operation: "fetch_crumb",
        errorType: "http_error",
        httpStatus: response.status,
      });
      await this.raiseHttpError(response, "fetch crumb");
    }

    const data = (await response.json()) as JenkinsCrumbResponse;

    if (!data.crumbRequestField || !data.crumb) {
      return null;
    }

    this.crumbCache = { field: data.crumbRequestField, value: data.crumb };
    return this.crumbCache;
  }

  private async requestJson<T>(url: string, context: string): Promise<T> {
    const response = await this.fetchWithTimeout(
      url,
      { method: "GET", headers: this.authHeaders() },
      1,
      context,
    );

    if (!response.ok) {
      recordJenkinsApiFailure({
        operation: toAnalyticsOperation(context),
        errorType: "http_error",
        httpStatus: response.status,
      });
      await this.raiseHttpError(response, context);
    }

    try {
      return (await response.json()) as T;
    } catch {
      recordJenkinsApiFailure({
        operation: toAnalyticsOperation(context),
        errorType: "invalid_json",
      });
      throw new CliError(`Invalid JSON response while trying to ${context}.`, [
        "Try again, or verify your Jenkins server is healthy.",
      ]);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    retriesLeft: number,
    context: string,
    attemptedRetry = false,
  ): Promise<Response> {
    const method = options.method ?? "GET";
    // POST bodies can contain build parameters and secrets. Never persist them
    // in debug logs; the real body is still sent unchanged to Jenkins.
    const requestBody =
      method.toUpperCase() === "POST"
        ? options.body === undefined || options.body === null
          ? null
          : "<omitted>"
        : this.serializeRequestBody(options.body);
    recordJenkinsApiCall();
    logApiRequest(method, url, options.headers, requestBody);

    const { controller, cleanup } = withTimeout(this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      // Jenkins responses can contain password parameter defaults or values.
      // Keep response bodies out of persistent debug logs for every method.
      const loggedResponseBody = null;
      if (response.ok) {
        logApiResponse(
          method,
          url,
          response.status,
          response.headers,
          loggedResponseBody,
        );
      } else {
        logApiError(
          method,
          url,
          response.status,
          response.headers,
          loggedResponseBody,
        );
      }
      return response;
    } catch (error) {
      if (retriesLeft > 0) {
        return this.fetchWithTimeout(
          url,
          options,
          retriesLeft - 1,
          context,
          true,
        );
      }

      if (error instanceof Error && error.name === "AbortError") {
        logNetworkError(method, url, "TIMEOUT");
        recordJenkinsApiFailure({
          operation: toAnalyticsOperation(context),
          errorType: "timeout",
          retryAttempted: attemptedRetry,
        });
        throw new CliError(`Request timed out while trying to ${context}.`, [
          `Check your network and that ${this.baseUrl} is reachable.`,
        ]);
      }

      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logNetworkError(method, url, errorMsg);
      recordJenkinsApiFailure({
        operation: toAnalyticsOperation(context),
        errorType: "network_error",
        retryAttempted: attemptedRetry,
      });
      throw new CliError(`Network error while trying to ${context}.`, [
        `Check your network and that ${this.baseUrl} is reachable.`,
      ]);
    } finally {
      cleanup();
    }
  }

  private serializeRequestBody(
    body: Bun.BodyInit | null | undefined,
  ): string | null {
    if (body === null || body === undefined) {
      return null;
    }
    if (typeof body === "string") {
      return body;
    }
    if (body instanceof URLSearchParams) {
      return body.toString();
    }
    if (body instanceof FormData) {
      const entries: string[] = [];
      for (const [key, value] of body.entries()) {
        entries.push(`${key}=${serializeUnknownValue(value)}`);
      }
      return entries.join("&");
    }
    if (body instanceof Blob) {
      return `[blob size=${body.size} type=${body.type || "unknown"}]`;
    }
    if (body instanceof ArrayBuffer) {
      return `[arraybuffer byteLength=${body.byteLength}]`;
    }
    if (ArrayBuffer.isView(body)) {
      return `[binary byteLength=${body.byteLength}]`;
    }
    return `[body kind=${typeof body}]`;
  }

  private async raiseHttpError(
    response: Response,
    context: string,
  ): Promise<never> {
    const status = response.status;
    const detail = await readJenkinsErrorDetail(response);
    const code =
      status === 401 || status === 403
        ? "JENKINS_AUTH_ERROR"
        : status === 404 && isBuildResourceContext(context)
          ? "BUILD_NOT_FOUND"
          : status === 404
            ? "JENKINS_NOT_FOUND"
            : undefined;
    throw new CliError(
      `Jenkins returned HTTP ${status} while trying to ${context}${detail ? `: ${detail}` : "."}`,
      [],
      code,
    );
  }

  private withBase(path: string): string {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    return new URL(path, base).toString();
  }

  private withJob(jobUrl: string, path: string): string {
    const base = jobUrl.endsWith("/") ? jobUrl : `${jobUrl}/`;
    return new URL(path, base).toString();
  }

  private resolveUrl(value: string): string {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    try {
      return new URL(value, base).toString();
    } catch {
      return value;
    }
  }

  private async getBuildDetails(
    buildUrl: string,
  ): Promise<JenkinsApiBuild | null> {
    const url = this.withJob(buildUrl, `api/json?tree=${BUILD_DETAILS_FIELDS}`);
    try {
      const response = await this.fetchWithTimeout(
        url,
        { method: "GET", headers: this.authHeaders() },
        0,
        "fetch build details",
      );
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as JenkinsApiBuild;
    } catch {
      return null;
    }
  }

  private async getQueueWaitTimeMs(
    queueId: number,
    startTimestamp: number,
  ): Promise<number | undefined> {
    if (!Number.isFinite(queueId) || queueId <= 0) {
      return undefined;
    }
    const url = this.withBase(`queue/item/${queueId}/api/json`);
    try {
      const response = await this.fetchWithTimeout(
        url,
        { method: "GET", headers: this.authHeaders() },
        0,
        "fetch queue item",
      );
      if (!response.ok) {
        return undefined;
      }
      const data = (await response.json()) as JenkinsQueueWaitTimeResponse;
      if (typeof data.inQueueSince !== "number") {
        return undefined;
      }
      const wait = startTimestamp - data.inQueueSince;
      return wait >= 0 ? wait : undefined;
    } catch {
      return undefined;
    }
  }

  private async getQueueItem(
    queueUrl: string,
  ): Promise<JenkinsApiQueueItem | null> {
    const url = this.withJob(
      queueUrl,
      "api/json?tree=id,task[url],executable[number,url]",
    );
    try {
      const response = await this.fetchWithTimeout(
        url,
        { method: "GET", headers: this.authHeaders() },
        0,
        "fetch queue item",
      );
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as JenkinsApiQueueItem;
    } catch {
      return null;
    }
  }

  private async getPipelineInfo(
    buildUrl: string,
    options: {
      includeFailure?: boolean;
    } = {},
  ): Promise<PipelineInfo | null> {
    const base = buildUrl.endsWith("/") ? buildUrl : `${buildUrl}/`;
    const url = new URL("wfapi/describe", base).toString();
    try {
      const response = await this.fetchWithTimeout(
        url,
        { method: "GET", headers: this.authHeaders() },
        0,
        "fetch pipeline stage",
      );
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as JenkinsPipelineDescribeResponse;
      const failure = options.includeFailure
        ? await this.getPipelineFailure(data)
        : undefined;
      return {
        _links: data._links,
        id: data.id,
        name: data.name,
        status: data.status,
        startTimeMillis: data.startTimeMillis,
        endTimeMillis: data.endTimeMillis,
        durationMillis: data.durationMillis,
        queueDurationMillis: data.queueDurationMillis,
        pauseDurationMillis: data.pauseDurationMillis,
        stages:
          Array.isArray(data.stages) && data.stages.length > 0
            ? data.stages.map((stage) => ({
                ...stage,
                _links: stage._links
                  ? {
                      ...stage._links,
                      ...(stage._links.self
                        ? { self: { ...stage._links.self } }
                        : {}),
                      ...(stage._links.log
                        ? { log: { ...stage._links.log } }
                        : {}),
                    }
                  : undefined,
              }))
            : undefined,
        failure,
      };
    } catch {
      return null;
    }
  }

  private async getPipelineFailure(
    pipeline: JenkinsPipelineDescribeResponse,
  ): Promise<JenkinsBuildFailure | undefined> {
    const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
    const failedStage = stages.find((stage) => isFailureStatus(stage.status));
    if (!failedStage) {
      return undefined;
    }

    const failure: JenkinsBuildFailure = {
      stageName: failedStage.name,
    };
    const stageLink = failedStage._links?.self?.href;
    if (!stageLink) {
      return failure;
    }

    const stageNode = await this.getPipelineNode(this.resolveUrl(stageLink));
    if (!stageNode) {
      return failure;
    }

    const failedNode = findFailedPipelineNode(stageNode);
    const reason =
      cleanFailureReason(failedNode?.error?.message) ||
      cleanFailureReason(stageNode.error?.message) ||
      statusToReason(failedNode?.status) ||
      statusToReason(stageNode.status);

    return {
      stageName: failure.stageName,
      stepName: failedNode?.name || stageNode.name || failure.stageName,
      reason,
    };
  }

  private async getPipelineNode(
    url: string,
  ): Promise<JenkinsPipelineNodeResponse | null> {
    try {
      const response = await this.fetchWithTimeout(
        url,
        { method: "GET", headers: this.authHeaders() },
        0,
        "fetch pipeline node",
      );
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as JenkinsPipelineNodeResponse;
    } catch {
      return null;
    }
  }
}

function isBuildResourceContext(context: string): boolean {
  return (
    context === "fetch build status" ||
    context === "fetch build logs" ||
    context === "list build artifacts" ||
    context === "stop build" ||
    context.startsWith("download artifact ")
  );
}

const CLOUDBEES_FOLDER_CLASS = "com.cloudbees.hudson.plugins.folder.Folder";
const GIT_BUILD_DATA_CLASS = "hudson.plugins.git.util.BuildData";
const BUILD_ACTION_FIELDS =
  "parameters[name,value],_class,lastBuiltRevision[SHA1,branch[name]],remoteUrls,causes[shortDescription,userId,userName]";
const BUILD_HISTORY_FIELDS = `number,url,result,building,timestamp,duration,estimatedDuration,actions[${BUILD_ACTION_FIELDS}]`;
const BUILD_DETAILS_FIELDS = `${BUILD_HISTORY_FIELDS},queueId`;

const FOLDER_LEAF_FIELDS =
  "_class,name,fullName,url,disabled,lastBuild[number,url,result,building,timestamp,duration,estimatedDuration]";
const RUNNING_BUILD_LEAF_FIELDS =
  "_class,name,fullName,url,lastBuild[number,url,building]";
const DEFAULT_FOLDER_DEPTH = 3;
const MAX_FOLDER_DEPTH = 10;

function buildFolderTree(fields: string, depth: number): string {
  let tree = fields;
  for (let i = 0; i < depth; i++) {
    tree = `${fields},jobs[${tree}]`;
  }
  return tree;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function runningBuildDisplayName(build: RunningBuildSummary): string {
  return build.fullJobName?.trim() || build.jobName;
}

function toAnalyticsOperation(context: string): string {
  return context.trim().replaceAll(/\s+/g, "_");
}

function extractBuildParameters(
  actions?: JenkinsApiBuildAction[],
): JenkinsBuildParameter[] | undefined {
  if (!Array.isArray(actions)) {
    return undefined;
  }
  const params: JenkinsBuildParameter[] = [];
  for (const action of actions) {
    if (!action || !Array.isArray(action.parameters)) {
      continue;
    }
    for (const param of action.parameters) {
      if (!param || typeof param.name !== "string") {
        continue;
      }
      const value = serializeUnknownValue(param.value);
      params.push({ name: param.name, value });
    }
  }
  return params.length > 0 ? params : undefined;
}

/**
 * Who or what started the build, from the standard CauseAction every Jenkins
 * build carries. User-triggered builds report the user's display name; other
 * triggers (timer, SCM, upstream) keep Jenkins' short description minus the
 * redundant "Started by " prefix.
 */
function extractTriggeredBy(
  actions?: JenkinsApiBuildAction[],
): string | undefined {
  if (!Array.isArray(actions)) {
    return undefined;
  }
  for (const action of actions) {
    if (!action || !Array.isArray(action.causes)) {
      continue;
    }
    for (const cause of action.causes) {
      if (!cause) {
        continue;
      }
      const userLabel = cause.userName?.trim() || cause.userId?.trim();
      if (userLabel) {
        return userLabel;
      }
      const description = cause.shortDescription?.trim();
      if (description) {
        return description.replace(/^started by\s+/i, "");
      }
    }
  }
  return undefined;
}

function repoNameFromRemoteUrl(remoteUrl: string): string {
  // Split on ":" as well for SCP-style remotes (git@host:repo.git).
  const basename = remoteUrl
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split(/[/:]/)
    .pop();
  return basename || remoteUrl;
}

/** Strip userinfo from http(s) remote URLs so embedded credentials never
 * reach JSON output. Other schemes (ssh's git@ is load-bearing) pass through. */
function sanitizeRemoteUrl(remoteUrl: string): string {
  if (!/^https?:\/\//i.test(remoteUrl)) {
    return remoteUrl;
  }
  try {
    const url = new URL(remoteUrl);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return url.toString();
    }
  } catch {
    // Not parseable as a URL; report it as Jenkins returned it.
  }
  return remoteUrl;
}

function extractGitRevisions(
  actions?: JenkinsApiBuildAction[],
): JenkinsRevision[] {
  if (!Array.isArray(actions)) {
    return [];
  }

  // Jenkins may attach several BuildData actions for the same checkout (and
  // their order is not contractual), so merge entries that share a commit
  // SHA and an overlapping remote-URL set (or report no remotes at all):
  // union the remote URLs and keep the first branch any entry reports.
  // Distinct remotes checked out at the same SHA stay separate entries.
  const merged: Array<{ remoteUrls: string[]; branch?: string; sha: string }> =
    [];
  for (const action of actions) {
    if (action?._class !== GIT_BUILD_DATA_CLASS) {
      continue;
    }
    const sha = action.lastBuiltRevision?.SHA1;
    if (typeof sha !== "string" || sha.length === 0) {
      continue;
    }
    const remoteUrls = Array.isArray(action.remoteUrls)
      ? action.remoteUrls
          .filter(
            (remoteUrl): remoteUrl is string =>
              typeof remoteUrl === "string" && remoteUrl.length > 0,
          )
          .map(sanitizeRemoteUrl)
      : [];
    const branch = action.lastBuiltRevision?.branch?.[0]?.name || undefined;

    const existing = merged.find(
      (candidate) =>
        candidate.sha === sha &&
        (candidate.remoteUrls.length === 0 ||
          remoteUrls.length === 0 ||
          remoteUrls.some((remoteUrl) =>
            candidate.remoteUrls.includes(remoteUrl),
          )),
    );
    if (!existing) {
      merged.push({ remoteUrls, branch, sha });
      continue;
    }
    for (const remoteUrl of remoteUrls) {
      if (!existing.remoteUrls.includes(remoteUrl)) {
        existing.remoteUrls.push(remoteUrl);
      }
    }
    existing.branch ??= branch;
  }

  // A later action can bridge two earlier entries (same SHA seen with
  // [remoteA], [remoteB], then [remoteA, remoteB]); coalesce until stable.
  for (let i = 0; i < merged.length; i++) {
    const target = merged[i]!;
    for (let j = i + 1; j < merged.length;) {
      const candidate = merged[j]!;
      if (
        candidate.sha === target.sha &&
        candidate.remoteUrls.some((remoteUrl) =>
          target.remoteUrls.includes(remoteUrl),
        )
      ) {
        for (const remoteUrl of candidate.remoteUrls) {
          if (!target.remoteUrls.includes(remoteUrl)) {
            target.remoteUrls.push(remoteUrl);
          }
        }
        target.branch ??= candidate.branch;
        merged.splice(j, 1);
        j = i + 1;
      } else {
        j++;
      }
    }
  }

  return merged.map(({ remoteUrls, branch, sha }) => {
    const remoteUrl = remoteUrls[0];
    return {
      repo: remoteUrl ? repoNameFromRemoteUrl(remoteUrl) : undefined,
      remoteUrl,
      remoteUrls,
      branch,
      sha,
    };
  });
}

/**
 * Parameters, branch input, and checkout evidence for one build. All fields
 * are undefined when the build's metadata could not be fetched, so callers
 * never report "no checkout" for a build they know nothing about.
 */
function extractBuildMetadata(build: JenkinsApiBuild | null): {
  parameters?: JenkinsBuildParameter[];
  branch?: string;
  revisions?: JenkinsRevision[];
  triggeredBy?: string;
} {
  if (!build) {
    return {};
  }
  const parameters = extractBuildParameters(build.actions);
  return {
    parameters,
    branch: extractBranchParam(parameters),
    revisions: extractGitRevisions(build.actions),
    triggeredBy: extractTriggeredBy(build.actions),
  };
}

function normalizeArtifact(artifact: JenkinsApiArtifact): ArtifactEntry | null {
  const relativePath =
    typeof artifact.relativePath === "string"
      ? artifact.relativePath.trim()
      : "";
  const fileName =
    typeof artifact.fileName === "string" ? artifact.fileName.trim() : "";
  const resolvedRelativePath =
    relativePath || fileName || artifact.displayPath?.trim() || "";
  if (!resolvedRelativePath) {
    return null;
  }
  const resolvedFileName =
    fileName || resolvedRelativePath.split("/").pop() || resolvedRelativePath;
  return {
    fileName: resolvedFileName,
    relativePath: resolvedRelativePath,
  };
}

function normalizeBuildHistoryEntry(
  build: JenkinsApiBuild,
): BuildHistoryEntry | null {
  const buildUrl = typeof build.url === "string" ? build.url : "";
  if (!buildUrl) {
    return null;
  }
  return {
    buildNumber: build.number,
    buildUrl,
    result: build.result ?? null,
    building: build.building ?? false,
    timestampMs: build.timestamp,
    durationMs: build.duration,
    estimatedDurationMs: build.estimatedDuration,
    ...extractBuildMetadata(build),
  };
}

function findFailedPipelineNode(
  node: JenkinsPipelineNodeResponse,
): JenkinsPipelineNodeResponse | undefined {
  const childNodes = Array.isArray(node.stageFlowNodes)
    ? node.stageFlowNodes
    : [];
  for (const child of childNodes) {
    const nested = findFailedPipelineNode(child);
    if (nested) {
      return nested;
    }
  }
  if (isFailureStatus(node.status)) {
    return node;
  }
  return undefined;
}

function isFailureStatus(status: string | undefined): boolean {
  const normalized = (status ?? "").trim().toUpperCase();
  return (
    normalized === "FAILED" ||
    normalized === "FAILURE" ||
    normalized === "UNSTABLE" ||
    normalized === "ABORTED"
  );
}

function cleanFailureReason(value: string | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized || undefined;
}

function statusToReason(status: string | undefined): string | undefined {
  const normalized = (status ?? "").trim();
  return normalized ? `Pipeline step status: ${normalized}` : undefined;
}

function normalizePageLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || typeof value !== "number") {
    return 5;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 5;
}

function normalizePageOffset(value: number | undefined): number {
  if (!Number.isFinite(value) || typeof value !== "number") {
    return 0;
  }
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : 0;
}

function serializeUnknownValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable object]";
    }
  }
  return String(value);
}

const MAX_JENKINS_ERROR_DETAIL_LENGTH = 2_000;
const ANSI_TERMINAL_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

async function readJenkinsErrorDetail(
  response: Response,
): Promise<string | undefined> {
  const xError = response.headers.get("x-error");
  if (xError?.trim()) {
    return truncateErrorDetail(xError.trim());
  }

  const body = await readResponseText(response);
  if (!body.trim()) {
    return undefined;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    try {
      return truncateErrorDetail(JSON.stringify(JSON.parse(body)));
    } catch {
      // Fall through to readable text normalization for malformed JSON.
    }
  }

  const normalized = normalizeJenkinsErrorBody(body);
  return normalized ? truncateErrorDetail(normalized) : undefined;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function normalizeJenkinsErrorBody(body: string): string {
  const withoutExecutableContent = body
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  const readable = decodeBasicHtmlEntities(
    withoutExecutableContent.replaceAll(/<[^>]+>/g, " "),
  )
    .replaceAll(/\s+/g, " ")
    .trim();
  const jettyMessage = readable.match(
    /\bMESSAGE:\s*(.+?)(?=\s+(?:SERVLET|URI|STATUS):|$)/i,
  )?.[1];
  return jettyMessage?.trim() || readable;
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replaceAll(/&nbsp;/gi, " ")
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&#39;|&apos;/gi, "'")
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")
    .replaceAll(/&amp;/gi, "&");
}

function truncateErrorDetail(value: string): string {
  const safeValue = Array.from(value.replace(ANSI_TERMINAL_SEQUENCE, ""))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join("");
  if (safeValue.length <= MAX_JENKINS_ERROR_DETAIL_LENGTH) {
    return safeValue;
  }
  return `${safeValue.slice(0, MAX_JENKINS_ERROR_DETAIL_LENGTH - 1)}…`;
}

function normalizeJob(job: JenkinsApiJob): JenkinsJob | null {
  if (typeof job.name !== "string" || typeof job.url !== "string") {
    return null;
  }
  return {
    name: job.name,
    fullName: typeof job.fullName === "string" ? job.fullName : undefined,
    url: job.url,
    ...(typeof job.disabled === "boolean" ? { disabled: job.disabled } : {}),
    // An absent `lastBuild` key means Jenkins did not report activity at all;
    // keep it absent so the state stays "unknown" rather than "never built".
    ...(job.lastBuild === undefined
      ? {}
      : { lastBuild: normalizeJobLastBuild(job.lastBuild) }),
  };
}

function normalizeJobLastBuild(
  build: JenkinsApiBuild | null,
): JenkinsJobLastBuild | null {
  if (
    !build ||
    typeof build.number !== "number" ||
    !Number.isInteger(build.number) ||
    build.number < 0 ||
    typeof build.url !== "string" ||
    !build.url.trim()
  ) {
    return null;
  }
  return {
    number: build.number,
    url: build.url,
    ...(build.result === undefined ? {} : { result: build.result }),
    ...(typeof build.building === "boolean"
      ? { building: build.building }
      : {}),
    ...(typeof build.timestamp === "number"
      ? { timestampMs: build.timestamp }
      : {}),
    ...(typeof build.duration === "number"
      ? { durationMs: build.duration }
      : {}),
    ...(typeof build.estimatedDuration === "number"
      ? { estimatedDurationMs: build.estimatedDuration }
      : {}),
  };
}

function normalizeRunningBuild(job: JenkinsApiJob): RunningBuildSummary | null {
  const lastBuild = job.lastBuild;
  if (
    typeof job.name !== "string" ||
    !job.name.trim() ||
    typeof job.url !== "string" ||
    !isValidHttpUrl(job.url) ||
    lastBuild?.building !== true ||
    typeof lastBuild.number !== "number" ||
    !Number.isInteger(lastBuild.number) ||
    lastBuild.number < 0 ||
    typeof lastBuild.url !== "string" ||
    !isValidHttpUrl(lastBuild.url)
  ) {
    return null;
  }

  return {
    jobName: job.name,
    fullJobName:
      typeof job.fullName === "string" && job.fullName.trim()
        ? job.fullName
        : undefined,
    jobUrl: job.url,
    buildNumber: lastBuild.number,
    buildUrl: lastBuild.url,
  };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeNodeSummary(computer: JenkinsApiComputer): NodeSummary {
  const executors = Array.isArray(computer.executors) ? computer.executors : [];
  const oneOffExecutors = Array.isArray(computer.oneOffExecutors)
    ? computer.oneOffExecutors
    : [];
  const busyExecutors = [...executors, ...oneOffExecutors].filter((executor) =>
    Boolean(executor?.currentExecutable),
  ).length;
  const numExecutors =
    typeof computer.numExecutors === "number" && computer.numExecutors >= 0
      ? computer.numExecutors
      : executors.length;
  const totalExecutors = Math.max(numExecutors, busyExecutors);
  const labels = Array.isArray(computer.assignedLabels)
    ? computer.assignedLabels
        .map((label) => (typeof label?.name === "string" ? label.name : ""))
        .filter((name) => name.length > 0)
    : [];
  const offlineCauseReason = computer.offlineCauseReason?.trim();

  return {
    displayName:
      typeof computer.displayName === "string" && computer.displayName.trim()
        ? computer.displayName
        : "(unknown)",
    offline: computer.offline === true,
    temporarilyOffline: computer.temporarilyOffline === true,
    ...(offlineCauseReason ? { offlineCauseReason } : {}),
    numExecutors,
    busyExecutors,
    totalExecutors,
    labels,
  };
}
