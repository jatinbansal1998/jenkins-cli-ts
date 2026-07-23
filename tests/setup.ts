// Tests and their child CLI processes must not send events to external services.
process.env.JENKINS_ERROR_REPORTING_DISABLED = "true";
