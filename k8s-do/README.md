# Kubernetes deployment

The knowledgebase runs on the cluster as a static nginx image (see the
repo's `Dockerfile`): Quartz builds the site inside the image build, and
nginx serves it. The `Deploy knowledgebase` workflow
(`.github/workflows/deploy.yml`) publishes each version tag to both GitHub
Pages and the cluster.

| File | Applied by |
|---|---|
| `service.yaml`, `deployment.yaml`, `ingress.yaml` | CI, on every deploy |
| `bootstrap/namespace.yaml`, `bootstrap/network-policy.yaml`, `bootstrap/deploy-rbac.yaml`, `bootstrap/admission-policy.yaml` | a cluster admin, once, by hand |

## Placeholders

The app manifests carry three placeholders, rendered by the workflow with
`sed`:

| Placeholder | Source |
|---|---|
| `__PROJECT_NAMESPACE__` | repo variable `K8S_NAMESPACE` |
| `__APP_DOMAIN__` | repo variable `APP_DOMAIN` |
| `__IMAGE__` | the image the workflow just pushed, by digest: `ghcr.io/<owner>/knowledgebase@sha256:<digest>` |

The bootstrap manifests use `__PROJECT_NAMESPACE__` and `__APP_DOMAIN__`,
plus `__GHCR_OWNER__` (the repo owner in lowercase), rendered by hand (see
below).

Nothing in `k8s-do/` names the domain: it comes from the `APP_DOMAIN` repo
variable, which the image build also uses as Quartz's `baseUrl`. The
committed `quartz.config.yaml` keeps the GitHub Pages `baseUrl`.

## GitHub settings

- Repo variables: `APP_DOMAIN` (the site's hostname), `K8S_NAMESPACE`, and
  `KUBECONFIG_KB_EXPIRES` (the deploy token's expiry, set with it; see below).
- Environment `production` with the secret `KUBECONFIG_KB` (see below).

These are pushed from an ignored `.env`: copy `.env.example` to `.env`,
fill it in, and run `scripts/upload-github-secrets.sh` (needs `gh`, logged
in with admin rights on the repo). It sets the two repo variables and skips
any value left empty with a warning. `KUBECONFIG_KB` is set by
`scripts/rotate-deploy-token.sh` (below), or by the upload script from a
kubeconfig built by hand when `KUBECONFIG_KB_FILE` names it. The settings
that follow are made in the GitHub UI.
- The GHCR package `knowledgebase` is **public**, so the cluster pulls it with
  no pull secret. A new package starts private: after the first push, set its
  visibility to public in the package settings, then re-run the deploy.
- Package settings, **Manage Actions access**: only this repository, with
  the **Write** role; no other repository. Under **Manage access**, no
  person beyond the maintainers has write. Anyone who can push to the
  package can put an image under a digest, though only a digest the
  workflow itself printed is ever deployed.

### Required: who can deploy

The workflow's guard job (the deployed commit must be on `main`) runs from
the workflow file at the deployed ref, so a tag pushed on an unmerged
commit could carry an edited workflow that skips it. The guard is a safety
net, not the security control. These repo settings are, and they are
required before `KUBECONFIG_KB` is stored:

- Environment `production`:
  - **Deployment branches and tags:** selected only, with the single rule
    tag `v*`;
  - **Required reviewers:** at least one maintainer;
  - **Prevent self-review:** on, so whoever pushed the tag or dispatched
    the run cannot approve it;
  - **Allow administrators to bypass configured protection rules:** off.
- Environment `image-publish` (the job that pushes to GHCR): **Deployment
  branches and tags:** selected only, the single rule tag `v*`. No reviewers
  needed. Like the guard, it stops the unmodified workflow from pushing an
  image from any other ref; it is not a control against someone who can
  push to the repo, since an environment only gates the jobs that name it
  and an edited workflow on a branch can drop it. The cluster deploy only
  ever uses the digest its own run pushed, so an image pushed that way is
  never deployed by the workflow.
- Optional hardening: a **branch ruleset** on all branches that restricts
  changes to `.github/workflows/**` to maintainers, so a repo writer
  cannot run an edited workflow with the repo's token at all.
- Environment `github-pages`: add the tag rule `v*` to its deployment
  branches and tags, or the tag-triggered Pages deploy is refused.
- A **tag ruleset** targeting `v*`: restrict creations, updates and
  deletions to maintainers, with no bypass for anyone else.

Before approving a `production` deployment, the reviewer checks, on the
run's summary page:

1. the run is for a `v*` tag (a dispatch from a branch is refused by the
   environment, so anything else means the settings above have drifted);
2. the tagged commit is on `main`: open the commit and check GitHub shows
   it on `main`, not only on the tag;
3. `.github/workflows/deploy.yml` at that commit is the one on `main`,
   unmodified: `git diff origin/main <tag> -- .github/workflows/deploy.yml`
   prints nothing.

## Bootstrap (cluster admin, once)

With an admin kubeconfig:

```sh
set -u
NS=<namespace>                     # same value as K8S_NAMESPACE
APP_DOMAIN=<host>                  # same value as APP_DOMAIN
GHCR_OWNER=<owner, lowercase>      # owner of the GitHub repo, e.g. firstchesapeake
render() {
  local label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  if [[ "$NS" == *$'\n'* || ! "$NS" =~ ^${label}$ ]] \
     || [[ "$APP_DOMAIN" == *$'\n'* || ${#APP_DOMAIN} -gt 253 || ! "$APP_DOMAIN" =~ ^${label}(\.${label})+$ ]] \
     || [[ "$GHCR_OWNER" == *$'\n'* || ! "$GHCR_OWNER" =~ ^[a-z0-9-]+$ ]]; then
    echo "render: NS, APP_DOMAIN or GHCR_OWNER is not valid; nothing rendered" >&2
    return 1
  fi
  sed -e "s|__PROJECT_NAMESPACE__|$NS|g" \
      -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" \
      -e "s|__GHCR_OWNER__|$GHCR_OWNER|g" "$1"
}
render k8s-do/bootstrap/namespace.yaml        | kubectl apply -f -
render k8s-do/bootstrap/network-policy.yaml   | kubectl apply -f -
render k8s-do/bootstrap/deploy-rbac.yaml      | kubectl apply -f -
render k8s-do/bootstrap/admission-policy.yaml | kubectl apply -f -
```

`render` checks the three values the same way the workflow does (a
namespace name, a lowercase hostname, a lowercase GitHub owner) and prints
nothing when one is wrong, so `kubectl apply` gets no objects and applies
nothing.

### Migrating a cluster bootstrapped before the NetworkPolicies moved here

CI used to apply the NetworkPolicies, and `kb-deployer` could write them.
After running the block above, in this order:

1. Re-apply the Role (the block above did; `apply` replaces its rules):
   `render k8s-do/bootstrap/deploy-rbac.yaml | kubectl apply -f -`.
2. Check the credential lost them; this must print `no`:
   `kubectl auth can-i create networkpolicies --as=system:serviceaccount:$NS:kb-deployer -n "$NS"`.
3. Delete the old NetworkPolicy admission policy and its binding, which
   `apply` does not remove:
   `kubectl delete validatingadmissionpolicybinding "$NS-kb-deployer-networkpolicies"` and
   `kubectl delete validatingadmissionpolicy "$NS-kb-deployer-networkpolicies"`.
4. Check that exactly the three policies in `network-policy.yaml` remain
   (`default-namespace-isolation`, `allow-acme-solver`,
   `default-deny-egress`), and delete anything else:
   `kubectl get netpol -n "$NS"`.

Re-apply after changing `APP_DOMAIN`: the Ingress policy admits only that
host, so the next deploy with a new domain is refused until it is.

What each file sets up:

- `namespace.yaml`: the namespace, with Pod Security `restricted` enforced
  (no privileged, host-namespace or hostPath pods, for anyone), a
  ResourceQuota (pods, CPU and memory, no PVCs, no LoadBalancer or
  NodePort Services) and a LimitRange. cert-manager's HTTP-01 solver pods
  meet the `restricted` profile. If the namespace already has pods, check
  them first:
  `kubectl label --dry-run=server --overwrite ns "$NS" pod-security.kubernetes.io/enforce=restricted`.
  The label only binds if the API server's Pod Security admission
  configuration exempts nothing that applies here: an exempted username,
  namespace or RuntimeClass skips `restricted` entirely. Confirm the
  cluster's `AdmissionConfiguration` (the `PodSecurity` plugin's
  `exemptions`) is empty, or names nothing in this namespace.
- `network-policy.yaml`: the namespace's network boundary. Pods accept
  traffic only from this namespace and from `ingress-nginx`, and send
  none. CI does not apply it and `kb-deployer` has no access to
  NetworkPolicies, so the deploy credential cannot open the namespace up.
- `deploy-rbac.yaml`: the `kb-deployer` ServiceAccount and a Role bound to it
  in that namespace only. The Role grants what applying the app manifests,
  waiting on and undoing a rollout, and failure diagnostics need: create
  Deployments, Services and Ingresses, update them only by their names in
  this directory, and read ReplicaSets, Pods and Events. It has no Secrets,
  ConfigMaps, NetworkPolicies or pod logs, cannot delete anything, and has
  nothing cluster-scoped.
- `admission-policy.yaml`: ValidatingAdmissionPolicies that bound what
  `kb-deployer` may write, since RBAC alone cannot. Without them, creating a
  Deployment would let the credential run any pod (and read any Secret that
  pod mounts), and creating an Ingress would let it claim any hostname on
  the shared load balancer and get a certificate for it. They admit only:
  - the Deployment `knowledgebase`, with emptyDir volumes only, the default
    ServiceAccount, `automountServiceAccountToken: false`, images
    `ghcr.io/<owner>/knowledgebase@sha256:<digest>`, literal environment
    values (no Secret or ConfigMap references), no command override, no
    lifecycle hooks, probes only `httpGet` on `/healthz`, every container
    with a read-only root filesystem and no privilege escalation, and no
    say over placement or runtime (no `nodeName`, `nodeSelector`,
    `affinity`, `tolerations`, `priorityClassName`, `runtimeClassName`,
    `hostAliases` or ephemeral containers, and only the default scheduler);
  - the Ingress `knowledgebase`, class `nginx`, every host equal to
    `APP_DOMAIN`, TLS required and in `knowledgebase-tls`, plain `Prefix` or
    `Exact` paths, the `letsencrypt-prod`
    ClusterIssuer and no other annotation (in particular no
    `nginx.ingress.kubernetes.io/*`);
  - the ClusterIP Service `knowledgebase`.

  They match only requests made as `kb-deployer`; cert-manager's own
  solver objects and an admin's changes are not affected. cert-manager
  creates the TLS Certificate from the Ingress annotation under its own
  identity.

Check that the policies bite: every command below must be refused (each
is a server-side dry run, so nothing changes even if one is admitted).
The patches and the annotation act on the live objects, so run the check
after the first deploy.

```sh
AS="--as=system:serviceaccount:$NS:kb-deployer"
D="-n $NS $AS --dry-run=server -o name"
kubectl $D patch deployment knowledgebase --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"h","hostPath":{"path":"/"}}}]'
kubectl $D patch deployment knowledgebase --type=json \
  -p '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe","value":{"exec":{"command":["id"]}}}]'
kubectl $D patch deployment knowledgebase --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/lifecycle","value":{"postStart":{"exec":{"command":["id"]}}}}]'
kubectl $D patch deployment knowledgebase --type=json \
  -p '[{"op":"replace","path":"/spec/template/spec/containers/0/securityContext/readOnlyRootFilesystem","value":false}]'
kubectl $D patch deployment knowledgebase --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/tolerations","value":[{"operator":"Exists"}]}]'
kubectl $D patch deployment knowledgebase --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/nodeName","value":"any-node"}]'
kubectl $D create deployment probe --image=nginx
kubectl $D create ingress probe --rule="other.example/=knowledgebase:80"
kubectl $D annotate ingress knowledgebase nginx.ingress.kubernetes.io/server-snippet=x
kubectl $D patch service knowledgebase -p '{"spec":{"type":"LoadBalancer"}}'
kubectl $D create -f - <<'EOF'
{"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"probe"},"spec":{"podSelector":{}}}
EOF
```

## Build the deploy kubeconfig

The credential is a time-bound token (there is no long-lived token Secret),
90 days by default. With the admin kubeconfig at hand and `.env` filled in
(`K8S_NAMESPACE`; `KB_ADMIN_KUBECONFIG` / `KB_ADMIN_CONTEXT` when the admin
context is not kubectl's default; `KB_TOKEN_DURATION` to change the
lifetime), one command does all of this section:

```sh
scripts/rotate-deploy-token.sh
```

It mints the token, builds the kubeconfig below in a private temp directory
(removed on exit), runs the three `can-i` checks and uploads nothing unless
they pass, prints the token's real expiry, and stores the kubeconfig as
`KUBECONFIG_KB` and the expiry as `KUBECONFIG_KB_EXPIRES`. Neither the
token nor the kubeconfig is printed.

By hand, as a fallback:

```sh
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
TOKEN=$(kubectl -n "$NS" create token kb-deployer --duration=2160h)

umask 077
cat > kb-deployer.kubeconfig <<EOF
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
EOF

kubectl --kubeconfig kb-deployer.kubeconfig auth can-i patch deployments/knowledgebase   # yes
kubectl --kubeconfig kb-deployer.kubeconfig auth can-i get secrets                       # no
kubectl --kubeconfig kb-deployer.kubeconfig auth can-i get pods --subresource=log        # no
KUBECONFIG_KB_FILE=kb-deployer.kubeconfig scripts/upload-github-secrets.sh
rm kb-deployer.kubeconfig
```

The upload script reads the token's expiry from the file, stores it as
`KUBECONFIG_KB_EXPIRES` along with the secret, and refuses an expired
token. Without `gh`: paste `base64 -w0 kb-deployer.kubeconfig` into the
`KUBECONFIG_KB` environment secret, and set the repo variable
`KUBECONFIG_KB_EXPIRES` to the expiry as `YYYY-MM-DDTHH:MM:SSZ` (UTC).

The API server may cap the duration below what was asked. The token's
real expiry, in seconds since the epoch:

```sh
cut -d. -f2 <<<"$TOKEN" | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '"exp":[0-9]*'
```

## Rotate the deploy token

Run `scripts/rotate-deploy-token.sh` again before the token expires. The
deploy job checks `KUBECONFIG_KB_EXPIRES` first: from 14 days before the
expiry every run warns, and once the token has expired the run fails
with a message saying so, before anything is applied. Without the variable
it warns that the expiry is unknown. Renewing does not revoke the old
token; it stays valid until its own expiry. To cut off every token issued so far at once
(a leaked token), recreate the ServiceAccount: tokens are bound to its UID.

```sh
kubectl -n "$NS" delete serviceaccount kb-deployer
render k8s-do/bootstrap/deploy-rbac.yaml | kubectl apply -f -
```

then run `scripts/rotate-deploy-token.sh`. A cluster bootstrapped before the
switch to time-bound tokens still has a `kb-deployer-token` Secret holding a
token that never expires; delete it:
`kubectl -n "$NS" delete secret kb-deployer-token --ignore-not-found`.

## Rollback

A rollout that does not become ready within five minutes is rolled back
by the workflow to the revision that was running before, and the run fails.
To roll back by hand:

```sh
kubectl -n "$NS" rollout undo deployment/knowledgebase
```

Re-running the workflow for an earlier version tag works only for a tag
whose `deploy.yml` is the one on `main` (item 3 of the reviewer checklist):
a tag cut before the NetworkPolicies moved to the bootstrap carries a
workflow that still applies them, which `kb-deployer` may no longer do, so
its run fails before the Deployment changes. Return to such a version with
`rollout undo` instead. The admission policy only admits images pinned by
digest, so `kb-deployer` cannot roll back to a revision deployed by tag
before the switch to digests; an admin can.

## Cutover checklist

1. Deploy (push a version tag, or dispatch the workflow from a `v*` tag;
   a dispatch from a branch is refused) while GitHub Pages is still live.
   Make the GHCR package public if this is the
   first push, and re-run the deploy if it failed on the image pull.
2. Point a DNS record for the `APP_DOMAIN` host at the ingress load balancer.
3. Wait until the `knowledgebase-tls` Certificate is Ready:
   `kubectl -n "$NS" get certificate knowledgebase-tls`.
4. Check on the new host:
   - `/` loads;
   - search works: `/static/contentIndex.json` loads and a query returns results;
   - a deep link to a page, and a folder page (e.g. `/FRC/`);
   - a missing page shows the 404 page with status 404;
   - `/sitemap.xml` and `/index.xml` list URLs on the new host.
5. Then update links to the site, and retire GitHub Pages after the grace
   period.
