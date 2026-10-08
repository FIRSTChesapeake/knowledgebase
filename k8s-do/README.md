# Kubernetes deployment

The knowledgebase runs on the cluster as a static nginx image (see the
repo's `Dockerfile`): Quartz builds the site inside the image build, and
nginx serves it. The `Deploy knowledgebase` workflow
(`.github/workflows/deploy.yml`) publishes each version tag to both GitHub
Pages and the cluster.

| File | Applied by |
|---|---|
| `network-policy.yaml`, `service.yaml`, `deployment.yaml`, `ingress.yaml` | CI, on every deploy |
| `bootstrap/namespace.yaml`, `bootstrap/deploy-rbac.yaml`, `bootstrap/admission-policy.yaml` | a cluster admin, once, by hand |

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

- Repo variables: `APP_DOMAIN` (the site's hostname) and `K8S_NAMESPACE`.
- Environment `production` with the secret `KUBECONFIG_KB` (see below).
- The GHCR package `knowledgebase` is **public**, so the cluster pulls it with
  no pull secret. A new package starts private: after the first push, set its
  visibility to public in the package settings, then re-run the deploy.

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
  - **Allow administrators to bypass configured protection rules:** off.
- Environment `github-pages`: add the tag rule `v*` to its deployment
  branches and tags, or the tag-triggered Pages deploy is refused.
- A **tag ruleset** targeting `v*`: restrict creations, updates and
  deletions to maintainers, with no bypass for anyone else.

## Bootstrap (cluster admin, once)

With an admin kubeconfig:

```sh
NS=<namespace>                     # same value as K8S_NAMESPACE
APP_DOMAIN=<host>                  # same value as APP_DOMAIN
GHCR_OWNER=<owner, lowercase>      # owner of the GitHub repo, e.g. firstchesapeake
render() {
  sed -e "s|__PROJECT_NAMESPACE__|$NS|g" \
      -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" \
      -e "s|__GHCR_OWNER__|$GHCR_OWNER|g" "$1"
}
render k8s-do/bootstrap/namespace.yaml        | kubectl apply -f -
render k8s-do/bootstrap/deploy-rbac.yaml      | kubectl apply -f -
render k8s-do/bootstrap/admission-policy.yaml | kubectl apply -f -
```

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
- `deploy-rbac.yaml`: the `kb-deployer` ServiceAccount and a Role bound to it
  in that namespace only. The Role grants what applying the app manifests,
  waiting on and undoing a rollout, and failure diagnostics need: create
  Deployments, Services, Ingresses and NetworkPolicies, update them only by
  their names in this directory, and read ReplicaSets, Pods and Events. It
  has no Secrets, ConfigMaps or pod logs, cannot delete anything, and has
  nothing cluster-scoped.
- `admission-policy.yaml`: ValidatingAdmissionPolicies that bound what
  `kb-deployer` may write, since RBAC alone cannot. Without them, creating a
  Deployment would let the credential run any pod (and read any Secret that
  pod mounts), and creating an Ingress would let it claim any hostname on
  the shared load balancer and get a certificate for it. They admit only:
  - the Deployment `knowledgebase`, with emptyDir volumes only, the default
    ServiceAccount, `automountServiceAccountToken: false`, images
    `ghcr.io/<owner>/knowledgebase@sha256:<digest>`, literal environment
    values (no Secret or ConfigMap references) and no command override;
  - the Ingress `knowledgebase`, class `nginx`, every host equal to
    `APP_DOMAIN`, TLS in `knowledgebase-tls`, the `letsencrypt-prod`
    ClusterIssuer and no other annotation (in particular no
    `nginx.ingress.kubernetes.io/*`);
  - the ClusterIP Service `knowledgebase`, and the three NetworkPolicies in
    `network-policy.yaml`.

  They match only requests made as `kb-deployer`; cert-manager's own
  solver objects and an admin's changes are not affected. cert-manager
  creates the TLS Certificate from the Ingress annotation under its own
  identity.

Check that the policies bite (each `apply` must be refused):

```sh
AS="--as=system:serviceaccount:$NS:kb-deployer"
kubectl -n "$NS" $AS create deployment probe --image=nginx --dry-run=server -o name
kubectl -n "$NS" $AS create ingress probe --rule="other.example/=knowledgebase:80" --dry-run=server -o name
```

## Build the deploy kubeconfig

The credential is a time-bound token (there is no long-lived token Secret).
90 days here; pick what suits the rotation calendar.

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
base64 -w0 kb-deployer.kubeconfig    # paste into the KUBECONFIG_KB environment secret
rm kb-deployer.kubeconfig
```

The API server may cap the duration below what was asked. Check the
token's real expiry, and put it in the rotation calendar:

```sh
cut -d. -f2 <<<"$TOKEN" | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '"exp":[0-9]*'
```

## Rotate the deploy token

Before the token expires (a deploy with an expired token fails at the
first `kubectl` call and changes nothing), build a new kubeconfig as above
and replace `KUBECONFIG_KB`. To cut off every token issued so far at once
(a leaked token), recreate the ServiceAccount: tokens are bound to its UID.

```sh
kubectl -n "$NS" delete serviceaccount kb-deployer
render k8s-do/bootstrap/deploy-rbac.yaml | kubectl apply -f -
```

then build and store a new kubeconfig. A cluster bootstrapped before the
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

Or re-run the workflow for an earlier version tag. The admission policy
only admits images pinned by digest, so `kb-deployer` cannot roll back to a
revision deployed by tag before the switch to digests; an admin can.

## Cutover checklist

1. Deploy (push a version tag, or dispatch the workflow on `main`) while
   GitHub Pages is still live. Make the GHCR package public if this is the
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
