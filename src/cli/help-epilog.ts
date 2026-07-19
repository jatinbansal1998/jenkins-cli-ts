import { DEFAULT_LOG_POLL_MS } from "../commands/logs";
import { DEFAULT_WATCH_INTERVAL_MS } from "../commands/watch-utils";
import { ENV_KEYS } from "../env-keys";
import { getJobCacheDir } from "../jobs";

export function getRootHelpEpilog(): string {
  return `Examples:
  $0 auth login
      Interactive login (prompts for URL, user, and token).
  $0 auth login --profile work --url https://jenkins.example.com --user ci --token <token> --non-interactive
      Scripted login.
  $0 build --job "api deploy" --branch main --non-interactive
      Trigger a build by fuzzy job name.
  $0 build --job-url https://jenkins.example.com/job/api/ --branch main --param ENV=staging --non-interactive
      Trigger by exact URL with a custom parameter.
  $0 status --job api --json
      Last build status as a JSON document.
  $0 wait --job api --timeout 30m --json
      Wait for the latest build to finish.
  $0 artifacts --job api --download --dest ./out --non-interactive
      Download the last build's artifacts.
  $0 auth logout --all --non-interactive
      Remove all locally stored credentials.

Job selection (build, status, history, wait, logs, artifacts, cancel, rerun, params):
  --job <text>      Fuzzy match on job name or description (uses the local job cache)
  --job-url <url>   Exact Jenkins job URL (skips the cache and search)
  With neither flag, an interactive job picker opens (requires a TTY).

Scripting and AI agents:
  Pass --non-interactive to disable every prompt and fail fast; --json implies it.
  --json is supported by: list, params, status, history, wait.
  Output lines are prefixed OK: (success), ERROR: (failure), HINT: (guidance).
  Exit code is 0 on success and 1 on any error.
  Run "$0 help --full" to print every command's full option reference at once.
  Note: the --search/--refresh/--json entries in "Options:" above belong to the
  default "list" command, not to every command.

Command-specific options:
  list:
    --search <text>  Search jobs by name or description
    --refresh        Refresh the job cache from Jenkins [default: false]
    --json           Output a single JSON document (implies non-interactive)

  params:
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --json           Output a single JSON document (implies non-interactive)

  build / deploy:
    --job <text>           Job name or description
    --job-url <url>        Full Jenkins job URL
    --branch <name>        Branch name to build
    --branch-param <name>  Parameter name for the branch [default: BRANCH]
    --param KEY=VALUE      Custom build parameter (repeatable)
    --without-params       Trigger without parameters (non-interactive only)
    --watch                Watch build status until completion [default: false]

  status:
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --watch          Watch latest build until completion [default: false]
    --json           Output a single JSON document (implies non-interactive)

  history / builds:
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL
    --offset <n>     Skip N builds before showing the next 5 [default: 0]
    --json           Output a single JSON document (implies non-interactive)

  wait:
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL
    --interval <dur>  Polling interval (e.g. 30s, 1m) [default: ${DEFAULT_WATCH_INTERVAL_MS / 1000}s]
    --timeout <dur>   Timeout (e.g. 30m, 2h)
    --json            Output a single JSON document (implies non-interactive)

  logs:
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL
    --follow          Keep streaming logs until build completes [default: true]
    --poll <dur>      Polling interval when following [default: ${DEFAULT_LOG_POLL_MS / 1000}s]

  artifacts:
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build <n>       Target a specific build number (with --job/--job-url)
    --build-url <url> Full Jenkins build URL
    --download        Download artifacts, not just list them [default: false]
    --dest <dir>      Destination directory for downloads [default: cwd]
    --artifact <path> Only this relativePath (repeatable; implies --download)
    --force           Overwrite existing files [default: false]

  run:
    (no command-specific options; interactive picker of running builds)

  cancel:
    --job <text>      Job name or description
    --job-url <url>   Full Jenkins job URL
    --build-url <url> Full Jenkins build URL
    --queue-url <url> Full Jenkins queue item URL

  queue:
    --job <text>  Filter queued items to a job name

  nodes:
    --offline-only  Show only offline nodes [default: false]

  rerun:
    --job <text>     Job name or description
    --job-url <url>  Full Jenkins job URL

  auth login / login:
    --url <url>            Jenkins base URL
    --user <name>          Jenkins username
    --token <token>        Jenkins API token
    --profile <name>       Profile name to create or update
    --branch-param <name>  Branch parameter name [default: BRANCH]
    --keychain             Store the token in the OS keychain when available
                           [default: true; use --no-keychain for plaintext]

  auth status:
    --profile <name>  Check a named profile
    --url <url>       Direct Jenkins base URL (use with --user and --token)
    --user <name>     Direct Jenkins username (use with --url and --token)
    --token <token>   Direct Jenkins API token (use with --url and --user)

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

Cache directory: ${getJobCacheDir()}
Cache files are separated by Jenkins URL.

Run "$0 <command> --help" for full details.`;
}
