import com.cloudbees.hudson.plugins.folder.Folder
import hudson.matrix.AxisList
import hudson.matrix.MatrixProject
import hudson.matrix.TextAxis
import hudson.model.FreeStyleProject
import hudson.model.BooleanParameterDefinition
import hudson.model.ChoiceParameterDefinition
import hudson.model.Item
import hudson.model.Label
import hudson.model.ParametersDefinitionProperty
import hudson.model.PasswordParameterDefinition
import hudson.model.StringParameterDefinition
import hudson.model.TextParameterDefinition
import hudson.model.View
import hudson.plugins.git.GitSCM
import hudson.security.GlobalMatrixAuthorizationStrategy
import hudson.security.HudsonPrivateSecurityRealm
import hudson.slaves.DumbSlave
import hudson.slaves.JNLPLauncher
import hudson.tasks.ArtifactArchiver
import hudson.tasks.Shell
import hudson.tasks.junit.JUnitResultArchiver
import jenkins.install.InstallState
import jenkins.model.Jenkins
import jenkins.security.ApiTokenProperty
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition
import org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import net.uaznia.lukanus.hudson.plugins.gitparameter.GitParameterDefinition
import net.uaznia.lukanus.hudson.plugins.gitparameter.SelectedValue
import net.uaznia.lukanus.hudson.plugins.gitparameter.SortMode

def jenkins = Jenkins.get()
jenkins.setNumExecutors(1)

def securityRealm = new HudsonPrivateSecurityRealm(false)
def adminUser = securityRealm.createAccount("integration-test", "integration-test-password")
def readerUser = securityRealm.createAccount("integration-reader", "integration-reader-password")
jenkins.setSecurityRealm(securityRealm)

def authorizationStrategy = new GlobalMatrixAuthorizationStrategy()
authorizationStrategy.add(Jenkins.ADMINISTER, "integration-test")
authorizationStrategy.add(Jenkins.READ, "integration-reader")
authorizationStrategy.add(Item.DISCOVER, "integration-reader")
authorizationStrategy.add(Item.READ, "integration-reader")
authorizationStrategy.add(View.READ, "integration-reader")
jenkins.setAuthorizationStrategy(authorizationStrategy)
jenkins.setInstallState(InstallState.INITIAL_SETUP_COMPLETED)

def writeToken = { user, name, path ->
  def tokenProperty = user.getProperty(ApiTokenProperty.class)
  def token = tokenProperty.tokenStore.generateNewToken(name).plainValue
  user.save()
  def tokenFile = new File(path)
  tokenFile.parentFile.mkdirs()
  tokenFile.text = token
}
def runtimeDir = System.getenv("JENKINS_INTEGRATION_RUNTIME_DIR") ?: "/run/jenkins-cli-integration"
writeToken(adminUser, "jenkins-cli-integration-admin", "${runtimeDir}/admin-api-token")
writeToken(readerUser, "jenkins-cli-integration-reader", "${runtimeDir}/reader-api-token")

def job = jenkins.createProject(FreeStyleProject.class, "cli-smoke")
job.setDescription("Jenkins CLI end-to-end integration fixture")
job.addProperty(new ParametersDefinitionProperty([
  new StringParameterDefinition("MESSAGE", "default-message", "Message written by the test build"),
  new TextParameterDefinition("NOTES", "default-notes", "Multiline notes"),
  new BooleanParameterDefinition("ENABLED", false, "Boolean normalization fixture"),
  new ChoiceParameterDefinition("MODE", ["safe", "fast"] as String[], "Choice validation fixture"),
  new PasswordParameterDefinition("SECRET", "default-secret", "Sensitive fixture")
]))
job.getBuildersList().add(new Shell('''set -eu
printf 'cli-integration:%s\n' "$MESSAGE"
mkdir -p reports
{
  printf 'message=%s\n' "$MESSAGE"
  printf 'notes=%s\n' "$NOTES"
  printf 'enabled=%s\n' "$ENABLED"
  printf 'mode=%s\n' "$MODE"
  printf 'secret-length=%s\n' "${#SECRET}"
} > reports/values.txt
printf 'root-artifact\n' > artifact.txt
'''))
job.getPublishersList().add(new ArtifactArchiver("artifact.txt,reports/values.txt"))
job.save()

def followLogsJob = jenkins.createProject(FreeStyleProject.class, "cli-log-follow")
followLogsJob.getBuildersList().add(new Shell('''set +x
printf 'tail-follow-bootstrap-1\n'
printf 'tail-follow-bootstrap-2\n'
sleep 15
printf 'tail-follow-finished\n'
'''))
followLogsJob.save()

def exactJob = jenkins.createProject(FreeStyleProject.class, "cli-exact")
exactJob.addProperty(new ParametersDefinitionProperty([
  new StringParameterDefinition("MESSAGE", "exact-default", "Immutable build selector fixture")
]))
exactJob.getBuildersList().add(new Shell('''set -eu
printf 'exact-build:%s\n' "$MESSAGE"
printf 'exact-artifact:%s\n' "$MESSAGE" > exact-artifact.txt
'''))
exactJob.getPublishersList().add(new ArtifactArchiver("exact-artifact.txt"))
exactJob.save()

def testResultsJob = jenkins.createProject(FreeStyleProject.class, "cli-test-results")
testResultsJob.getBuildersList().add(new Shell('''set -eu
cat > test-results.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="checkout" tests="3" failures="1" skipped="1" time="1.5">
  <testcase classname="CartTest" name="accepts valid card" time="0.1"/>
  <testcase classname="CartTest" name="rejects expired card é" time="0.12">
    <failure message="expected true but got false">java.lang.AssertionError: expected true
  at CartTest.rejectsExpiredCard(CartTest.java:42)</failure>
  </testcase>
  <testcase classname="CartTest" name="pending fraud check" time="0.0"><skipped/></testcase>
</testsuite>
XML
'''))
testResultsJob.getPublishersList().add(new JUnitResultArchiver("test-results.xml"))
testResultsJob.save()

def successfulTestResultsJob = jenkins.createProject(FreeStyleProject.class, "cli-test-results-success")
successfulTestResultsJob.getBuildersList().add(new Shell('''set -eu
cat > test-results.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="health" tests="1" failures="0" skipped="0" time="0.05">
  <testcase classname="HealthTest" name="reports healthy" time="0.05"/>
</testsuite>
XML
'''))
successfulTestResultsJob.getPublishersList().add(new JUnitResultArchiver("test-results.xml"))
successfulTestResultsJob.save()

def matrixTestResultsJob = jenkins.createProject(MatrixProject.class, "cli-matrix-test-results")
matrixTestResultsJob.setAxes(new AxisList(new TextAxis("os", ["linux"])))
matrixTestResultsJob.getBuildersList().add(new Shell('''set -eu
cat > test-results.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="matrix" tests="2" failures="1" skipped="0" time="0.3">
  <testcase classname="MatrixTest" name="passes on linux" time="0.1"/>
  <testcase classname="MatrixTest" name="fails on linux" time="0.2">
    <failure message="matrix expected true">java.lang.AssertionError: matrix expected true
  at MatrixTest.failsOnLinux(MatrixTest.java:7)</failure>
  </testcase>
</testsuite>
XML
'''))
matrixTestResultsJob.getPublishersList().add(new JUnitResultArchiver("test-results.xml"))
matrixTestResultsJob.save()

def failingJob = jenkins.createProject(FreeStyleProject.class, "cli-failure")
failingJob.addProperty(new ParametersDefinitionProperty([
  new StringParameterDefinition("REASON", "expected-failure", "Failure marker")
]))
failingJob.getBuildersList().add(new Shell('''set -eu
printf 'deliberate-failure:%s\n' "$REASON"
exit 23
'''))
failingJob.save()

def noParamsJob = jenkins.createProject(FreeStyleProject.class, "cli-no-params")
noParamsJob.getBuildersList().add(new Shell("printf 'no-params-success\\n'"))
noParamsJob.save()

// Activity-metadata fixtures: `cli-activity` is built by the listing scenario,
// `cli-never-built` is never built by any scenario so listings can assert the
// "enabled but never built" state.
def activityJob = jenkins.createProject(FreeStyleProject.class, "cli-activity")
activityJob.getBuildersList().add(new Shell("printf 'activity-success\\n'"))
activityJob.save()

def neverBuiltJob = jenkins.createProject(FreeStyleProject.class, "cli-never-built")
neverBuiltJob.getBuildersList().add(new Shell("printf 'never-built-should-not-run\\n'"))
neverBuiltJob.save()

def historyJob = jenkins.createProject(FreeStyleProject.class, "cli-history")
historyJob.getBuildersList().add(new Shell("printf 'history-success\\n'"))
historyJob.save()

def spaceJob = jenkins.createProject(FreeStyleProject.class, "cli space job")
spaceJob.getBuildersList().add(new Shell("printf 'space-job-success\\n'"))
spaceJob.save()

def queuedJob = jenkins.createProject(FreeStyleProject.class, "cli-always-queued")
queuedJob.setAssignedLabel(Label.get("integration-agent-that-does-not-exist"))
queuedJob.getBuildersList().add(new Shell("printf 'unexpectedly-ran\\n'"))
queuedJob.save()

def structuredJob = jenkins.createProject(FreeStyleProject.class, "cli-structured")
structuredJob.addProperty(new ParametersDefinitionProperty([
  new StringParameterDefinition("MESSAGE", "structured-default", "Structured output fixture")
]))
structuredJob.getBuildersList().add(new Shell('''set -eu
printf 'structured:%s\n' "$MESSAGE"
printf 'structured-artifact\n' > structured-artifact.txt
'''))
structuredJob.getPublishersList().add(new ArtifactArchiver("structured-artifact.txt"))
structuredJob.save()

def structuredFailureJob = jenkins.createProject(FreeStyleProject.class, "cli-structured-failure")
structuredFailureJob.addProperty(new ParametersDefinitionProperty([
  new StringParameterDefinition("REASON", "structured-failure", "Structured failure marker")
]))
structuredFailureJob.getBuildersList().add(new Shell('''set -eu
printf 'structured-failure:%s\n' "$REASON"
exit 24
'''))
structuredFailureJob.save()

def structuredQueuedJob = jenkins.createProject(FreeStyleProject.class, "cli-structured-queued")
structuredQueuedJob.setAssignedLabel(Label.get("structured-agent-that-does-not-exist"))
structuredQueuedJob.getBuildersList().add(new Shell("printf 'unexpectedly-ran\\n'"))
structuredQueuedJob.save()

def slowJob = jenkins.createProject(FreeStyleProject.class, "cli-slow")
slowJob.setConcurrentBuild(false)
slowJob.getBuildersList().add(new Shell('''set -eu
printf 'slow-build-started\n'
sleep 60
printf 'slow-build-finished\n'
'''))
slowJob.save()

def branchJob = jenkins.createProject(FreeStyleProject.class, "cli-branch")
branchJob.addProperty(new ParametersDefinitionProperty([
  new StringParameterDefinition("BRANCH", "main", "Branch selected by the CLI"),
  new StringParameterDefinition("EXTRA", "none", "Additional rerun parameter")
]))
branchJob.getBuildersList().add(new Shell('''set -eu
printf 'branch=%s\n' "$BRANCH"
printf 'extra=%s\n' "$EXTRA"
exit 17
'''))
branchJob.save()

def transitionJob = jenkins.createProject(FreeStyleProject.class, "cli-transition")
transitionJob.getBuildersList().add(new Shell('''set -eu
printf 'transition-started\n'
sleep 2
printf 'transition-finished\n'
'''))
transitionJob.save()

def teamFolder = jenkins.createProject(Folder.class, "team")
def nestedJob = teamFolder.createProject(FreeStyleProject.class, "nested smoke")
nestedJob.getBuildersList().add(new Shell("printf 'nested-success\\n'"))
nestedJob.save()

def pipelineJob = jenkins.createProject(WorkflowJob.class, "cli-pipeline")
pipelineJob.addProperty(new ParametersDefinitionProperty([
  new StringParameterDefinition("BRANCH", "main", "Pipeline branch")
]))
pipelineJob.setDefinition(new CpsFlowDefinition('''
node {
  stage('Prepare') {
    echo 'pipeline-prepare'
  }
  stage('Verify') {
    echo "pipeline-branch:${params.BRANCH}"
  }
}
''', true))
pipelineJob.save()

def pipelineTestResultsJob = jenkins.createProject(WorkflowJob.class, "cli-pipeline-test-results")
pipelineTestResultsJob.setDefinition(new CpsFlowDefinition('''
node {
  writeFile file: 'pipeline-results.xml', text: """<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="pipeline" tests="1" failures="0" skipped="0" time="0.02">
  <testcase classname="PipelineTest" name="publishes results" time="0.02"/>
</testsuite>
"""
  junit testResults: 'pipeline-results.xml'
}
''', true))
pipelineTestResultsJob.save()

def revisionPipelineRepository = new File(runtimeDir, "pipeline-definitions.git").getAbsolutePath()
def revisionApplicationRepository = new File(runtimeDir, "backend-api.git").getAbsolutePath()
def revisionsJob = jenkins.createProject(WorkflowJob.class, "cli-git-revisions")
revisionsJob.setDefinition(new CpsFlowDefinition("""
node {
  stage('Checkout repositories') {
    dir('pipeline-definitions') {
      git branch: 'main', url: '${revisionPipelineRepository}'
    }
    dir('backend-api') {
      git branch: 'main', url: '${revisionApplicationRepository}'
    }
  }
  stage('Verify') {
    echo 'multi-scm-checkout-complete'
  }
}
""", true))
revisionsJob.save()

def disabledPipelineJob = jenkins.createProject(WorkflowJob.class, "cli-pipeline-disabled")
disabledPipelineJob.setDefinition(new CpsFlowDefinition('''
node {
  echo 'disabled-pipeline-should-not-run'
}
''', true))
disabledPipelineJob.setDisabled(true)
disabledPipelineJob.save()

def syntheticRepository = new File(runtimeDir, "demo-app.git").toURI().toString()
def syntheticScm = new GitSCM(syntheticRepository)
def gitParameter = new GitParameterDefinition(
  "BRANCH_TAG",
  "PT_BRANCH",
  "main",
  "Synthetic branch selected from the job's configured repository",
  "",
  "origin/(.*)",
  "*",
  SortMode.NONE,
  SelectedValue.DEFAULT,
  "",
  false
)
def buildErrorJob = jenkins.createProject(WorkflowJob.class, "demo-app-deploy")
buildErrorJob.addProperty(new ParametersDefinitionProperty([
  gitParameter,
  new BooleanParameterDefinition("Test", false, "Synthetic test toggle")
]))
buildErrorJob.setDefinition(new CpsScmFlowDefinition(syntheticScm, "Jenkinsfile"))
buildErrorJob.save()

def failingPipelineJob = jenkins.createProject(WorkflowJob.class, "cli-pipeline-failure")
failingPipelineJob.setDefinition(new CpsFlowDefinition('''
node {
  stage('Prepare') {
    echo 'pipeline-failure-prepare'
  }
  stage('Deploy') {
    echo 'pipeline-deploy-before'
    echo 'pipeline-deploy-context'
    echo 'pipeline-deploy-after'
    error 'pipeline-deploy-failure'
  }
}
''', true))
failingPipelineJob.save()

def logInspectionPipeline = jenkins.createProject(WorkflowJob.class, "cli-pipeline-logs")
logInspectionPipeline.setDefinition(new CpsFlowDefinition('''
timestamps {
  node {
    stage('Prepare') {
      echo 'pipeline-logs-prepare'
      echo 'pipeline-logs-context-before'
      echo "\u001B[8mha:////synthetic-metadata\u001B[0m\u001B[36mpipeline-logs-context-target\u001B[0m"
      echo 'pipeline-logs-context-after'
      echo "pipeline-logs-osc ]8;;https://example.invalid/\\\\pipeline-logs-link-label]8;;\\\\ end"
    }
    stage('Test') {
      echo 'pipeline-logs-test-first'
    }
    stage('Parallel') {
      parallel(
        linux: { echo 'pipeline-logs-linux' },
        windows: { echo 'pipeline-logs-windows' }
      )
    }
    stage('Test') {
      echo 'pipeline-logs-test-second'
    }
  }
}
''', true))
logInspectionPipeline.save()

def timestampedLogJob = jenkins.createProject(WorkflowJob.class, "cli-timestamped-logs")
timestampedLogJob.setDefinition(new CpsFlowDefinition('''
timestamps {
  node {
    echo 'timestamped-log-old'
    sleep time: 2, unit: 'SECONDS'
    echo 'timestamped-log-new'
  }
}
''', true))
timestampedLogJob.save()

def offlineAgent = new DumbSlave(
  "offline-agent",
  "/tmp/jenkins-cli-offline-agent",
  new JNLPLauncher()
)
offlineAgent.setNumExecutors(1)
jenkins.addNode(offlineAgent)
jenkins.save()
