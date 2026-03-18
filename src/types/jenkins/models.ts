/**
 * Normalized Jenkins domain models used throughout the CLI.
 */

export type JenkinsBuildParameter = {
  name: string;
  value: string;
};

export type JenkinsPipelineLinks = {
  self?: { href?: string };
  log?: { href?: string };
  changesets?: { href?: string };
};

export type JenkinsPipelineStage = {
  _links?: JenkinsPipelineLinks;
  id?: string | number;
  name?: string;
  execNode?: string;
  status?: string;
  startTimeMillis?: number;
  durationMillis?: number;
  pauseDurationMillis?: number;
};

export type JenkinsBuildFailure = {
  stageName?: string;
  stepName?: string;
  reason?: string;
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
  stages?: JenkinsPipelineStage[];
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
  stages?: JenkinsPipelineStage[];
};

export type BuildHistoryEntry = {
  buildNumber?: number;
  buildUrl: string;
  result?: string | null;
  building?: boolean;
  timestampMs?: number;
  durationMs?: number;
  estimatedDurationMs?: number;
  parameters?: JenkinsBuildParameter[];
  branch?: string;
  stages?: JenkinsPipelineStage[];
  failure?: JenkinsBuildFailure;
};

export type BuildHistoryPage = {
  builds: BuildHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
  hasNext: boolean;
  hasPrevious: boolean;
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
  _links?: JenkinsPipelineLinks;
  id?: string | number;
  name?: string;
  status?: string;
  startTimeMillis?: number;
  endTimeMillis?: number;
  durationMillis?: number;
  queueDurationMillis?: number;
  pauseDurationMillis?: number;
  stages?: JenkinsPipelineStage[];
  failure?: JenkinsBuildFailure;
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
  useCrumb?: boolean;
  folderDepth?: number;
};
