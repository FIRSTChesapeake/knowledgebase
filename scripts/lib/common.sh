#!/usr/bin/env bash
# Shared by the scripts in scripts/: logging, .env loading, gh checks, and
# the KUBECONFIG_KB upload. Sourced, never run.
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

# The same namespace check the deploy workflow makes before rendering.
DNS_LABEL='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
valid_namespace() { [[ "$1" != *$'\n'* && "$1" =~ ^${DNS_LABEL}$ ]]; }

# A service account token: three base64url segments.
JWT_RE='^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'

# Prints the exp claim (epoch seconds) of the token read from stdin. The
# token is never an argument, so it never shows in the process list.
token_exp() {
  local token payload
  token="$(cat)"
  [[ "$token" =~ $JWT_RE ]] || return 1
  payload="$(cut -d. -f2 <<<"$token" | tr '_-' '/+')"
  while (( ${#payload} % 4 )); do payload+='='; done
  printf '%s' "$payload" | base64 -d 2>/dev/null | grep -o '"exp":[0-9]*' | head -n1 | cut -d: -f2
}

# Epoch seconds as an ISO 8601 UTC timestamp (GNU date, then BSD date).
iso_utc() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
}

# Uploads the kubeconfig at $1 as the production environment's KUBECONFIG_KB
# secret, and its token's expiry as the repo variable KUBECONFIG_KB_EXPIRES,
# which the deploy workflow checks. The file is piped to gh: neither it nor
# its token is printed or passed as an argument. Base64 on a single line
# with no trailing newline, which is what the workflow decodes.
upload_kubeconfig() {
  local file="$1" token exp now
  [[ -f "$file" ]] || die "Kubeconfig file not found: $file"
  token="$(sed -n 's/^[[:space:]]*token:[[:space:]]*//p' "$file" | head -n1 | tr -d "\"' ")"
  exp="$(token_exp <<<"$token" || true)"
  unset token
  [[ "$exp" =~ ^[0-9]+$ ]] \
    || die "No readable token expiry in $file: it must hold a kb-deployer token (see k8s-do/README.md). Nothing uploaded."
  now="$(date -u +%s)"
  (( exp > now )) || die "The token in $file expired at $(iso_utc "$exp"). Nothing uploaded."
  KUBECONFIG_KB_EXPIRES="$(iso_utc "$exp")"

  base64 < "$file" | tr -d '\n' | gh secret set KUBECONFIG_KB --env production --repo "$REPO"
  success "Secret   KUBECONFIG_KB (environment production)"
  set_variable KUBECONFIG_KB_EXPIRES
  info "Deploy token expires $KUBECONFIG_KB_EXPIRES ($(( (exp - now) / 86400 )) days from now)"
}
