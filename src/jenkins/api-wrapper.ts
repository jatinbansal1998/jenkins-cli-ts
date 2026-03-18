/**
 * Jenkins REST API client.
 * Handles authentication, CSRF crumbs, and provides methods for
 * listing jobs, fetching status, and triggering builds.
 */
import { CliError } from "../cli";
import { recordJenkinsApiCall, recordJenkinsApiFailure } from "../analytics";
import { ENV_KEYS } from "../env-keys";
import {
  logApiRequest,
  logApiResponse,
  logApiError,
  logNetworkError,
} from "../logger";
import type {
  BuildHistoryEntry,
  BuildHistoryPage,
  BuildStatus,
  ConsoleChunk,
  Crumb,
  JenkinsApiBuild,
  JenkinsApiBuildAction,
  JenkinsApiBuildsResponse,
  JenkinsApiJob,
  JenkinsPipelineNodeResponse,
  JenkinsApiQueueItem,
  JenkinsBuildFailure,
  JenkinsBuildParameter,
  JenkinsClientOptions,
  JenkinsCrumbResponse,
  JenkinsJob,
  JenkinsJobsResponse,
  JenkinsJobStatusResponse,
  JenkinsLastFailedBuildResponse,
  JenkinsPipelineDescribeResponse,
  JenkinsQueueItemsResponse,
  JenkinsQueueWaitTimeResponse,
  JobStatus,
  LastFailedBuildReference,
  PipelineInfo,
  QueueBuildReference,
  QueueItemSummary,
  TriggerBuildParams,
  TriggerBuildResult,
} from "../types/jenkins";

export type {
  BuildHistoryEntry,
  BuildHistoryPage,
  BuildStatus,
  ConsoleChunk,
  JenkinsClientOptions,
  JenkinsJob,
  JobStatus,
  QueueBuildReference,
  QueueItemSummary,
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
    this.folderDepth = options.folderDepth ?? DEFAULT_FOLDER_DEPTH;
  }

  async listJobs(): Promise<JenkinsJob[]> {
    const treeFields = buildFolderTree(FOLDER_LEAF_FIELDS, this.folderDepth);
    const url = this.withBase(`api/json?tree=jobs[${treeFields}]`);
    const data = await this.requestJson<JenkinsJobsResponse>(url, "list jobs");
    if (!Array.isArray(data.jobs)) {
      throw new CliError("Unexpected Jenkins response when listing jobs.", [
        "Try `jenkins-cli list --refresh` again.",
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

  async getJobStatus(jobUrl: string): Promise<JobStatus> {
    const url = this.withJob(
      jobUrl,
      "api/json?tree=lastBuild[number,url,result,building,timestamp,duration,estimatedDuration]",
    );
    const data = await this.requestJson<JenkinsJobStatusResponse>(
      url,
      "job status",
    );

    const lastBuild = data.lastBuild;
    if (!lastBuild) {
      return {};
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
    const parameters = extractBuildParameters(buildDetails?.actions);
    const branch = extractBranchParam(parameters);

    return {
      lastBuildNumber: lastBuild.number,
      lastBuildUrl: lastBuild.url,
      result: lastBuild.result ?? null,
      building: lastBuild.building ?? false,
      lastBuildTimestamp: lastBuild.timestamp,
      lastBuildDurationMs: lastBuild.duration,
      lastBuildEstimatedDurationMs: lastBuild.estimatedDuration,
      queueTimeMs,
      parameters,
      branch,
      stages: pipeline?.stages,
    };
  }

  async getBuildStatus(buildUrl: string): Promise<BuildStatus> {
    const url = this.withJob(
      buildUrl,
      "api/json?tree=number,url,result,building,timestamp,duration,estimatedDuration,queueId,actions[parameters[name,value]]",
    );
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
    const parameters = extractBuildParameters(buildDetails.actions);
    const branch = extractBranchParam(parameters);

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
      stages: pipeline?.stages,
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
      "api/json?tree=builds[number,url,result,building,timestamp,duration,estimatedDuration,actions[parameters[name,value]]]",
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
    const normalizedStart =
      Number.isFinite(start) && start > 0 ? Math.floor(start) : 0;
    const url = new URL(this.withJob(buildUrl, "logText/progressiveText"));
    url.searchParams.set("start", String(normalizedStart));

    const response = await this.fetchWithTimeout(
      url.toString(),
      { method: "GET", headers: this.authHeaders() },
      1,
      "fetch build logs",
    );
    if (!response.ok) {
      recordJenkinsApiFailure({
        operation: "fetch_build_logs",
        errorType: "http_error",
        httpStatus: response.status,
      });
      await this.raiseHttpError(response, "fetch build logs");
    }

    const text = await response.text();
    const textSizeHeader = response.headers.get("x-text-size");
    const parsedNextStart = textSizeHeader
      ? Number(textSizeHeader)
      : Number.NaN;
    const nextStart = Number.isFinite(parsedNextStart)
      ? parsedNextStart
      : normalizedStart + text.length;
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
    const requestBody = this.serializeRequestBody(options.body);
    recordJenkinsApiCall();
    logApiRequest(method, url, options.headers, requestBody);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      const responseBody = await this.readResponseBody(response);
      if (response.ok) {
        logApiResponse(
          method,
          url,
          response.status,
          response.headers,
          responseBody,
        );
      } else {
        logApiError(
          method,
          url,
          response.status,
          response.headers,
          responseBody,
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
      clearTimeout(timeout);
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

  private async readResponseBody(response: Response): Promise<string | null> {
    try {
      return await response.clone().text();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return `[unreadable body: ${message}]`;
    }
  }

  private async raiseHttpError(
    response: Response,
    context: string,
  ): Promise<never> {
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new CliError(
        `Jenkins rejected the request while trying to ${context}.`,
        [
          `Check ${ENV_KEYS.JENKINS_USER} and ${ENV_KEYS.JENKINS_API_TOKEN}.`,
          `Confirm you can access ${this.baseUrl} in a browser.`,
          `If your Jenkins requires CSRF crumbs, set ${ENV_KEYS.JENKINS_USE_CRUMB}=true or useCrumb: true in config.`,
        ],
      );
    }
    if (status === 404) {
      throw new CliError(`Resource not found while trying to ${context}.`, [
        `Verify ${ENV_KEYS.JENKINS_URL} and job URL are correct.`,
      ]);
    }

    throw new CliError(
      `Jenkins returned HTTP ${status} while trying to ${context}.`,
      ["Try again, or check the Jenkins server logs."],
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
    const url = this.withJob(
      buildUrl,
      "api/json?tree=number,url,result,building,timestamp,duration,estimatedDuration,queueId,actions[parameters[name,value]]",
    );
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

const CLOUDBEES_FOLDER_CLASS = "com.cloudbees.hudson.plugins.folder.Folder";

const FOLDER_LEAF_FIELDS = "_class,name,fullName,url";
const DEFAULT_FOLDER_DEPTH = 3;

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

function extractBranchParam(
  params: JenkinsBuildParameter[] | undefined,
): string | undefined {
  const normalizedParams = params ?? [];
  if (normalizedParams.length === 0) {
    return undefined;
  }
  const candidates = [
    "BRANCH",
    "BRANCH_TAG",
    "GIT_BRANCH",
    "BRANCH_NAME",
    "REF",
    "TAG",
  ];
  for (const key of candidates) {
    const match = normalizedParams.find(
      (param) => param.name === key && param.value,
    );
    if (match) {
      return match.value;
    }
  }
  const fallback = normalizedParams.find(
    (param) => param.name.toLowerCase().includes("branch") && param.value,
  );
  return fallback?.value;
}

function normalizeBuildHistoryEntry(
  build: JenkinsApiBuild,
): BuildHistoryEntry | null {
  const buildUrl = typeof build.url === "string" ? build.url : "";
  if (!buildUrl) {
    return null;
  }
  const parameters = extractBuildParameters(build.actions);
  return {
    buildNumber: build.number,
    buildUrl,
    result: build.result ?? null,
    building: build.building ?? false,
    timestampMs: build.timestamp,
    durationMs: build.duration,
    estimatedDurationMs: build.estimatedDuration,
    parameters,
    branch: extractBranchParam(parameters),
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

function normalizeJob(job: JenkinsApiJob): JenkinsJob | null {
  if (typeof job.name !== "string" || typeof job.url !== "string") {
    return null;
  }
  return {
    name: job.name,
    fullName: typeof job.fullName === "string" ? job.fullName : undefined,
    url: job.url,
  };
}
