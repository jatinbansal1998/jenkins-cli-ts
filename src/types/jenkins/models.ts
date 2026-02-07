/**
 * Normalized Jenkins domain models used throughout the CLI.
 */

export type JenkinsBuildParameter = {
  name: string;
  value: string;
};

export type JenkinsPipelineStage = {
  name?: string;
  status?: string;
};

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
  parameters?: JenkinsBuildParameter[];
  branch?: string;
  stage?: JenkinsPipelineStage;
};

export type BuildStatus = {
  buildNumber?: number;
  buildUrl?: string;
  result?: string | null;
  building?: boolean;
  timestampMs?: number;
  durationMs?: number;
  estimatedDurationMs?: number;
  queueTimeMs?: number;
  parameters?: JenkinsBuildParameter[];
  branch?: string;
  stage?: JenkinsPipelineStage;
};

export type QueueItemSummary = {
  id: number;
  queueUrl: string;
  jobName?: string;
  jobUrl?: string;
  reason?: string;
  inQueueSince?: number;
  blocked?: boolean;
  buildable?: boolean;
  stuck?: boolean;
};

export type QueueBuildReference = {
  buildUrl?: string;
  buildNumber?: number;
};

export type LastFailedBuildReference = {
  buildUrl: string;
  buildNumber?: number;
};

export type ConsoleChunk = {
  text: string;
  nextStart: number;
  hasMore: boolean;
};

export type TriggerBuildResult = {
  queueUrl?: string;
  queueId?: number;
  jobUrl?: string;
  buildUrl?: string;
  buildNumber?: number;
};

export type PipelineInfo = {
  stage?: JenkinsPipelineStage;
  queueDurationMs?: number;
};

export type Crumb = {
  field: string;
  value: string;
};

export type JenkinsClientOptions = {
  baseUrl: string;
  user: string;
  apiToken: string;
  timeoutMs?: number;
};
