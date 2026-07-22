import hudson.model.FreeStyleProject
import hudson.model.ParametersDefinitionProperty
import hudson.model.StringParameterDefinition
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
  new StringParameterDefinition("MESSAGE", "default-message", "Message written by the test build")
]))
job.getBuildersList().add(new Shell('''set -eu
printf 'cli-integration:%s\n' "$MESSAGE"
printf '%s\n' "$MESSAGE" > artifact.txt
'''))
job.getPublishersList().add(new ArtifactArchiver("artifact.txt"))
job.save()
jenkins.save()
