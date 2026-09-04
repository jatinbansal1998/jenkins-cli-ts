/**
 * Normalized Jenkins domain models used throughout the CLI.
 */

export type JenkinsBuildParameter = {
  name: string;
  value: string;
};

export type JenkinsRevision = {
  /** Basename of remoteUrl; a convenience label that can collide. */
  repo?: string;
  /** First remote URL Jenkins reported; omitted when it reported none. */
  remoteUrl?: string;
  remoteUrls: string[];
  branch?: string;
  sha: string;
};

export type JobParameterType =
  "string" | "text" | "boolean" | "choice" | "password" | "unknown";

/** Stable parameter metadata independent of Jenkins' plugin-specific JSON. */
export type JobParameterDefinition = {
  name: string;
  type: JobParameterType;
  description?: string;
  defaultValue?: string | boolean;
  choices?: string[];
  sensitive: boolean;
  jenkinsClass?: string;
};

type JenkinsPipelineLinks = {
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
  parentNodes?: Array<string | number>;
};

export type JenkinsBuildFailure = {
  stageName?: string;
  stepName?: string;
  reason?: string;
};

/** Last build of a job as returned by bulk job discovery. */
export type JenkinsJobLastBuild = {
  number: number;
  url: string;
  result?: string | null;
  building?: boolean;
  timestampMs?: number;
  durationMs?: number;
  estimatedDurationMs?: number;
};

/**
 * Jenkins job metadata. `disabled` and `lastBuild` are absent when the activity
 * state is unknown (for example a cache written before they were collected);
 * `lastBuild: null` means Jenkins reported the job has never been built.
 */
export type JenkinsJob = {
  name: string;
  fullName?: string;
  url: string;
  disabled?: boolean;
  lastBuild?: JenkinsJobLastBuild | null;
};

export type RunningBuildSummary = {
  jobName: string;
  fullJobName?: string;
  jobUrl: string;
  buildNumber: number;
  buildUrl: string;
};

/**
 * Normalized Jenkins build. The single shape shared by build status, job
 * status (the job's last build), and history entries — add new build fields
 * here once.
 */
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
  revisions?: JenkinsRevision[];
  stages?: JenkinsPipelineStage[];
  triggeredBy?: string;
};

/** A job's last build plus job-level state. */
export type JobStatus = BuildStatus & {
  disabled?: boolean;
};

export type ArtifactEntry = {
  fileName: string;
  relativePath: string;
};

export type BuildArtifacts = {
  buildNumber?: number;
  buildUrl: string;
  artifacts: ArtifactEntry[];
};

export type TestFailure = {
  suite?: string;
  className?: string;
  name: string;
  durationMs?: number;
  message?: string;
  stackTrace?: string;
};

export type BuildTestReport = {
  buildNumber?: number;
  buildUrl: string;
  buildResult?: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs?: number;
  reportUrl: string;
  failures?: TestFailure[];
};

/** Stable trigger-cause names; raw Jenkins `_class` values map to these. */
export type BuildCauseType =
  | "user"
  | "upstream"
  | "timer"
  | "scm"
  | "remote"
  | "replay"
  | "rebuild"
  | "cli"
  | "other";

export type BuildCause = {
  type: BuildCauseType;
  /** Jenkins' short description, e.g. "Started by user Jane". */
  summary?: string;
  userId?: string;
  userName?: string;
  upstreamJob?: string;
  upstreamBuild?: number;
};

export type BuildChange = {
  /** Revision id (commit SHA, SVN revision, …) when the plugin reports one. */
  id?: string;
  author?: string;
  timestampMs?: number;
  /** Full commit message; multiline text is preserved. */
  message?: string;
  /** Affected paths; present only when explicitly requested. */
  paths?: string[];
  /** True when Jenkins holds more paths than the CLI's per-change cap. */
  pathsTruncated?: boolean;
};

export type BuildChangeSet = {
  /** Change-set kind as Jenkins reports it (e.g. "git"), or "unknown". */
  sourceType: string;
  /** Checkout metadata when the change set matches Jenkins Git BuildData. */
  revision?: JenkinsRevision;
  changes: BuildChange[];
};

export type BuildChangesReport = {
  buildNumber?: number;
  buildUrl: string;
  causes: BuildCause[];
  changeSets: BuildChangeSet[];
  limit: number;
  returned: number;
  /** Total changes in the build; known only when nothing was truncated. */
  total?: number;
  truncated: boolean;
};

export type BuildHistoryEntry = BuildStatus & {
  buildUrl: string;
  failure?: JenkinsBuildFailure;
};

export type BuildHistoryPage = {
  builds: BuildHistoryEntry[];
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

export type NodeSummary = {
  displayName: string;
  offline: boolean;
  temporarilyOffline: boolean;
  offlineCauseReason?: string;
  numExecutors: number;
  busyExecutors: number;
  totalExecutors: number;
  labels: string[];
};

export type NodesSummary = {
  nodes: NodeSummary[];
  totalNodes: number;
  offlineNodes: number;
  busyExecutors: number;
  totalExecutors: number;
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
