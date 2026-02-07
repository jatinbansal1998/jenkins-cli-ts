/**
 * Raw Jenkins API response payloads (wire format).
 */

export type JenkinsApiJob = {
  name?: string;
  fullName?: string;
  url?: string;
};

export type JenkinsJobsResponse = {
  jobs?: JenkinsApiJob[];
};

export type JenkinsApiBuildParameter = {
  name?: string;
  value?: unknown;
};

export type JenkinsApiBuildAction = {
  parameters?: JenkinsApiBuildParameter[];
};

export type JenkinsApiBuild = {
  number?: number;
  url?: string;
  result?: string | null;
  building?: boolean;
  timestamp?: number;
  duration?: number;
  estimatedDuration?: number;
  queueId?: number;
  actions?: JenkinsApiBuildAction[];
};

export type JenkinsJobStatusResponse = {
  lastBuild?: JenkinsApiBuild;
};

export type JenkinsApiQueueTask = {
  name?: string;
  url?: string;
};

export type JenkinsApiQueueExecutable = {
  number?: number;
  url?: string;
};

export type JenkinsApiQueueItem = {
  id?: number;
  url?: string;
  why?: string;
  inQueueSince?: number;
  blocked?: boolean;
  buildable?: boolean;
  stuck?: boolean;
  cancelled?: boolean;
  task?: JenkinsApiQueueTask;
  executable?: JenkinsApiQueueExecutable;
};

export type JenkinsQueueItemsResponse = {
  items?: JenkinsApiQueueItem[];
};

export type JenkinsCrumbResponse = {
  crumbRequestField?: string;
  crumb?: string;
};

export type JenkinsLastFailedBuildResponse = {
  lastFailedBuild?: {
    url?: string;
    number?: number;
  };
};

export type JenkinsQueueWaitTimeResponse = {
  inQueueSince?: number;
};

export type JenkinsPipelineStageResponse = {
  name?: string;
  status?: string;
};

export type JenkinsPipelineDescribeResponse = {
  stages?: JenkinsPipelineStageResponse[];
  queueDurationMillis?: number;
};
