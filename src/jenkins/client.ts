/**
 * Jenkins REST API client.
 * Handles authentication, CSRF crumbs, and provides methods for
 * listing jobs, fetching status, and triggering builds.
 */
import { CliError } from "../cli";
import {
  logApiRequest,
  logApiResponse,
  logApiError,
  logNetworkError,
} from "../logger";

/** Jenkins job metadata. */
export type JenkinsJob = {
  name: string;
  fullName?: string;
  url: string;
};

export type JobStatus = {
  lastBuildNumber?: number;
  lastBuildUrl?: string;
  result?: string | null;
  building?: boolean;
  lastBuildTimestamp?: number;
  lastBuildDurationMs?: number;
  lastBuildEstimatedDurationMs?: number;
  queueTimeMs?: number;
  parameters?: { name: string; value: string }[];
  branch?: string;
  stage?: {
    name?: string;
    status?: string;
  };
};

type BuildAction = {
  parameters?: { name?: string; value?: unknown }[];
};

type BuildDetails = {
  number?: number;
  url?: string;
  result?: string | null;
  building?: boolean;
  timestamp?: number;
  duration?: number;
  estimatedDuration?: number;
  queueId?: number;
  actions?: BuildAction[];
};

type PipelineInfo = {
  stage?: { name?: string; status?: string };
  queueDurationMs?: number;
};

type Crumb = {
  field: string;
  value: string;
};

type JenkinsClientOptions = {
  baseUrl: string;
  user: string;
  apiToken: string;
  timeoutMs?: number;
};

export class JenkinsClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private crumbCache?: Crumb;

  constructor(options: JenkinsClientOptions) {
    this.baseUrl = options.baseUrl;
    const token = Buffer.from(`${options.user}:${options.apiToken}`).toString(
      "base64",
    );
    this.authHeader = `Basic ${token}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async listJobs(): Promise<JenkinsJob[]> {
    const url = this.withBase("api/json?tree=jobs[name,fullName,url]");
    const data = await this.requestJson<{ jobs?: JenkinsJob[] }>(
      url,
      "list jobs",
    );
    if (!Array.isArray(data.jobs)) {
      throw new CliError("Unexpected Jenkins response when listing jobs.", [
        "Try `jenkins-cli list --refresh` again.",
      ]);
    }
    return data.jobs;
  }

  async getJobStatus(jobUrl: string): Promise<JobStatus> {
    const url = this.withJob(
      jobUrl,
      "api/json?tree=lastBuild[number,url,result,building,timestamp,duration,estimatedDuration]",
    );
    const data = await this.requestJson<{
      lastBuild?: BuildDetails;
    }>(url, "job status");

    const lastBuild = data.lastBuild;
    if (!lastBuild) {
      return {};
    }

    const buildUrl = lastBuild.url;
    const buildDetails = buildUrl ? await this.getBuildDetails(buildUrl) : null;
    const pipeline = buildUrl ? await this.getPipelineInfo(buildUrl) : null;
    const queueTimeMs =
      typeof pipeline?.queueDurationMs === "number" &&
      pipeline.queueDurationMs >= 0
        ? pipeline.queueDurationMs
        : buildDetails?.queueId && lastBuild.timestamp
          ? await this.getQueueWaitTimeMs(
              buildDetails.queueId,
              lastBuild.timestamp,
            )
          : undefined;
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
      stage: pipeline?.stage,
    };
  }

  async triggerBuild(
    jobUrl: string,
    params: Record<string, string>,
  ): Promise<{ queueUrl?: string }> {
    const crumb = await this.getCrumb();
    const url = this.withJob(jobUrl, "buildWithParameters");
    const body = new URLSearchParams(params).toString();

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (crumb) {
      headers[crumb.field] = crumb.value;
    }

    const response = await this.fetchWithTimeout(
      url,
      { method: "POST", headers, body },
      1,
      "trigger build",
    );

    if (!response.ok) {
      await this.raiseHttpError(response, "trigger build");
    }

    return { queueUrl: response.headers.get("location") ?? undefined };
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
      await this.raiseHttpError(response, "fetch crumb");
    }

    const data = (await response.json()) as {
      crumbRequestField?: string;
      crumb?: string;
    };

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
      await this.raiseHttpError(response, context);
    }

    try {
      return (await response.json()) as T;
    } catch {
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
  ): Promise<Response> {
    const method = options.method ?? "GET";
    const requestBody = this.serializeRequestBody(options.body);
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
        return this.fetchWithTimeout(url, options, retriesLeft - 1, context);
      }

      if (error instanceof Error && error.name === "AbortError") {
        logNetworkError(method, url, "TIMEOUT");
        throw new CliError(`Request timed out while trying to ${context}.`, [
          `Check your network and that ${this.baseUrl} is reachable.`,
        ]);
      }

      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logNetworkError(method, url, errorMsg);
      throw new CliError(`Network error while trying to ${context}.`, [
        `Check your network and that ${this.baseUrl} is reachable.`,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private serializeRequestBody(
    body: BodyInit | null | undefined,
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
        entries.push(`${key}=${typeof value === "string" ? value : "<file>"}`);
      }
      return entries.join("&");
    }
    if (body instanceof Blob) {
      return `<blob size=${body.size} type=${body.type || "unknown"}>`;
    }
    if (body instanceof ArrayBuffer) {
      return `<arraybuffer byteLength=${body.byteLength}>`;
    }
    if (ArrayBuffer.isView(body)) {
      return `<binary byteLength=${body.byteLength}>`;
    }
    return `<body type=${typeof body}>`;
  }

  private async readResponseBody(response: Response): Promise<string | null> {
    try {
      return await response.clone().text();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return `<unreadable body: ${message}>`;
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
          "Check JENKINS_USER and JENKINS_API_TOKEN.",
          `Confirm you can access ${this.baseUrl} in a browser.`,
        ],
      );
    }
    if (status === 404) {
      throw new CliError(`Resource not found while trying to ${context}.`, [
        "Verify JENKINS_URL and job URL are correct.",
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

  private async getBuildDetails(
    buildUrl: string,
  ): Promise<BuildDetails | null> {
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
      return (await response.json()) as BuildDetails;
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
      const data = (await response.json()) as { inQueueSince?: number };
      if (typeof data.inQueueSince !== "number") {
        return undefined;
      }
      const wait = startTimestamp - data.inQueueSince;
      return wait >= 0 ? wait : undefined;
    } catch {
      return undefined;
    }
  }

  private async getPipelineInfo(
    buildUrl: string,
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
      const data = (await response.json()) as {
        stages?: { name?: string; status?: string }[];
        queueDurationMillis?: number;
      };
      const stages = Array.isArray(data.stages) ? data.stages : [];
      const activeStage = stages.find(
        (stage) =>
          stage.status === "IN_PROGRESS" ||
          stage.status === "PAUSED_PENDING_INPUT",
      );
      const stage = activeStage ?? stages[stages.length - 1];
      return {
        stage,
        queueDurationMs: data.queueDurationMillis,
      };
    } catch {
      return null;
    }
  }
}

function extractBuildParameters(
  actions?: BuildAction[],
): { name: string; value: string }[] | undefined {
  if (!Array.isArray(actions)) {
    return undefined;
  }
  const params: { name: string; value: string }[] = [];
  for (const action of actions) {
    if (!action || !Array.isArray(action.parameters)) {
      continue;
    }
    for (const param of action.parameters) {
      if (!param || typeof param.name !== "string") {
        continue;
      }
      const value =
        param.value === null || param.value === undefined
          ? ""
          : String(param.value);
      params.push({ name: param.name, value });
    }
  }
  return params.length > 0 ? params : undefined;
}

function extractBranchParam(
  params: { name: string; value: string }[] | undefined,
): string | undefined {
  if (!params || params.length === 0) {
    return undefined;
  }
  const candidates = ["BRANCH", "GIT_BRANCH", "BRANCH_NAME", "REF", "TAG"];
  for (const key of candidates) {
    const match = params.find((param) => param.name === key && param.value);
    if (match) {
      return match.value;
    }
  }
  const fallback = params.find(
    (param) => param.name.toLowerCase().includes("branch") && param.value,
  );
  return fallback?.value;
}
