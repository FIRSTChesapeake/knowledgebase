#!/usr/bin/env bash
# Push .env values to GitHub Actions: the repo variables APP_DOMAIN and
# K8S_NAMESPACE, and, when KUBECONFIG_KB_FILE names a kubeconfig, the
# production environment secret KUBECONFIG_KB plus its expiry
# (KUBECONFIG_KB_EXPIRES). Values left unset are skipped with a warning.
#
# The kubeconfig is only ever read from the file KUBECONFIG_KB_FILE names
# (in .env or the environment), never from an argument. To mint a new
# deploy token and upload it in one go, use scripts/rotate-deploy-token.sh.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
cd "$REPO_ROOT"

(( $# == 0 )) || die "Takes no arguments: set values in .env (see .env.example)."

load_env
require_gh

info "Syncing secrets and variables to $REPO"

set_variable APP_DOMAIN
set_variable K8S_NAMESPACE

if [[ -n "${KUBECONFIG_KB_FILE:-}" ]]; then
  upload_kubeconfig "$KUBECONFIG_KB_FILE"
else
  warn "Skipping secret KUBECONFIG_KB — KUBECONFIG_KB_FILE not set (scripts/rotate-deploy-token.sh mints and uploads one)"
fi

echo ""
success "GitHub Actions secrets and variables synced to $REPO"
