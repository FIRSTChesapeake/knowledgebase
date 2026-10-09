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
load_env() {
  local env_file="${KB_ENV_FILE:-$REPO_ROOT/.env}"
  if [[ -f "$env_file" ]]; then
    set -o allexport
    # shellcheck disable=SC1090
    source "$env_file"
    set +o allexport
  fi
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
