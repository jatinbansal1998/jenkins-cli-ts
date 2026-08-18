/**
 * Raw Jenkins API response payloads (wire format).
 */

export type JenkinsApiJob = {
  _class?: string;
  name?: string;
  fullName?: string;
  url?: string;
  disabled?: boolean;
  jobs?: JenkinsApiJob[];
  lastBuild?: JenkinsApiBuild | null;
};

export type JenkinsJobsResponse = {
  jobs?: JenkinsApiJob[];
};

type JenkinsApiDefaultParameterValue = {
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

type JenkinsApiJobProperty = {
  _class?: string;
  parameterDefinitions?: JenkinsApiParameterDefinition[];
};

export type JenkinsJobParametersResponse = {
  property?: JenkinsApiJobProperty[];
};

type JenkinsApiBuildParameter = {
  name?: string;
  value?: unknown;
};

type JenkinsApiGitBranch = {
  name?: string;
};

type JenkinsApiGitRevision = {
  SHA1?: string;
  branch?: JenkinsApiGitBranch[];
};

type JenkinsApiBuildCause = {
  shortDescription?: string;
  userId?: string;
  userName?: string;
};

export type JenkinsApiBuildAction = {
  _class?: string;
  parameters?: JenkinsApiBuildParameter[];
  lastBuiltRevision?: JenkinsApiGitRevision;
  remoteUrls?: string[];
  causes?: JenkinsApiBuildCause[];
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
  lastBuild?: { number?: number };
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

type JenkinsApiTestCase = {
  className?: string;
  name?: string;
  status?: string;
  duration?: number | null;
  errorDetails?: string | null;
  errorStackTrace?: string | null;
};

export type JenkinsApiTestSuite = {
  name?: string;
  cases?: JenkinsApiTestCase[];
};

export type JenkinsTestReportResponse = {
  failCount?: number;
  passCount?: number;
  skipCount?: number;
  totalCount?: number;
  duration?: number | null;
  suites?: JenkinsApiTestSuite[];
  childReports?: JenkinsApiChildTestReport[];
};

type JenkinsApiChildTestReport = {
  result?: {
    suites?: JenkinsApiTestSuite[];
  };
};

export type JenkinsLastCompletedBuildResponse = {
  lastCompletedBuild?: {
    number?: number;
    url?: string;
  };
};

export type JenkinsJobStatusResponse = {
  disabled?: boolean;
  lastBuild?: JenkinsApiBuild;
};

type JenkinsApiQueueTask = {
  name?: string;
  url?: string;
};

type JenkinsApiQueueExecutable = {
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

type JenkinsApiComputerExecutable = {
  url?: string;
  number?: number;
};

type JenkinsApiComputerExecutor = {
  idle?: boolean;
  currentExecutable?: JenkinsApiComputerExecutable | null;
};

type JenkinsApiComputerLabel = {
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

type JenkinsPipelineLinkResponse = {
  href?: string;
};

type JenkinsPipelineNodeErrorResponse = {
  type?: string;
  message?: string;
};

export type JenkinsPipelineNodeLogResponse = {
  nodeId?: string;
  nodeStatus?: string;
  text?: string;
  length?: number;
  hasMore?: boolean;
  consoleUrl?: string;
};

export type JenkinsPipelineNodeResponse = {
  id?: string | number;
  name?: string;
  status?: string;
  error?: JenkinsPipelineNodeErrorResponse;
  startTimeMillis?: number;
  durationMillis?: number;
  pauseDurationMillis?: number;
  parentNodes?: Array<string | number>;
  _links?: {
    self?: JenkinsPipelineLinkResponse;
    log?: JenkinsPipelineLinkResponse;
  };
  stageFlowNodes?: JenkinsPipelineNodeResponse[];
};

type JenkinsPipelineStageResponse = {
  name?: string;
  id?: string | number;
  execNode?: string;
  status?: string;
  startTimeMillis?: number;
  durationMillis?: number;
  pauseDurationMillis?: number;
  parentNodes?: Array<string | number>;
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
