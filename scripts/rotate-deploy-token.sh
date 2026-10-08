#!/usr/bin/env bash
# Mint a new kb-deployer token and store it as the production environment's
# KUBECONFIG_KB secret, with its expiry in the repo variable
# KUBECONFIG_KB_EXPIRES. Run by a cluster admin, with the admin kubeconfig
# named in .env (KB_ADMIN_KUBECONFIG, KB_ADMIN_CONTEXT) or kubectl's default.
#
# Builds the kubeconfig as k8s-do/README.md ("Build the deploy kubeconfig")
# does, in a private temp directory removed on exit, and uploads it only
# once kb-deployer's permission checks pass. The token is never printed.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
cd "$REPO_ROOT"

(( $# == 0 )) || die "Takes no arguments: set values in .env (see .env.example)."

load_env

NS="${K8S_NAMESPACE:-}"
DURATION="${KB_TOKEN_DURATION:-2160h}"
valid_namespace "$NS" || die "K8S_NAMESPACE must be set to a namespace name."
[[ "$DURATION" =~ ^[1-9][0-9]*h$ ]] || die "KB_TOKEN_DURATION must be a number of hours, e.g. 2160h."
command -v kubectl &>/dev/null || die "kubectl not found."
# Checked first, so no token is minted that cannot be stored.
require_gh

admin=(kubectl)
if [[ -n "${KB_ADMIN_KUBECONFIG:-}" ]]; then admin+=(--kubeconfig "$KB_ADMIN_KUBECONFIG"); fi
if [[ -n "${KB_ADMIN_CONTEXT:-}" ]]; then admin+=(--context "$KB_ADMIN_CONTEXT"); fi

umask 077
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
kc="$tmp/kb-deployer.kubeconfig"

SERVER="$("${admin[@]}" config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
CA="$("${admin[@]}" config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
# Each value goes into the YAML below: one line, of the expected shape.
[[ "$SERVER" =~ ^https://[^[:space:]]+$ ]] || die "The admin context has no https API server address."
[[ "$CA" =~ ^[A-Za-z0-9+/=]+$ ]] || die "The admin context has no certificate-authority-data."

info "Minting a kb-deployer token in namespace $NS for $DURATION"
TOKEN="$("${admin[@]}" -n "$NS" create token kb-deployer --duration="$DURATION")"
[[ "$TOKEN" =~ $JWT_RE ]] || die "kubectl create token returned something that is not a token."

cat > "$kc" <<KUBECONFIG
apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: $SERVER
      certificate-authority-data: $CA
users:
  - name: kb-deployer
    user:
      token: $TOKEN
contexts:
  - name: kb-deployer
    context:
      cluster: cluster
      user: kb-deployer
      namespace: $NS
current-context: kb-deployer
KUBECONFIG

exp="$(token_exp <<<"$TOKEN" || true)"
unset TOKEN
[[ "$exp" =~ ^[0-9]+$ ]] || die "Could not read the new token's expiry. Nothing uploaded."
# The API server may cap the duration below what was asked.
if (( exp < $(date -u +%s) + ${DURATION%h} * 3600 - 86400 )); then
  warn "The API server capped the token below $DURATION: it expires $(iso_utc "$exp")."
fi

# The credential must deploy, and nothing more.
can_i() {
  local want="$1" got
  shift
  got="$(kubectl --kubeconfig "$kc" auth can-i "$@" 2>/dev/null || true)"
  [[ "$got" == "$want" ]] \
    || die "kb-deployer: auth can-i $* returned '${got:-an error}', want '$want'. Nothing uploaded."
  success "can-i $*: $want"
}
can_i yes patch deployments/knowledgebase
can_i no get secrets
can_i no get pods --subresource=log

upload_kubeconfig "$kc"

echo ""
success "KUBECONFIG_KB rotated on $REPO. Earlier tokens stay valid until they expire (k8s-do/README.md says how to revoke them)."
