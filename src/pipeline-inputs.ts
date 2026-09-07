/**
 * Normalization for Pipeline `input` step actions returned by
 * `<build>/wfapi/pendingInputActions` (pipeline-rest-api plugin).
 *
 * Jenkins returns root-relative links such as
 * `/jenkins/job/deploy/128/wfapi/inputSubmit?inputId=Release`. Every link is
 * resolved against the owning build URL and dropped unless it stays on the same
 * origin under that build path, so a tampered or misconfigured controller can
 * never make the CLI POST somewhere else.
 */
import type {
  JenkinsPendingInputActionResponse,
  PendingInputAction,
  PendingInputParameter,
} from "./types/jenkins";

const MAX_DISPLAY_TEXT_LENGTH = 200;

/**
 * Resolves `href` against `buildUrl` and returns the absolute URL only when it
 * points at the same origin and sits under the build path. Credentials and
 * fragments are rejected outright; a query string is allowed because Jenkins
 * carries the input id there.
 */
export function resolveBuildScopedUrl(
  href: unknown,
  buildUrl: string,
): string | undefined {
  if (typeof href !== "string" || !href.trim()) {
    return undefined;
  }
  let build: URL;
  let target: URL;
  try {
    build = new URL(buildUrl.endsWith("/") ? buildUrl : `${buildUrl}/`);
    target = new URL(href.trim(), build);
  } catch {
    return undefined;
  }
  if (
    target.origin !== build.origin ||
    target.username ||
    target.password ||
    target.hash
  ) {
    return undefined;
  }
  if (!target.pathname.startsWith(build.pathname)) {
    return undefined;
  }
  return target.toString();
}

/**
 * Maps the wire payload to actions the CLI can act on. Entries without a
 * string id are skipped because nothing can be submitted for them. Missing
 * `inputs` metadata becomes `parameters: null` rather than "no parameters".
 */
export function normalizePendingInputActions(
  entries: JenkinsPendingInputActionResponse[],
  buildUrl: string,
): PendingInputAction[] {
  const actions: PendingInputAction[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      continue;
    }
    actions.push({
      id,
      message: typeof entry.message === "string" ? entry.message : "",
      proceedText:
        typeof entry.proceedText === "string" && entry.proceedText.trim()
          ? entry.proceedText
          : undefined,
      parameters: normalizeParameters(entry.inputs),
      proceedUrl: resolveBuildScopedUrl(entry.proceedUrl, buildUrl),
      abortUrl: resolveBuildScopedUrl(entry.abortUrl, buildUrl),
      approvalUrl: resolveBuildScopedUrl(entry.redirectApprovalUrl, buildUrl),
    });
  }
  return actions;
}

function normalizeParameters(
  inputs: JenkinsPendingInputActionResponse["inputs"],
): PendingInputParameter[] | null {
  if (!Array.isArray(inputs)) {
    return null;
  }
  return inputs.map((input) => ({
    name:
      input && typeof input.name === "string" && input.name.trim()
        ? input.name
        : "(unnamed)",
    type: input && typeof input.type === "string" ? input.type : undefined,
    description:
      input && typeof input.description === "string"
        ? input.description
        : undefined,
  }));
}

/**
 * Makes Jenkins-authored text safe for one terminal line: strips ANSI and
 * control characters (so a message cannot move the cursor or fake output),
 * collapses whitespace, and truncates long messages.
 */
export function sanitizeInputText(value: string): string {
  const printable = Array.from(Bun.stripANSI(value))
    .map((character) => {
      const code = character.charCodeAt(0);
      if (code === 9 || code === 10 || code === 13) {
        return " ";
      }
      return code < 32 || code === 127 ? "" : character;
    })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (printable.length <= MAX_DISPLAY_TEXT_LENGTH) {
    return printable;
  }
  return `${printable.slice(0, MAX_DISPLAY_TEXT_LENGTH - 1)}…`;
}
