/**
 * Jenkins REST API client.
 * Handles authentication, CSRF crumbs, and provides methods for
 * listing jobs, fetching status, and triggering builds.
 */
import { CliError } from "../cli";
import { logApiRequest, logApiResponse, logApiError, logNetworkError } from "../logger";

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
    const data = await this.requestJson<{ jobs?: JenkinsJob[] }>(url, "list jobs");
    if (!Array.isArray(data.jobs)) {
      throw new CliError("Unexpected Jenkins response when listing jobs.", [
        "Try `jenkins-cli list --refresh` again.",
      ]);
    }
    return data.jobs;
  }

  async getJobStatus(jobUrl: string): Promise<JobStatus> {
    const url = this.withJob(jobUrl, "api/json?tree=lastBuild[number,url,result,building]");
    const data = await this.requestJson<{
      lastBuild?: {
        number?: number;
        url?: string;
        result?: string | null;
        building?: boolean;
      };
    }>(url, "job status");

    const lastBuild = data.lastBuild;
    if (!lastBuild) {
      return {};
    }

    return {
      lastBuildNumber: lastBuild.number,
      lastBuildUrl: lastBuild.url,
      result: lastBuild.result ?? null,
      building: lastBuild.building ?? false,
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
    logApiRequest(method, url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok) {
        logApiResponse(method, url, response.status);
      } else {
        logApiError(method, url, response.status);
      }
      return response;
    } catch (error) {
      if (retriesLeft > 0) {
        return this.fetchWithTimeout(
          url,
          options,
          retriesLeft - 1,
          context,
        );
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

  private async raiseHttpError(response: Response, context: string): Promise<never> {
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new CliError(`Jenkins rejected the request while trying to ${context}.`, [
        "Check JENKINS_USER and JENKINS_API_TOKEN.",
        `Confirm you can access ${this.baseUrl} in a browser.`,
      ]);
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
}
