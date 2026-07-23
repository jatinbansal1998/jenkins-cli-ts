#!/usr/bin/env bun

import crypto from "node:crypto";
import * as Sentry from "@sentry/bun";
import {
  captureUnexpectedError,
  initializeDefaultErrorReporting,
} from "../src/error-reporting";

const environment = process.env.SENTRY_ENVIRONMENT?.trim();
if (!environment || environment === "production") {
  throw new Error(
    "Set SENTRY_ENVIRONMENT to an explicit non-production value before running this smoke test.",
  );
}

const mode = process.argv.includes("--global") ? "global" : "manual";
const marker = `jenkins-cli-sentry-${mode}-${crypto.randomUUID()}`;
const initialized = await initializeDefaultErrorReporting();
if (!initialized) {
  throw new Error(
    "Sentry did not initialize. Check the DSN and JENKINS_ERROR_REPORTING_DISABLED.",
  );
}

if (mode === "manual") {
  const eventId = await captureUnexpectedError(new Error(marker));
  if (!eventId) {
    throw new Error("Sentry did not confirm that the smoke event was flushed.");
  }
  console.log(JSON.stringify({ mode, environment, marker, eventId }));
} else {
  Sentry.addEventProcessor((event) => {
    const isSmokeEvent = event.exception?.values?.some(
      (exception) => exception.value === marker,
    );
    if (isSmokeEvent && event.event_id) {
      console.log(
        JSON.stringify({
          mode,
          environment,
          marker,
          eventId: event.event_id,
        }),
      );
    }
    return event;
  });
  setTimeout(() => {
    throw new Error(marker);
  }, 0);
}
