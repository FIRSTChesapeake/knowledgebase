#!/usr/bin/env bash
# Push .env values to GitHub Actions: the repo variable APP_DOMAIN, which
# the release workflow's image build reads. A value left unset is skipped
# with a warning. Namespace and cluster settings are not here: they live in
# the cluster's config repo (see k8s-do/README.md).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
cd "$REPO_ROOT"

(( $# == 0 )) || die "Takes no arguments: set values in .env (see .env.example)."

load_env
require_gh

info "Syncing variables to $REPO"

set_variable APP_DOMAIN

echo ""
success "GitHub Actions variables synced to $REPO"
