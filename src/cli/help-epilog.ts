import { DEFAULT_LOG_POLL_MS } from "../commands/logs";
import { DEFAULT_WATCH_INTERVAL_MS } from "../commands/watch-utils";
import { ENV_KEYS } from "../env-keys";
import { getJobCacheDir } from "../jobs";

export const BUILD_METADATA_HELP = `JSON build metadata (status, history, wait):
  branch       Configured branch parameter value (an input, not
               checkout evidence)
  revisions[]  Git-plugin checkout evidence: repo, remote URL(s),
               branch, SHA. Duplicate checkouts are merged; omitted
               when the build's metadata could not be fetched.`;

export function getRootHelpEpilog(): string {
  return `Examples:
  $0 auth login
      Interactive login (prompts for URL, user, and token).
  $0 auth login --profile work --url https://jenkins.example.com --user ci --token <token> --non-interactive
      Scripted login.
  $0 build "api deploy" --branch main --non-interactive
      Trigger a build by fuzzy job name.
  $0 build --job-url https://jenkins.example.com/job/api/ --branch main --param ENV=staging --non-interactive
      Trigger by exact URL with a custom parameter.
  $0 status --job api --json
      Last build status as a JSON document.
  $0 status --job api --build 128 --json
      Status for one immutable build.
  $0 wait --job api --timeout 30m --json
      Wait for the latest build to finish.
  $0 logs --job api --jsonl
      Stream one compact JSON log event per line.
  $0 logs --job api --tail 50 --follow
      Print the last 50 existing lines, then follow new output.
  $0 logs --build-url https://jenkins.example.com/job/api/128/ --stage Test
      Stream the uniquely named Pipeline stage.
  $0 artifacts --job api --download --dest ./out --non-interactive
      Download the last build's artifacts.
  $0 auth logout --all --non-interactive
      Remove all locally stored credentials.

Job selection (build, status, history, wait, logs, artifacts, cancel, rerun, params):
  [job-name]        Fuzzy match on job name or description (positional form)
  --job <text>      Fuzzy match on job name or description (uses the local job cache)
  --job-url <url>   Exact Jenkins job URL (skips the cache and search)
  The positional form and --job are equivalent; if both are passed, they must match.
  With no job argument or flag, an interactive job picker opens (requires a TTY).

Exact build selection (status, wait, logs, artifacts, cancel, rerun):
  --build <n>       Positive integer build number; requires --job or --job-url
  --build-url <url> Complete numeric Jenkins build URL; cannot be combined with
                    --build, --job, --job-url, or --queue-url
  Direct job/build/queue URLs must belong to the active Jenkins controller.
  Without an exact selector, each command keeps its documented latest behavior.

${BUILD_METADATA_HELP}

Scripting and AI agents:
  Pass --non-interactive to disable every prompt and fail fast; --json/--jsonl imply it.
  --json: list, params, build, status, history, wait, artifacts, run, cancel,
          queue, nodes, rerun, auth status/list/current, and update --check.
  --jsonl: logs.
  Output lines are prefixed OK: (success), ERROR: (failure), HINT: (guidance).
  Exit code is 0 on success and 1 on any error.
  Run "$0 help --full" to print every command's full option reference at once.
  Unsupported --json combinations fail with a clear message, never an unknown flag.

Command-specific options:
  list:
    --search <text>  Search jobs by name or description
    --refresh        Refresh the job cache from Jenkins [default: false]
    --active-only    Show built jobs not marked disabled by Jenkins
    --json           Output a single JSON document (implies non-interactive)

  params:
    [job-name]       Job name or description
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --json           Output a single JSON document (implies non-interactive)

  build / deploy:
    [job-name]             Job name or description
    --job <text>           Job name or description
    --job-url <url>        Full Jenkins job URL
    --branch <name>        Branch name to build
    --branch-param <name>  Parameter name for the branch [default: BRANCH]
    --param KEY=VALUE      Custom build parameter (repeatable)
    --without-params       Trigger without parameters (non-interactive only)
    --watch                Watch build status until completion [default: false]
    --json                 Output one build receipt (implies non-interactive)

  status:
    [job-name]       Job name or description
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --build <n>       Target a specific build number (with --job/--job-url)
    --build-url <url> Full Jenkins build URL
    --watch          Watch selected build until completion [default: false]
    --json           Output a single JSON document (implies non-interactive)

  history / builds:
    [job-name]       Job name or description
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --offset <n>     Skip N builds before showing the next 5 [default: 0]
    --json           Output a single JSON document (implies non-interactive)

  wait:
    [job-name]        Job name or description
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build <n>       Target a specific build number (with --job/--job-url)
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL
    --interval <dur>  Polling interval (e.g. 30s, 1m) [default: ${DEFAULT_WATCH_INTERVAL_MS / 1000}s]
    --timeout <dur>   Timeout (e.g. 30m, 2h)
    --json            Output a single JSON document (implies non-interactive)

  logs:
    [job-name]        Job name or description
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build <n>       Target a specific build number (with --job/--job-url)
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL
    --follow          Keep streaming logs until build completes [default: true]
    --poll <dur>      Polling interval when following [default: ${DEFAULT_LOG_POLL_MS / 1000}s]
    --tail <n>        Show only the last N existing lines
    --since <value>   Show logs after a duration or ISO-8601 timestamp
    --stage <name>    Show one uniquely named Pipeline stage
    --stage-id <id>   Show one Pipeline stage or node by stable id
    --failed          Show the failed stage and relevant error log
    --jsonl           Stream one compact JSON event per line

  artifacts:
    [job-name]        Job name or description
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build <n>       Target a specific build number (with --job/--job-url)
    --build-url <url> Full Jenkins build URL
    --download        Download artifacts, not just list them [default: false]
    --dest <dir>      Destination directory for downloads [default: cwd]
    --artifact <path> Only this relativePath (repeatable; implies --download)
    --force           Overwrite existing files [default: false]
    --json            List artifacts as one JSON document

  run:
    --json  List running builds as one JSON document

  cancel:
    [job-name]        Job name or description
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build <n>       Target a specific build number (with --job/--job-url)
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL
    --json            Output one cancellation receipt

  queue:
    --job <text>  Filter queued items to a job name
    --json        Output normalized queue items

  nodes:
    --offline-only  Show only offline nodes [default: false]
    --json          Output normalized nodes and executor summary

  rerun:
    [job-name]       Job name or description
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --build <n>       Target a specific build number (with --job/--job-url)
    --build-url <url> Full Jenkins build URL
    --json           Output source and new target receipt

  auth login / login:
    --url <url>            Jenkins base URL
    --user <name>          Jenkins username
    --token <token>        Jenkins API token
    --profile <name>       Profile name to create or update
    --branch-param <name>  Branch parameter name [default: BRANCH]
    --keychain             Store the token in the OS keychain when available
                           [default: true; use --no-keychain for plaintext]
    --protected            Make the profile read-only; use --no-protected to
                           clear it. On an existing profile this only toggles
                           the flag; login otherwise asks, defaulting to no.

  auth status:
    --profile <name>  Check a named profile
    --url <url>       Direct Jenkins base URL (use with --user and --token)
    --user <name>     Direct Jenkins username (use with --url and --token)
    --token <token>   Direct Jenkins API token (use with --url and --user)
    --json            Output normalized diagnostics without secrets

  auth profile management:
    auth list                    List stored credential profiles
    auth use <name>              Set the default profile
    auth current                 Show resolved credentials (local, no network)
    auth rename <old> <new>      Rename a profile (moves its keychain token)
    auth logout                  Delete the active profile's local credentials
    auth logout --profile <name> Delete a specific profile's local credentials
    auth logout --all            Delete all profiles (logout never revokes the
                                 Jenkins-side API token)

  profile (compatibility):
    list            List configured profiles (same as auth list)
    use <name>      Set default profile (same as auth use)
    delete <name>   Delete a profile (same as auth logout --profile)

  help:
    --full  Print every command's full option reference [default: false]

  global auth overrides (any command):
    --profile <name>  Use a named profile from config
    --url <url>       One-off Jenkins base URL override
    --user <name>     One-off Jenkins username override
    --token <token>   One-off Jenkins API token override
    (--url, --user, and --token must be passed together)

  read-only profiles (any command):
    --confirm-protected  Allow builds, cancels, and reruns on a read-only
                         profile for this run only (never persisted)
    Make a profile read-only with "auth login --protected" (interactive login
    asks and defaults to no) or by setting "protected": true in the config file.
    Blocked without the flag: build/deploy, cancel, rerun, rerun last build,
    and the same actions reached from list/build/status/history menus.
    Everything that only reads (list, params, status, wait, logs, history,
    queue, nodes, artifacts, auth) still works. A direct --url pointing at a
    read-only profile's controller is read-only too. Blocked runs exit
    non-zero; with --json they emit one document with code PROFILE_PROTECTED.

  config/env:
    ${ENV_KEYS.JENKINS_USE_CRUMB} / useCrumb  Enable Jenkins CSRF crumb usage [default: disabled]
    ${ENV_KEYS.JENKINS_POSTHOG_API_KEY}       Enable analytics with a custom PostHog project token
    ${ENV_KEYS.JENKINS_POSTHOG_HOST}          Override the PostHog host
    ${ENV_KEYS.JENKINS_ANALYTICS_DISABLED}    true disables analytics, false enables bundled analytics

  update / upgrade:
    [tag]                  Install a specific version tag (e.g. v0.2.4)
    --check                Check for updates; do not install [default: false]
    --channel <name>       Set update channel (stable or prerelease)
    --enable-auto          Enable daily update checks (notify only)
    --disable-auto         Disable daily update checks
    --enable-auto-install  Enable auto-install of updates
    --disable-auto-install Disable auto-install of updates
    --json                  Output update check data (requires --check)

Cache directory: ${getJobCacheDir()}
Cache files are separated by Jenkins URL.

Run "$0 <command> --help" for full details.`;
}
