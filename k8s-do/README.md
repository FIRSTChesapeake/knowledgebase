# Kubernetes deployment

The knowledgebase runs on the CHS cluster as a static nginx image (see the
repo's `Dockerfile`): Quartz builds the site inside the image build, and
nginx serves it. The `Deploy knowledgebase` workflow
(`.github/workflows/deploy.yml`) releases each version tag to the cluster,
the site's only home: GitHub Pages is turned off.

Nothing here deploys anything. A release pushes two packages to GHCR, the
image and a release artifact of this directory, signs the artifact with
cosign, and the cluster pulls the artifact itself (Flux, configured in the
cluster's config repo, `FIRSTChesapeake/chs-cluster-config`). The workflow
holds no cluster credential. Its only secrets are its own `GITHUB_TOKEN` and
the signing key, which only the two jobs that never run this repo's code
can read (Release signing, below).

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
3. The workflow checks the commit is on `main`, checks that the signing
   key is set and decrypts (`preflight`), and checks that the tag is a
   release version `vX.Y.Z` (there are no pre-release tags), then:
   - refuses a version already published, before building anything;
   - builds and pushes the image `ghcr.io/firstchesapeake/knowledgebase`,
     tagged with the version only;
   - bakes the image's digest into `k8s-do/`, checks the built release
     (`scripts/check-release.mjs`: only a core Service, Deployment and
     Ingress, every image pinned to that digest, no namespace, nothing
     for the cluster to substitute but the Ingress host `${APP_DOMAIN}`,
     no YAML merge keys, and a kustomization that pulls in or generates
     nothing else), checks again that the
     version is unpublished, and pushes the artifact
     `oci://ghcr.io/firstchesapeake/manifests/knowledgebase:vX.Y.Z`;
   - signs that artifact by digest with cosign (`sign`; Release signing,
     below).

   Runs for the same tag queue rather than overlap, so two can't both
   find a version free.
4. The cluster polls for new artifacts every 2 minutes, verifies the
   signature, and deploys the highest version within its range, so the
   release is live within about
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

## Release signing

The `sign` job signs the artifact the `manifests` job pushed, by digest,
with a cosign key pair made for this repo. The private key and its password
are secrets of the `manifest-sign` environment. The public key is kept out
of the repo: a cluster admin creates it as the Secret
`flux-system/knowledgebase-cosign-pub`, under the key `cosign.pub`, and the
`kb` tenant's OCIRepository verifies every version against it before
applying anything. The cluster config repo's `docs/credentials.md` has the
exact command. The cluster therefore applies only what the release
workflow built and signed. A new artifact pushed any other way (another
workflow, a branch, a token) has no valid signature and is refused; copying
an older signed release to a new tag is not (the Known risk below). The
image needs no signature of its own: the signed artifact pins it by digest.

**Who holds the key.** GitHub hands a job every secret of its environment,
referenced or not, so the key has an environment of its own, and the two
jobs that run in it never run this repo's code:

| Job | Environment | Checks out the repo | Does |
|---|---|---|---|
| `guard` | none | yes | requires the tagged commit to be on `main` |
| `preflight` | `manifest-sign` | no | proves the key is set and decrypts, before anything is built or pushed |
| `image` | `image-publish` | yes | builds and pushes the image |
| `manifests` | none | yes | checks the release, refuses to overwrite, pushes, outputs the digest |
| `sign` | `manifest-sign` | no | re-checks the digest and the artifact address, signs by digest |

`preflight` and `sign` run only the pinned cosign installer, the registry
login and their own steps. A change to a script, the `Dockerfile` or
`k8s-do/` can change what the next release builds and `sign` signs (that is
what review on `main` is for), but it cannot read the key.
`tests/workflow-contract.test.ts` refuses a checkout or a repo file in
either job, and the cosign secrets anywhere but their two steps.

Nothing is sent to Sigstore. No job requests a GitHub OIDC token, no
certificate is issued, and the signature is not uploaded to the public
transparency log (Rekor): the workflow signs with `--tlog-upload=false`.
Flux verifies a static-key signature offline and does not look for a
transparency-log entry. The signature is stored in cosign's classic format,
as a `sha256-<digest>.sig` tag in the same public GHCR package; anyone can
read it, which is harmless.

If `sign` fails after the push, the version is spent: the cluster refuses
the unsigned artifact and stays on the previous version, and the workflow
refuses to push the same tag again. Cut the next patch version. A missing
key, or one that does not decrypt with its password, fails `preflight`
before anything is built or pushed.

**Known risk (accepted).** Any workflow in this repo can still write the
`manifests/knowledgebase` package, because GitHub grants package write per
repo, not per workflow. Someone with push access could therefore:

- copy an earlier signed release to a new, higher tag. Its signature still
  verifies, since it covers the digest, so the cluster rolls back to that
  older release (a replay);
- push an unsigned artifact under a high tag. Flux follows the highest
  version, fails to verify it and stops there: no later release deploys
  until it is gone (a deploy freeze).

Neither can deploy anything the release workflow did not build and sign.
To recover, delete that package version in GHCR (the package's settings →
Manage versions), then check that Flux is back on the intended version.

**Generating the key pair** (once, before the first signed tag), on a
trusted machine with cosign installed, in an empty directory:

```
cosign generate-key-pair
```

It asks for a password; use a long random one (`openssl rand -base64 32`)
and keep it in the maintainers' password manager. It writes `cosign.key`
(the private key, encrypted with that password) and `cosign.pub`.

1. In GitHub, Settings → Environments → `manifest-sign` → Environment
   secrets, add `COSIGN_PRIVATE_KEY` with the full contents of `cosign.key`
   and `COSIGN_PASSWORD` with the password.
2. Give `cosign.pub` to a cluster admin, who creates the Secret
   `flux-system/knowledgebase-cosign-pub` (key `cosign.pub`) as the cluster
   config repo's `docs/credentials.md` describes. It is never committed,
   there or here.
3. Keep `cosign.key`, its password and `cosign.pub` in the password
   manager, then delete the local copies. The private key and password
   never go into this repo or the cluster.

**Rotating the key** (on a schedule, or at once if the private key or
password may have leaked, or a maintainer with access leaves):

1. Generate a new pair as above.
2. Have a cluster admin add the new public key to the Secret
   `flux-system/knowledgebase-cosign-pub` beside the old one, under a second
   key name ending in `.pub`. Flux accepts a version signed by any `.pub`
   key in that Secret.
3. Replace both environment secrets with the new values.
4. Cut a release and check that the cluster applies it.
5. Re-sign, with the new key, any earlier release you may still roll back
   to. This adds a signature beside the old one and changes nothing else:

   ```
   cosign sign --yes --key cosign.key \
     --tlog-upload=false --use-signing-config=false --new-bundle-format=false \
     ghcr.io/firstchesapeake/manifests/knowledgebase@<digest>
   ```

   cosign asks for the password. Take `<digest>` from
   `flux get sources oci` or from that release's `Deploy knowledgebase` run
   log, never from a tag you have not checked.
6. Have a cluster admin remove the old public key from the Secret, leaving
   the new one under `cosign.pub`. From then on an artifact signed only with
   the old key is refused.

On a suspected leak, remove the old key (step 6) straight after step 3,
before the next release, and re-sign only releases whose digests you took
from a trusted record from before the leak.

To check a release by hand, with the public key from the password manager
or the cluster's Secret:

```
cosign verify --key cosign.pub --insecure-ignore-tlog=true \
  --new-bundle-format=false \
  ghcr.io/firstchesapeake/manifests/knowledgebase:v1.2.3
```

**Order.** Set up `manifest-sign` and its key (above, and GitHub settings
below), then cut a release: it is the first signed one. Only after it has
deployed does the cluster config repo add `verify:` to the `kb` tenant's
OCIRepository. If `verify:` comes first while the highest version in range
is unsigned, the source reports a verification failure and the cluster
stays on what it last applied: nothing breaks, but no release deploys until
a signed one is the highest in range.

## GitHub settings

- Repo variable `APP_DOMAIN` (the site's hostname), read by the image
  build. It is pushed from an ignored `.env`: copy `.env.example` to
  `.env`, fill it in, and run `scripts/set-github-variables.sh` (needs
  `gh`, logged in with admin rights on the repo). A value left empty is
  skipped with a warning. Nothing else is stored in GitHub but the signing
  key's two `manifest-sign` secrets (Release signing, above): no cluster
  credential.

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
net, not the security control. Nor is the registry: any workflow on any
branch can push to GHCR with the repo's token. What protects a release is
the signature the cluster verifies (Release signing, above), and these repo
settings decide who can start a signed release and what it builds. They are
required before the first signed release:

- A **tag ruleset** targeting `v*`: creation restricted to maintainers,
  update and deletion blocked, with no bypass for anyone else. This ruleset
  is the real control: whoever can create a `v*` tag can run the workflow,
  edited or not, with the signing key. A released tag is never moved.
- Environment `manifest-sign` (the `preflight` and `sign` jobs only):
  **Deployment branches and tags:** selected only, the single rule
  **Ref type: Tag**, pattern `v*`. Make it a tag rule, not a branch rule: a
  branch rule `v*` would admit any branch whose name starts with `v`, and a
  job on that branch would get the environment's secrets. It holds exactly
  two secrets, `COSIGN_PRIVATE_KEY` and `COSIGN_PASSWORD` (Release
  signing, above). A job on any other ref that names the environment is
  refused before it starts. No required reviewers that someone could
  approve for a non-tag ref, and never copy the secrets to repository or
  organization level.
- Environment `image-publish` (the `image` job): **Deployment
  branches and tags:** selected only, the single rule tag `v*`. No reviewers
  and no secrets. Like the guard, it stops the unmodified workflow from
  pushing from any other ref; it is not a control against someone who can
  push to the repo, since an environment only gates the jobs that name it
  and an edited workflow on a branch can drop it. The `manifests` job used
  to run here too; it now has no environment.
- **Only maintainers can change workflows.** Any workflow that asks for
  `packages: write`, including one edited on a branch, can push to the
  `manifests/knowledgebase` package with the repo's token, skipping the
  guard, the environments, the tag ruleset and `main`. Once the cluster
  verifies signatures it refuses such an artifact, but it can still replay
  an older signed release or freeze deploys (Release signing, Known risk);
  until then the cluster would deploy it if its version is the highest.
  So one of these is required:
  - a **push ruleset** (Settings → Rules → Rulesets → New ruleset → New
    push ruleset): name `workflows`, **Enforcement status** Active,
    **Bypass list** only the roles maintainers hold (Repository admin, and
    Maintain if they use it), rule
    **Restrict file paths** with the path `.github/workflows/**`. It applies
    to every branch and refuses a push that changes a workflow from anyone
    not on the bypass list;
  - or, if GitHub does not offer push rulesets for this repo (they depend
    on the plan and the repo's visibility), **write access for maintainers
    only** (Settings → Collaborators and teams): everyone else gets Read or
    Triage and contributes by pull request from a fork. A fork's pull
    request runs with a read-only token and can push nothing.
- Branch protection on `main` requires the **Light tests** and
  **actionlint** checks (the Tests workflow), so nothing is merged, and
  then released, without the contract tests passing; and **a maintainer's
  review** of every change: either a `CODEOWNERS` file whose `*` entry
  names the maintainers, with "Require review from Code Owners" turned on,
  or write access for maintainers only. A merged change is what the next
  tag builds and signs.

What a release can do on the cluster is still bounded there: the version
range, the deployer Role and the admission policies in the config repo.

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
5. Update links to the site to the new host. GitHub Pages is turned off and
   the `github-pages` environment deleted; the old
   `firstchesapeake.github.io/knowledgebase` address no longer serves the site.
