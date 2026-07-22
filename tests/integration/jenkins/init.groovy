import hudson.model.FreeStyleProject
import hudson.model.BooleanParameterDefinition
import hudson.model.ChoiceParameterDefinition
import hudson.model.Label
import hudson.model.ParametersDefinitionProperty
import hudson.model.PasswordParameterDefinition
import hudson.model.StringParameterDefinition
import hudson.model.TextParameterDefinition
import hudson.security.FullControlOnceLoggedInAuthorizationStrategy
import hudson.security.HudsonPrivateSecurityRealm
import hudson.tasks.ArtifactArchiver
import hudson.tasks.Shell
import jenkins.install.InstallState
import jenkins.model.Jenkins
import jenkins.security.ApiTokenProperty

def jenkins = Jenkins.get()

def securityRealm = new HudsonPrivateSecurityRealm(false)
def user = securityRealm.createAccount("integration-test", "integration-test-password")
jenkins.setSecurityRealm(securityRealm)

def authorizationStrategy = new FullControlOnceLoggedInAuthorizationStrategy()
authorizationStrategy.setAllowAnonymousRead(false)
jenkins.setAuthorizationStrategy(authorizationStrategy)
jenkins.setInstallState(InstallState.INITIAL_SETUP_COMPLETED)

def tokenProperty = user.getProperty(ApiTokenProperty.class)
def token = tokenProperty.tokenStore.generateNewToken("jenkins-cli-integration").plainValue
user.save()

def tokenFile = new File("/run/jenkins-cli-integration/api-token")
tokenFile.parentFile.mkdirs()
tokenFile.text = token

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
jenkins.save()
