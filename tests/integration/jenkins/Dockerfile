ARG JENKINS_BASE_IMAGE=jenkins/jenkins:lts-jdk21@sha256:f4f65e6cd1405cd889b7f5ac33f9d5cdc2a099de6b87fe8a3933b9c5d53d1d02
FROM ${JENKINS_BASE_IMAGE}

COPY --chown=jenkins:jenkins plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt
USER root
RUN git config --system --add safe.directory /run/jenkins-cli-integration/demo-app.git
USER jenkins
