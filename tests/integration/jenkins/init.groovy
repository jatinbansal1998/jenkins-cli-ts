import com.cloudbees.hudson.plugins.folder.Folder
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

def disabledPipelineJob = jenkins.createProject(WorkflowJob.class, "cli-pipeline-disabled")
disabledPipelineJob.setDefinition(new CpsFlowDefinition('''
node {
  echo 'disabled-pipeline-should-not-run'
}
''', true))
disabledPipelineJob.setDisabled(true)
disabledPipelineJob.save()

def syntheticRepository = "file://${runtimeDir}/demo-app.git"
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
    error 'pipeline-deploy-failure'
  }
}
''', true))
failingPipelineJob.save()

def offlineAgent = new DumbSlave(
  "offline-agent",
  "/tmp/jenkins-cli-offline-agent",
  new JNLPLauncher()
)
offlineAgent.setNumExecutors(1)
jenkins.addNode(offlineAgent)
jenkins.save()
