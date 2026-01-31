#!/usr/bin/env bash
set -euo pipefail

print() {
  printf '%s\n' "$*"
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

install_cli=true
for arg in "$@"; do
  case "$arg" in
    --no-install)
      install_cli=false
      ;;
    -h|--help)
      print "Usage: bash setup.sh [--no-install]"
      print ""
      print "  --no-install  Skip Bun/dependency/global install; only set env vars."
      exit 0
      ;;
    *)
      print "ERROR: Unknown option: $arg"
      print "Run: bash setup.sh --help"
      exit 1
      ;;
  esac
done

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

confirm() {
  local prompt="$1"
  local response=""
  printf '%s' "$prompt"
  IFS= read -r response
  case "$response" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

confirm_default_yes() {
  local prompt="$1"
  local response=""
  printf '%s' "$prompt"
  IFS= read -r response
  case "$response" in
    ""|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

mask_value() {
  local value="$1"
  if [ -z "$value" ]; then
    printf '%s' ""
    return
  fi
  local len=${#value}
  if [ "$len" -le 4 ]; then
    printf '****'
    return
  fi
  local prefix=${value:0:2}
  local suffix=${value:$((len-2))}
  printf '%s****%s' "$prefix" "$suffix"
}

prompt_with_default() {
  local label="$1"
  local default_value="$2"
  local __resultvar="$3"
  local value=""
  while [ -z "$value" ]; do
    if [ -n "$default_value" ]; then
      printf '%s [%s]: ' "$label" "$default_value"
    else
      printf '%s: ' "$label"
    fi
    IFS= read -r value
    if [ -z "$value" ] && [ -n "$default_value" ]; then
      value="$default_value"
    fi
    if [ -z "$value" ]; then
      print "Value required."
    fi
  done
  printf -v "$__resultvar" '%s' "$value"
}

prompt_secret_with_default() {
  local label="$1"
  local default_value="$2"
  local __resultvar="$3"
  local value=""
  while [ -z "$value" ]; do
    if [ -n "$default_value" ]; then
      printf '%s (press Enter to keep existing): ' "$label"
    else
      printf '%s: ' "$label"
    fi
    IFS= read -r -s value
    printf '\n'
    if [ -z "$value" ] && [ -n "$default_value" ]; then
      value="$default_value"
    fi
    if [ -z "$value" ]; then
      print "Value required."
    fi
  done
  printf -v "$__resultvar" '%s' "$value"
}

prompt_non_empty() {
  local label="$1"
  local __resultvar="$2"
  local value=""
  while [ -z "$value" ]; do
    printf '%s: ' "$label"
    IFS= read -r value
    if [ -z "$value" ]; then
      print "Value required."
    fi
  done
  printf -v "$__resultvar" '%s' "$value"
}

prompt_secret() {
  local label="$1"
  local __resultvar="$2"
  local value=""
  while [ -z "$value" ]; do
    printf '%s: ' "$label"
    IFS= read -r -s value
    printf '\n'
    if [ -z "$value" ]; then
      print "Value required."
    fi
  done
  printf -v "$__resultvar" '%s' "$value"
}

escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_config_file() {
  local old_umask
  old_umask=$(umask)
  umask 077
  mkdir -p "$config_dir"
  cat > "$config_file" <<EOF
{
  "jenkinsUrl": "$(escape_json "$JENKINS_URL")",
  "jenkinsUser": "$(escape_json "$JENKINS_USER")",
  "jenkinsApiToken": "$(escape_json "$JENKINS_API_TOKEN")"
}
EOF
  umask "$old_umask"
  chmod 600 "$config_file" 2>/dev/null || true
}

default_profile="$HOME/.profile"
if [ -n "${SHELL:-}" ]; then
  case "$SHELL" in
    */zsh) default_profile="$HOME/.zshrc" ;;
    */bash)
      if [ -f "$HOME/.bashrc" ]; then
        default_profile="$HOME/.bashrc"
      else
        default_profile="$HOME/.bash_profile"
      fi
      ;;
  esac
fi

config_dir="$HOME/.config/jenkins-cli"
config_file="$config_dir/jenkins-cli-config"

env_url="${JENKINS_URL:-}"
env_user="${JENKINS_USER:-}"
env_token="${JENKINS_API_TOKEN:-}"

config_exists=false
config_status="missing"
config_url=""
config_user=""
config_token=""

if [ -f "$config_file" ]; then
  config_exists=true
  if command -v jq >/dev/null 2>&1; then
    if jq -e '.' "$config_file" >/dev/null 2>&1; then
      config_status="ok"
      config_url=$(jq -r '.jenkinsUrl // .JENKINS_URL // empty' "$config_file" || true)
      config_user=$(jq -r '.jenkinsUser // .JENKINS_USER // empty' "$config_file" || true)
      config_token=$(jq -r '.jenkinsApiToken // .JENKINS_API_TOKEN // empty' "$config_file" || true)
    else
      config_status="invalid"
    fi
  elif command -v python3 >/dev/null 2>&1; then
    if config_output=$(python3 - "$config_file" <<'PY'
import json,sys
path=sys.argv[1]
try:
    with open(path, "r") as f:
        data=json.load(f)
    def get(*keys):
        for k in keys:
            v=data.get(k)
            if isinstance(v, str):
                return v
        return ""
    print(get("jenkinsUrl", "JENKINS_URL"))
    print(get("jenkinsUser", "JENKINS_USER"))
    print(get("jenkinsApiToken", "JENKINS_API_TOKEN"))
except Exception:
    sys.exit(1)
PY
); then
      config_status="ok"
      config_url=$(printf '%s\n' "$config_output" | sed -n '1p')
      config_user=$(printf '%s\n' "$config_output" | sed -n '2p')
      config_token=$(printf '%s\n' "$config_output" | sed -n '3p')
    else
      config_status="invalid"
    fi
  else
    config_status="no-parser"
  fi
fi

has_env_values=false
if [ -n "$env_url" ] || [ -n "$env_user" ] || [ -n "$env_token" ]; then
  has_env_values=true
fi

has_config_values=false
if [ "$config_status" = "ok" ] && { [ -n "$config_url" ] || [ -n "$config_user" ] || [ -n "$config_token" ]; }; then
  has_config_values=true
fi

use_defaults=false
if [ "$has_env_values" = true ] || [ "$config_exists" = true ]; then
  print "Existing values detected:"
  if [ "$has_env_values" = true ]; then
    [ -n "$env_url" ] && print "  env:JENKINS_URL=$env_url"
    [ -n "$env_user" ] && print "  env:JENKINS_USER=$env_user"
    if [ -n "$env_token" ]; then
      masked_env_token=$(mask_value "$env_token")
      print "  env:JENKINS_API_TOKEN=$masked_env_token"
    fi
  fi

  if [ "$config_exists" = true ]; then
    case "$config_status" in
      ok)
        if [ "$has_config_values" = true ]; then
          [ -n "$config_url" ] && print "  config:jenkinsUrl=$config_url"
          [ -n "$config_user" ] && print "  config:jenkinsUser=$config_user"
          if [ -n "$config_token" ]; then
            masked_config_token=$(mask_value "$config_token")
            print "  config:jenkinsApiToken=$masked_config_token"
          fi
        else
          print "  config: no values found"
        fi
        ;;
      invalid)
        print "  config: unable to read (invalid JSON)"
        ;;
      no-parser)
        print "  config: unable to read (install jq or python3 to parse)"
        ;;
      *)
        print "  config: unable to read"
        ;;
    esac
  fi

  if [ "$has_env_values" = true ] || [ "$has_config_values" = true ]; then
    if confirm_default_yes "Use existing values as defaults? [Y/n]: "; then
      use_defaults=true
    fi
  fi
fi

default_url=""
default_user=""
default_token=""
if [ "$use_defaults" = true ]; then
  if [ -n "$env_url" ]; then
    default_url="$env_url"
  else
    default_url="$config_url"
  fi

  if [ -n "$env_user" ]; then
    default_user="$env_user"
  else
    default_user="$config_user"
  fi

  if [ -n "$env_token" ]; then
    default_token="$env_token"
  else
    default_token="$config_token"
  fi
fi

print "Jenkins CLI setup"
print "This will prompt for Jenkins credentials."
print ""

if [ "$install_cli" = true ]; then
  ensure_bun

  if [ ! -f "$script_dir/package.json" ]; then
    print "ERROR: package.json not found. Run this script from the project root."
    exit 1
  fi

  print "Installing dependencies..."
  bun install

  print "Installing Jenkins CLI globally..."
  bun run install:global
else
  print "Skipping install steps."
fi

prompt_with_default "Jenkins URL (e.g., https://jenkins.example.com)" "$default_url" JENKINS_URL
prompt_with_default "Jenkins username" "$default_user" JENKINS_USER
prompt_secret_with_default "Jenkins API token" "$default_token" JENKINS_API_TOKEN

saved_config=false
config_available=$config_exists
if confirm "Save values to $config_file? [y/N]: "; then
  if [ -f "$config_file" ]; then
    if confirm "Config already exists at $config_file. Overwrite? [y/N]: "; then
      write_config_file
      saved_config=true
      config_available=true
      print "Saved config to $config_file."
    else
      print "Skipped writing config."
    fi
  else
    write_config_file
    saved_config=true
    config_available=true
    print "Saved config to $config_file."
  fi
else
  print "Config not saved."
fi

if confirm "Also export these as environment variables in your shell profile? [y/N]: "; then
  profile="$default_profile"
  printf 'Profile file to update [%s]: ' "$default_profile"
  IFS= read -r profile_input
  if [ -n "$profile_input" ]; then
    profile="$profile_input"
  fi

  touch "$profile"
  profile_block=$(cat <<EOF
# jenkins-cli env
export JENKINS_URL="$(escape_json "$JENKINS_URL")"
export JENKINS_USER="$(escape_json "$JENKINS_USER")"
export JENKINS_API_TOKEN="$(escape_json "$JENKINS_API_TOKEN")"
# end jenkins-cli env
EOF
)

  profile_updated=false
  if grep -q "^# jenkins-cli env$" "$profile" 2>/dev/null; then
    if confirm "Profile already has Jenkins CLI env exports. Replace them? [y/N]: "; then
      tmp_file="$(mktemp)"
      awk '
        BEGIN { skip=0 }
        /^# jenkins-cli env$/ { skip=1; next }
        /^# end jenkins-cli env$/ { skip=0; next }
        skip==0 { print }
      ' "$profile" > "$tmp_file"
      printf '\n%s\n' "$profile_block" >> "$tmp_file"
      cat "$tmp_file" > "$profile"
      rm -f "$tmp_file"
      profile_updated=true
    else
      print "Skipped updating $profile."
    fi
  else
    printf '\n%s\n' "$profile_block" >> "$profile"
    profile_updated=true
  fi

  if [ "$profile_updated" = true ]; then
    print "Updated $profile."
    print "Open a new terminal or run: . \"$profile\""
  fi
else
  print "Env vars not added to your profile."
  if [ "$config_available" = true ]; then
    print "The CLI will read $config_file directly."
  else
    print "Re-run this script anytime to store values."
  fi
fi
