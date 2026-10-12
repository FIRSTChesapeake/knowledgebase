#!/usr/bin/env bash
# Shared by the scripts in scripts/: logging, .env loading and gh checks.
# Sourced, never run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# KB_ENV_FILE points at another env file (the contract tests use it); the
# default is the git-ignored .env at the repo root.
#
# The file is parsed, never run: each line is blank, a # comment, or
# KEY=value with KEY one of ENV_KEYS, so the file can't set PATH,
# LD_PRELOAD or gh's own variables. The value is taken literally (no
# expansion or substitution), minus one pair of matching surrounding quotes.
# Any other line is an error. A value in the file overrides one already in
# the environment.
ENV_KEYS="APP_DOMAIN"
load_env() {
  local env_file="${KB_ENV_FILE:-$REPO_ROOT/.env}"
  [[ -f "$env_file" ]] || return 0
  local line key value n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      die "$env_file:$n: not a KEY=value line"
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ " $ENV_KEYS " == *" $key "* ]] || die "$env_file:$n: $key is not a setting (allowed: $ENV_KEYS)"
    if [[ ${#value} -ge 2 && ( ( "${value:0:1}" == '"' && "${value: -1}" == '"' ) \
          || ( "${value:0:1}" == "'" && "${value: -1}" == "'" ) ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$env_file"
}

require_gh() {
  command -v gh &>/dev/null || die "gh CLI not found. Install from https://cli.github.com"
  gh auth status &>/dev/null || die "gh not authenticated. Run: gh auth login"
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) \
    || die "Not a GitHub repository or gh cannot detect it. Run from the repo root."
}

set_variable() {
  local name="$1" val="${!1:-}"
  [[ -z "$val" ]] && { warn "Skipping variable $name — not set"; return; }
  gh variable set "$name" --repo "$REPO" --body "$val"
  success "Variable $name"
}
