# Kubernetes deployment

The knowledgebase runs on the cluster as a static nginx image (see the
repo's `Dockerfile`): Quartz builds the site inside the image build, and
nginx serves it. The `Deploy knowledgebase` workflow
(`.github/workflows/deploy.yml`) publishes each version tag to both GitHub
Pages and the cluster.

| File | Applied by |
|---|---|
| `network-policy.yaml`, `service.yaml`, `deployment.yaml`, `ingress.yaml` | CI, on every deploy |
| `bootstrap/namespace.yaml`, `bootstrap/deploy-rbac.yaml` | a cluster admin, once, by hand |

## Placeholders

The manifests carry three placeholders, rendered with `sed`:

| Placeholder | Source |
|---|---|
| `__PROJECT_NAMESPACE__` | repo variable `K8S_NAMESPACE` |
| `__APP_DOMAIN__` | repo variable `APP_DOMAIN` |
| `__IMAGE__` | the image the workflow just pushed, `ghcr.io/<owner>/knowledgebase:sha-<12-char commit>` |

The domain lives only in the `APP_DOMAIN` repo variable; nothing in this
directory names it. The image build also uses it as Quartz's `baseUrl`.

## GitHub settings

- Repo variables: `APP_DOMAIN` (the site's hostname) and `K8S_NAMESPACE`.
- Environment `production` with the secret `KUBECONFIG_KB` (see below).
- The GHCR package `knowledgebase` is **public**, so the cluster pulls it with
  no pull secret. A new package starts private: after the first push, set its
  visibility to public in the package settings, then re-run the deploy.

## Bootstrap (cluster admin, once)

With an admin kubeconfig:

```sh
NS=<namespace>                     # same value as K8S_NAMESPACE
render() {
  sed -e "s|__PROJECT_NAMESPACE__|$NS|g" "$1"
}
render k8s-do/bootstrap/namespace.yaml   | kubectl apply -f -
render k8s-do/bootstrap/deploy-rbac.yaml | kubectl apply -f -
```

`deploy-rbac.yaml` creates the `kb-deployer` ServiceAccount, a long-lived
token Secret for it, and a Role bound to it in that namespace only. The Role
grants what applying the app manifests, waiting on and undoing a rollout, and
printing failure diagnostics need: Deployments, ReplicaSets (read), Services,
Ingresses, NetworkPolicies, and read access to Pods, Pod logs and Events. It
has no access to Secrets, ConfigMaps or Jobs (the site has none), cannot
delete anything, and has nothing cluster-scoped. cert-manager creates the TLS
Certificate from the Ingress annotation under its own identity.

## Build the deploy kubeconfig

```sh
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
TOKEN=$(kubectl -n "$NS" get secret kb-deployer-token -o jsonpath='{.data.token}' | base64 -d)

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

kubectl --kubeconfig kb-deployer.kubeconfig auth can-i patch deployments   # yes
kubectl --kubeconfig kb-deployer.kubeconfig auth can-i get secrets         # no
base64 -w0 kb-deployer.kubeconfig    # paste into the KUBECONFIG_KB environment secret
rm kb-deployer.kubeconfig
```

## Rotate the deploy token

```sh
kubectl -n "$NS" delete secret kb-deployer-token
render k8s-do/bootstrap/deploy-rbac.yaml | kubectl apply -f -
```

The old token stops working when its Secret is deleted. Rebuild the
kubeconfig as above and update `KUBECONFIG_KB`.

## Rollback

A rollout that does not become ready within five minutes is rolled back
by the workflow to the revision that was running before, and the run fails.
To roll back by hand:

```sh
kubectl -n "$NS" rollout undo deployment/knowledgebase
```

Or re-run the workflow for an earlier version tag.

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
