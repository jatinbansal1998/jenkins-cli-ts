#!/usr/bin/env bash
set -euo pipefail

print() {
  printf '%s\n' "$*"
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi

  print "Bun not found. Installing..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://bun.sh/install | bash
  else
    print "ERROR: curl or wget is required to install Bun."
    exit 1
  fi

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! command -v bun >/dev/null 2>&1; then
    print "ERROR: Bun installed but not on PATH."
    print "Open a new terminal or run: export PATH=\"$HOME/.bun/bin:$PATH\""
    exit 1
  fi

  print "Bun installed."
}

config_file="$HOME/.config/jenkins-cli/jenkins-cli-config.json"

confirm_default_no() {
  local prompt="$1"
  local response=""
  printf '%s' "$prompt"
  IFS= read -r response
  case "$response" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

config_has_credentials() {
  if [ ! -f "$config_file" ]; then
    return 1
  fi

  if command -v jq >/dev/null 2>&1; then
    if jq -e '((.jenkinsUrl // .JENKINS_URL // "") | length > 0) and ((.jenkinsUser // .JENKINS_USER // "") | length > 0) and ((.jenkinsApiToken // .JENKINS_API_TOKEN // "") | length > 0)' "$config_file" >/dev/null 2>&1; then
      return 0
    fi
  elif command -v python3 >/dev/null 2>&1; then
    if python3 - "$config_file" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path, "r") as f:
        data = json.load(f)
except Exception:
    sys.exit(1)
def pick(*keys):
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""
url = pick("jenkinsUrl", "JENKINS_URL")
user = pick("jenkinsUser", "JENKINS_USER")
token = pick("jenkinsApiToken", "JENKINS_API_TOKEN")
sys.exit(0 if url and user and token else 1)
PY
    then
      return 0
    fi
  else
    local has_url=false
    local has_user=false
    local has_token=false
    if grep -Eq '"(jenkinsUrl|JENKINS_URL)"[[:space:]]*:[[:space:]]*"[^"]+"' "$config_file"; then
      has_url=true
    fi
    if grep -Eq '"(jenkinsUser|JENKINS_USER)"[[:space:]]*:[[:space:]]*"[^"]+"' "$config_file"; then
      has_user=true
    fi
    if grep -Eq '"(jenkinsApiToken|JENKINS_API_TOKEN)"[[:space:]]*:[[:space:]]*"[^"]+"' "$config_file"; then
      has_token=true
    fi
    if [ "$has_url" = true ] && [ "$has_user" = true ] && [ "$has_token" = true ]; then
      return 0
    fi
  fi

  return 1
}

print "Jenkins CLI setup"
print "This will install Bun (if needed), dependencies, and the global CLI."
print ""

ensure_bun

if [ ! -f "$script_dir/package.json" ]; then
  print "ERROR: package.json not found. Run this script from the project root."
  exit 1
fi

print "Installing dependencies..."
bun install

print "Installing Jenkins CLI globally..."
bun run install:global

if command -v jenkins-cli >/dev/null 2>&1; then
  env_url="${JENKINS_URL:-}"
  env_user="${JENKINS_USER:-}"
  env_token="${JENKINS_API_TOKEN:-}"
  has_env_credentials=false
  if [ -n "$env_url" ] && [ -n "$env_user" ] && [ -n "$env_token" ]; then
    has_env_credentials=true
  fi

  has_config_credentials=false
  if config_has_credentials; then
    has_config_credentials=true
  fi

  credentials_source=""
  if [ "$has_env_credentials" = true ] && [ "$has_config_credentials" = true ]; then
    credentials_source="environment and config file"
  elif [ "$has_env_credentials" = true ]; then
    credentials_source="environment"
  elif [ "$has_config_credentials" = true ]; then
    credentials_source="config file"
  fi

  print ""
  if [ -n "$credentials_source" ]; then
    if confirm_default_no "Credentials detected in $credentials_source. Run login anyway? [y/N]: "; then
      print "Starting Jenkins CLI login..."
      jenkins-cli login
    else
      print "Skipping login."
    fi
  else
    print "Starting Jenkins CLI login..."
    jenkins-cli login
  fi
else
  print ""
  print "jenkins-cli not found on PATH. Run 'jenkins-cli login' manually."
fi

print "Done."
