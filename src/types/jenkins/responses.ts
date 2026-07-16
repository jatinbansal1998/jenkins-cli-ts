/**
 * Raw Jenkins API response payloads (wire format).
 */

export type JenkinsApiJob = {
  _class?: string;
  name?: string;
  fullName?: string;
  url?: string;
  jobs?: JenkinsApiJob[];
  lastBuild?: JenkinsApiBuild | null;
};

export type JenkinsJobsResponse = {
  jobs?: JenkinsApiJob[];
};

export type JenkinsApiDefaultParameterValue = {
  value?: unknown;
};

export type JenkinsApiParameterDefinition = {
  _class?: string;
  type?: string;
  name?: string;
  description?: string | null;
  defaultParameterValue?: JenkinsApiDefaultParameterValue | null;
  defaultValue?: unknown;
  choices?: unknown;
};

export type JenkinsApiJobProperty = {
  _class?: string;
  parameterDefinitions?: JenkinsApiParameterDefinition[];
};

export type JenkinsJobParametersResponse = {
  property?: JenkinsApiJobProperty[];
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

export type JenkinsApiBuildsResponse = {
  builds?: JenkinsApiBuild[];
};

export type JenkinsApiArtifact = {
  fileName?: string;
  relativePath?: string;
  displayPath?: string;
};

export type JenkinsBuildArtifactsResponse = {
  number?: number;
  url?: string;
  artifacts?: JenkinsApiArtifact[];
};

export type JenkinsLastCompletedBuildResponse = {
  lastCompletedBuild?: {
    number?: number;
    url?: string;
  };
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

export type JenkinsApiComputerExecutable = {
  url?: string;
  number?: number;
};

export type JenkinsApiComputerExecutor = {
  idle?: boolean;
  currentExecutable?: JenkinsApiComputerExecutable | null;
};

export type JenkinsApiComputerLabel = {
  name?: string;
};

export type JenkinsApiComputer = {
  displayName?: string;
  offline?: boolean;
  temporarilyOffline?: boolean;
  offlineCauseReason?: string;
  numExecutors?: number;
  assignedLabels?: JenkinsApiComputerLabel[];
  executors?: JenkinsApiComputerExecutor[];
  oneOffExecutors?: JenkinsApiComputerExecutor[];
};

export type JenkinsComputerResponse = {
  busyExecutors?: number;
  totalExecutors?: number;
  computer?: JenkinsApiComputer[];
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

export type JenkinsPipelineLinkResponse = {
  href?: string;
};

export type JenkinsPipelineNodeErrorResponse = {
  type?: string;
  message?: string;
};

export type JenkinsPipelineNodeLogResponse = {
  text?: string;
  length?: number;
  hasMore?: boolean;
};

export type JenkinsPipelineNodeResponse = {
  id?: string | number;
  name?: string;
  status?: string;
  error?: JenkinsPipelineNodeErrorResponse;
  _links?: {
    self?: JenkinsPipelineLinkResponse;
    log?: JenkinsPipelineLinkResponse;
  };
  stageFlowNodes?: JenkinsPipelineNodeResponse[];
};

export type JenkinsPipelineStageResponse = {
  name?: string;
  id?: string | number;
  execNode?: string;
  status?: string;
  startTimeMillis?: number;
  durationMillis?: number;
  pauseDurationMillis?: number;
  _links?: {
    self?: JenkinsPipelineLinkResponse;
    log?: JenkinsPipelineLinkResponse;
  };
  stageFlowNodes?: JenkinsPipelineNodeResponse[];
};

export type JenkinsPipelineDescribeResponse = {
  _links?: {
    self?: JenkinsPipelineLinkResponse;
    changesets?: JenkinsPipelineLinkResponse;
  };
  id?: string | number;
  name?: string;
  status?: string;
  startTimeMillis?: number;
  endTimeMillis?: number;
  durationMillis?: number;
  pauseDurationMillis?: number;
  stages?: JenkinsPipelineStageResponse[];
  queueDurationMillis?: number;
};
