# Kubernetes deployment

The knowledgebase runs on the CHS cluster as a static nginx image (see the
repo's `Dockerfile`): Quartz builds the site inside the image build, and
nginx serves it. The `Deploy knowledgebase` workflow
(`.github/workflows/deploy.yml`) releases each version tag to the cluster,
the site's only home: GitHub Pages is no longer published.

Nothing here deploys anything. A release pushes two packages to GHCR, the
image and a release artifact of this directory, and the cluster pulls the
artifact itself (Flux, configured in the cluster's config repo,
`FIRSTChesapeake/chs-cluster-config`). The workflow holds no cluster
credential and no secret but its own `GITHUB_TOKEN`.

## What is in `k8s-do/`

| File | What it is |
|---|---|
| `service.yaml`, `deployment.yaml`, `ingress.yaml` | the app: a ClusterIP Service, the nginx Deployment, the Ingress with TLS |
| `kustomization.yaml` | lists the three files; nothing else |

- **The image is the bare name `knowledgebase`.** The release workflow pins
  it to the digest it just pushed (`kustomize edit set image`) in its own
  copy of `kustomization.yaml`, and only that copy goes into the artifact;
  git never holds a digest. An un-pinned manifest fails closed: the
  cluster's admission policy only admits the image by `@sha256` digest.
- **`${APP_DOMAIN}`** in the Ingress is the only substitution variable. The
  cluster fills it in when it applies a release (Flux `postBuild`), from
  the value the config repo sets for the `kb` tenant.
- **No namespace** in any file: the config repo sets the target namespace.
- No Secrets, no generators, no `commonLabels` (they would rewrite the
  Deployment's selector, which is immutable).

The site's hostname is set twice and must match: the repo variable
`APP_DOMAIN` is baked into the image as Quartz's `baseUrl` (links, sitemap,
RSS), and the config repo's `APP_DOMAIN` is the Ingress host. The image
build replaces the `baseUrl` in `quartz.config.yaml` with `APP_DOMAIN`, so
the committed value is not what the site uses.

## Where the hardening lives

The namespace, its Pod Security level, ResourceQuota and LimitRange, the
NetworkPolicies, the deployer Role that the cluster applies releases as, and
the admission policies that bound what a release may contain all live in
the config repo, under `tenants/kb/`. They change by a pull request there,
reviewed by a cluster admin, never from this repo.

## Releasing

1. Merge to `main`.
2. Push a version tag `vX.Y.Z` on a commit on `main`. Only maintainers can
   (tag ruleset, below).
3. The workflow checks the commit is on `main`, then:
   - builds and pushes the image `ghcr.io/firstchesapeake/knowledgebase`,
     tagged with the version and `sha-<commit>`;
   - bakes the image's digest into `k8s-do/`, checks the built release
     (every image pinned to that digest, no Secret), refuses a version
     already published, and pushes the artifact
     `oci://ghcr.io/firstchesapeake/manifests/knowledgebase:vX.Y.Z`.
4. The cluster polls for new artifacts every 2 minutes and deploys the
   highest version within its range, so the release is live within about
   2–4 minutes. Slack reports the new version and the result of the
   rollout.

A release tag is never re-published: the workflow fails rather than
overwrite an existing artifact. Cut a new tag instead. The cluster's range
also has a floor and a ceiling (the next CalVer year): a new major version
needs a one-line change in the config repo.

## Rollback

Deleting or moving a git tag rolls nothing back: the artifact stays in GHCR,
and the cluster always takes the highest version in its range.

- **Roll forward (normal).** Revert the bad change on `main`, tag the next
  patch version, and let it release. A cluster admin can hurry the pick-up
  with `flux reconcile source oci knowledgebase -n flux-system`.
- **Admin pin (emergency).** A cluster admin pins the source to a known-good
  tag in the config repo, which freezes the site at that version until the
  pin is removed. Once a fixed version above the bad one is released, the
  admin restores the version range with its floor raised past the bad
  version. Never restore the range while the bad version is still the
  highest: that deploys it again.

A rollout whose pods never become ready never takes traffic: the old pods
keep serving, and Slack reports the failure.

## GitHub settings

- Repo variable `APP_DOMAIN` (the site's hostname), read by the image
  build. It is pushed from an ignored `.env`: copy `.env.example` to
  `.env`, fill it in, and run `scripts/upload-github-secrets.sh` (needs
  `gh`, logged in with admin rights on the repo). A value left empty is
  skipped with a warning. Nothing else is stored in GitHub: no cluster
  credential, no secret.

The settings that follow are made in the GitHub UI.

- Both GHCR packages, `knowledgebase` (the image) and
  `manifests/knowledgebase` (the release artifact), are **public**, so the
  cluster pulls them with no credential. A new package starts private:
  after the first release, set each one's visibility to public in its
  package settings. The cluster retries on its own; nothing needs
  re-running.
- Each package's settings, **Manage Actions access**: only this repository,
  with the **Write** role; no other repository. Under **Manage access**, no
  person beyond the maintainers has write.

### Required: who can release

The workflow's guard job (the tagged commit must be on `main`) runs from
the workflow file at the tagged commit, so a tag pushed on an unmerged
commit could carry an edited workflow that skips it. The guard is a safety
net, not the security control. These repo settings are, and they are
required before the first release:

- Environment `image-publish` (the jobs that push to GHCR): **Deployment
  branches and tags:** selected only, the single rule tag `v*`. No reviewers
  needed. Like the guard, it stops the unmodified workflow from pushing from
  any other ref; it is not a control against someone who can push to the
  repo, since an environment only gates the jobs that name it and an edited
  workflow on a branch can drop it.
- A **tag ruleset** targeting `v*`: restrict creations, updates and
  deletions to maintainers, with no bypass for anyone else.
- Optional hardening: a **branch ruleset** on all branches that restricts
  changes to `.github/workflows/**` to maintainers.

**What these do not cover.** Any workflow in this repo that asks for
`packages: write`, including one edited on a branch, can push to the
packages with the repo's token, with no tag and no `main`. So who can
release is, in effect, who can write to this repo. Forks cannot: a fork's
pull request gets a read-only token. What a release can do on the cluster
is still bounded there: the version range, the deployer Role and the
admission policies in the config repo.

## Cutover checklist

1. Release (push a version tag on `main`). Make both GHCR packages public if
   this is the first release.
2. Point a DNS record for the `APP_DOMAIN` host at the ingress load balancer.
3. Wait until the `knowledgebase-tls` Certificate is Ready:
   `kubectl -n kb get certificate knowledgebase-tls`.
4. Check on the new host:
   - `/` loads;
   - search works: `/static/contentIndex.json` loads and a query returns results;
   - a deep link to a page, and a folder page (e.g. `/FRC/`);
   - a missing page shows the 404 page with status 404;
   - `/sitemap.xml` and `/index.xml` list URLs on the new host.
5. Update links to the site to the new host. GitHub Pages is no longer
   updated: its last copy stays up, stale, until Pages is turned off in the
   repo settings (Settings → Pages). The `github-pages` environment is no
   longer used.
