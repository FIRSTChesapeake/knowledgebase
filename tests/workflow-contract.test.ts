// Contract tests for .github/workflows/deploy.yml.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { BAD_DOMAINS, GOOD_DOMAINS, deployWorkflow, readText, runBash, scratchDir } from "./helpers.ts"

const wf = deployWorkflow()
const jobs: Record<string, any> = wf.jobs
const raw = readText(".github/workflows/deploy.yml")

function needsOf(job: any): string[] {
  if (!job.needs) return []
  return Array.isArray(job.needs) ? job.needs : [job.needs]
}

function steps(): { job: string; step: any }[] {
  return Object.entries(jobs).flatMap(([job, j]) => (j.steps ?? []).map((step: any) => ({ job, step })))
}

const DIGEST = `sha256:${"a1".repeat(32)}`
const IMAGE = `ghcr.io/firstchesapeake/knowledgebase@${DIGEST}`
const MANIFESTS = "ghcr.io/firstchesapeake/manifests/knowledgebase"

describe("trigger and on-main guard", () => {
  test("the trigger is v* tags only: no workflow_dispatch, no branches", () => {
    assert.deepEqual(Object.keys(wf.on), ["push"])
    assert.deepEqual(wf.on.push, { tags: ["v[0-9]*.[0-9]*.[0-9]*"] })
    assert.ok(!raw.includes("workflow_dispatch"))
  })

  test("guard requires the commit to be on main, failing closed", () => {
    const run = jobs.guard.steps.map((s: any) => s.run ?? "").join("\n")
    assert.ok(run.includes('git merge-base --is-ancestor "$DEPLOY_SHA" refs/remotes/origin/main'))
    assert.ok(run.includes("git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main"))
    assert.ok(run.includes("git rev-parse --verify --quiet refs/remotes/origin/main"))
    assert.ok(jobs.guard.steps.some((s: any) => s.with?.["fetch-depth"] === 0))
  })

  test("every other job reaches guard through needs", () => {
    const reaches = (name: string, seen = new Set<string>()): boolean => {
      if (seen.has(name)) return false
      seen.add(name)
      return needsOf(jobs[name]).some((n) => n === "guard" || reaches(n, seen))
    }
    for (const name of Object.keys(jobs)) {
      if (name === "guard") continue
      assert.ok(jobs[name], name)
      assert.ok(reaches(name), `job ${name} does not depend on guard`)
    }
  })

  test("the header says the workflow holds no cluster credential and the cluster pulls", () => {
    assert.match(raw, /This workflow holds no cluster\n# credential/)
    assert.match(raw, /the cluster pulls the artifact\n# itself/)
  })
})

describe("no cluster credential", () => {
  test("no job references a kubeconfig, kubectl, helm, doctl or cosign", () => {
    assert.ok(!/kubeconfig|kubectl|\bhelm\b|doctl|cosign|attest-build-provenance/i.test(raw))
  })

  test("no secret other than GITHUB_TOKEN", () => {
    const secrets = [...raw.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1])
    assert.ok(secrets.length > 0)
    for (const s of secrets) assert.equal(s, "GITHUB_TOKEN")
  })

  test("no job runs in the old production environment", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const env = typeof job.environment === "string" ? job.environment : job.environment?.name
      assert.notEqual(env, "production", name)
    }
  })
})

describe("permissions", () => {
  test("top level grants contents: read only", () => {
    assert.deepEqual(wf.permissions, { contents: "read" })
  })

  test("packages: write appears only on the image and manifests jobs, each in image-publish", () => {
    const writers = Object.entries(jobs).filter(([, j]) => j.permissions?.packages === "write")
    assert.deepEqual(writers.map(([name]) => name).sort(), ["image", "manifests"])
    for (const [name, job] of writers) assert.equal(job.environment, "image-publish", name)
    assert.equal(wf.permissions.packages, undefined, "no workflow-level packages permission")
  })

  test("only the Pages deploy job holds id-token or pages write", () => {
    // actions/deploy-pages needs id-token; no release job does (no signing).
    for (const [name, job] of Object.entries(jobs)) {
      const holds = job.permissions?.pages === "write" || job.permissions?.["id-token"] === "write"
      assert.equal(holds, name === "deploy", name)
    }
  })

  test("the README requires the environment's v* rule and package Actions access", () => {
    const readme = readText("k8s-do/README.md")
    assert.match(readme, /Environment `image-publish`[^:]*:\s+\*\*Deployment\s+branches and tags:\*\*\s+selected only, the single rule\s+tag `v\*`\./)
    assert.match(readme, /\*\*Manage Actions access\*\*: only this repository/)
    assert.match(readme, /`manifests\/knowledgebase`/)
  })
})

describe("expressions stay out of shell scripts", () => {
  test("no ${{ }} inside run:", () => {
    for (const { job, step } of steps()) {
      if (!step.run) continue
      assert.ok(!/\$\{\{/.test(step.run), `${job} / ${step.name ?? step.run.slice(0, 40)}`)
    }
  })

  test("every uses: is pinned to a full commit SHA with its version beside it", () => {
    const uses = steps().filter(({ step }) => step.uses)
    assert.ok(uses.length >= 10)
    for (const { job, step } of uses) assert.match(step.uses, /^[a-z0-9-]+\/[a-z0-9-]+(\/[a-z0-9-]+)?@[0-9a-f]{40}$/, `${job}: ${step.uses}`)
    // YAML parsing drops comments: check the raw lines for the version.
    const lines = raw.split("\n").filter((l) => /^\s*(- )?uses: /.test(l))
    assert.equal(lines.length, uses.length)
    for (const line of lines) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line)
  })

  test("no checkout keeps the token in .git/config, the guard's included", () => {
    const checkouts = steps().filter(({ step }) => step.uses?.startsWith("actions/checkout@"))
    assert.ok(checkouts.some(({ job }) => job === "guard"))
    for (const { job, step } of checkouts) assert.equal(step.with?.["persist-credentials"], false, job)
  })
})

describe("image job", () => {
  test("builds from the full-history checkout", () => {
    const s = jobs.image.steps
    assert.ok(s.some((x: any) => x.uses?.startsWith("actions/checkout@") && x.with?.["fetch-depth"] === 0))
    const build = s.find((x: any) => x.uses?.startsWith("docker/build-push-action@"))
    assert.equal(build.with.context, ".")
    assert.equal(build.with.push, true)
    assert.ok(!("cache-to" in build.with), "no cache export: it would push the builder stage")
  })

  test("validates APP_DOMAIN before building", () => {
    const s = jobs.image.steps
    const validate = s.findIndex((x: any) => x.name === "Validate APP_DOMAIN")
    const build = s.findIndex((x: any) => x.uses?.startsWith("docker/build-push-action@"))
    assert.ok(validate >= 0 && validate < build)
    assert.equal(s[validate].env.APP_DOMAIN, "${{ vars.APP_DOMAIN }}")
  })

  test("APP_DOMAIN validation checks the whole value, newlines and DNS limits", () => {
    const run = jobs.image.steps.find((x: any) => x.name === "Validate APP_DOMAIN").run
    for (const d of GOOD_DOMAINS) assert.equal(runBash(run, { APP_DOMAIN: d }).status, 0, JSON.stringify(d))
    for (const d of BAD_DOMAINS) assert.notEqual(runBash(run, { APP_DOMAIN: d }).status, 0, JSON.stringify(d))
  })

  test("outputs the pushed image by digest, validated", () => {
    const s = jobs.image.steps
    const build = s.find((x: any) => x.uses?.startsWith("docker/build-push-action@"))
    assert.equal(build.id, "build")
    assert.equal(build.env?.DOCKER_BUILD_RECORD_UPLOAD, false, "no build record artifact")
    const digest = s.find((x: any) => x.id === "digest")
    assert.ok(s.indexOf(digest) > s.indexOf(build))
    assert.equal(digest.env.DIGEST, "${{ steps.build.outputs.digest }}")
    assert.equal(jobs.image.outputs.image, "${{ steps.digest.outputs.image }}")

    const out = path.join(scratchDir(), "output")
    const run = (DIGEST: string) => {
      fs.writeFileSync(out, "")
      return runBash(digest.run, { REPO: "ghcr.io/firstchesapeake/knowledgebase", DIGEST, GITHUB_OUTPUT: out })
    }
    const good = `sha256:${"a1".repeat(32)}`
    assert.equal(run(good).status, 0)
    assert.equal(fs.readFileSync(out, "utf8"), `image=ghcr.io/firstchesapeake/knowledgebase@${good}\n`)
    for (const bad of ["", "sha256:abc", `sha256:${"A1".repeat(32)}`, `${good}\nx=1`]) {
      assert.notEqual(run(bad).status, 0, JSON.stringify(bad))
      assert.equal(fs.readFileSync(out, "utf8"), "", "nothing written on failure")
    }
  })

  test("derives the artifact repository from the same lower-cased owner as the image", () => {
    const tags = jobs.image.steps.find((x: any) => x.id === "tags")
    assert.equal(jobs.image.outputs.manifests, "${{ steps.tags.outputs.manifests }}")
    const out = path.join(scratchDir(), "output")
    fs.writeFileSync(out, "")
    const r = runBash(tags.run, {
      GITHUB_REPOSITORY_OWNER: "FIRSTChesapeake",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v26.14.0",
      GITHUB_OUTPUT: out,
    })
    assert.equal(r.status, 0, r.stderr)
    const lines = fs.readFileSync(out, "utf8").split("\n")
    assert.ok(lines.includes("repo=ghcr.io/firstchesapeake/knowledgebase"))
    assert.ok(lines.includes(`manifests=${MANIFESTS}`))
  })
})

describe("manifests job", () => {
  const job = jobs.manifests
  const s: any[] = job.steps
  const named = (name: string) => {
    const step = s.find((x) => x.name === name)
    assert.ok(step, name)
    return step
  }
  const index = (pred: (x: any) => boolean) => s.findIndex(pred)

  // A directory holding stand-ins for the given tools, each a shell script.
  function tools(scripts: Record<string, string>): string {
    const dir = scratchDir()
    for (const [name, body] of Object.entries(scripts)) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    }
    return dir
  }

  test("needs guard and image, runs in image-publish with exactly contents: read, packages: write", () => {
    assert.deepEqual(needsOf(job).sort(), ["guard", "image"])
    assert.equal(job.environment, "image-publish")
    assert.deepEqual(job.permissions, { contents: "read", packages: "write" })
  })

  test("reads the image and artifact repository from the image job's outputs, through env", () => {
    assert.equal(job.env.IMAGE, "${{ needs.image.outputs.image }}")
    assert.equal(job.env.MANIFESTS, "${{ needs.image.outputs.manifests }}")
  })

  test("installs a pinned Flux CLI and a pinned, checksum-verified kustomize", () => {
    const flux = s.find((x) => x.uses?.startsWith("fluxcd/flux2/action@"))
    assert.ok(flux, "fluxcd/flux2/action")
    assert.match(flux.with?.version ?? "", /^\d+\.\d+\.\d+$/)
    const k = named("Install kustomize")
    assert.match(k.env.KUSTOMIZE_VERSION, /^v\d+\.\d+\.\d+$/)
    assert.match(k.env.KUSTOMIZE_SHA256, /^[0-9a-f]{64}$/)
    assert.ok(k.run.includes('sha256sum -c -'))
    assert.ok(!/\|\s*(ba)?sh\b/.test(k.run), "no curl | sh")
  })

  test("validates the image, artifact repository and tag, whole values only", () => {
    const run = named("Validate inputs").run
    const good = { IMAGE, MANIFESTS, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v26.14.0" }
    assert.equal(runBash(run, good).status, 0, runBash(run, good).stdout)
    const bad: Record<string, string>[] = [
      { IMAGE: "ghcr.io/firstchesapeake/knowledgebase:v1" },
      { IMAGE: `${IMAGE}\nx` },
      { IMAGE: `ghcr.io/firstchesapeake/other@${DIGEST}` },
      { MANIFESTS: "ghcr.io/firstchesapeake/manifests/other" },
      { MANIFESTS: `${MANIFESTS}\n` },
      { GITHUB_REF_TYPE: "branch" },
      { GITHUB_REF_NAME: "main" },
      { GITHUB_REF_NAME: "v1.2.3\nx" },
      { GITHUB_REF_NAME: "v1.2.3,latest" },
    ]
    for (const b of bad) assert.notEqual(runBash(run, { ...good, ...b }).status, 0, JSON.stringify(b))
  })

  test("bakes the digest with kustomize edit set image, in k8s-do", () => {
    const bake = named("Bake the image digest")
    assert.equal(bake.run, 'kustomize edit set image "knowledgebase=${IMAGE}"')
    assert.equal(bake["working-directory"], "k8s-do")
  })

  test("checks the built release before anything is pushed, in order", () => {
    const order = [
      index((x) => x.name === "Validate inputs"),
      index((x) => x.name === "Bake the image digest"),
      index((x) => x.name === "Check the release"),
      index((x) => x.name === "Refuse to overwrite a release"),
      index((x) => x.name === "Push the release artifact"),
    ]
    for (const i of order) assert.ok(i >= 0)
    assert.deepEqual([...order].sort((a, b) => a - b), order)
    // The registry login comes after the checks, before the registry calls.
    const login = index((x) => x.uses?.startsWith("docker/login-action@"))
    assert.ok(login > order[2] && login < order[3])
  })

  describe("the release check fails closed", () => {
    const run = named("Check the release").run
    const pinned = (img: string) => `kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - image: ${img}\n        name: knowledgebase\n`
    function check(built: string, kustomization = "resources:\n- deployment.yaml\n") {
      const dir = scratchDir()
      fs.mkdirSync(path.join(dir, "k8s-do"))
      fs.writeFileSync(path.join(dir, "k8s-do", "kustomization.yaml"), kustomization)
      fs.writeFileSync(path.join(dir, "built.yaml"), built)
      const bin = tools({ kustomize: `[ "$1 $2" = "build k8s-do" ] || exit 9\ncat "${path.join(dir, "built.yaml")}"` })
      return runBash(`cd "${dir}"\n${run}`, { PATH: `${bin}:${process.env.PATH}`, IMAGE })
    }

    test("passes a release pinned to the pushed digest", () => {
      const r = check(pinned(IMAGE) + "---\nkind: Ingress\nspec:\n  rules:\n  - host: ${APP_DOMAIN}\n")
      assert.equal(r.status, 0, r.stdout + r.stderr)
    })

    test("refuses an image left by name or tag, another digest, another repo, or no image", () => {
      for (const img of ["knowledgebase", "ghcr.io/firstchesapeake/knowledgebase:v1", `ghcr.io/firstchesapeake/knowledgebase@sha256:${"b2".repeat(32)}`, `ghcr.io/evil/knowledgebase@${DIGEST}`]) {
        assert.notEqual(check(pinned(img)).status, 0, img)
      }
      assert.notEqual(check(pinned(IMAGE) + pinned("busybox")).status, 0, "a second, unpinned image")
      assert.notEqual(check("kind: Service\n").status, 0, "no image at all")
    })

    test("refuses a Secret in the output or a generator in kustomization.yaml", () => {
      assert.notEqual(check(pinned(IMAGE) + "---\nkind: Secret\nmetadata:\n  name: x\n").status, 0)
      for (const gen of ["secretGenerator:\n- name: x\n", "configMapGenerator:\n- name: x\n", "generators:\n- g.yaml\n"]) {
        assert.notEqual(check(pinned(IMAGE), `resources:\n- deployment.yaml\n${gen}`).status, 0, gen)
      }
    })
  })

  describe("an existing release is never overwritten", () => {
    const run = named("Refuse to overwrite a release").run
    function refuse(flux: string) {
      const bin = tools({ flux })
      const tmp = scratchDir()
      return runBash(run, { PATH: `${bin}:${process.env.PATH}`, MANIFESTS, GITHUB_REF_NAME: "v26.14.0", RUNNER_TEMP: tmp })
    }

    test("pulls exactly the release being published, into an existing directory", () => {
      const r = refuse('[ "$1 $2 $3" = "pull artifact oci://' + MANIFESTS + ':v26.14.0" ] || exit 9\n[ "$4" = --output ] && [ -d "$5" ] || exit 8\necho "GET x: MANIFEST_UNKNOWN: manifest unknown" >&2; exit 1')
      assert.equal(r.status, 0, r.stdout + r.stderr)
    })

    test("refuses when the tag already exists", () => {
      const r = refuse("exit 0")
      assert.notEqual(r.status, 0)
      assert.match(r.stdout, /immutable; cut a new tag/)
    })

    test("treats only the registry's not-found as free; any other error stops the release", () => {
      assert.equal(refuse('echo "NAME_UNKNOWN: repository name not known to registry" >&2; exit 1').status, 0)
      for (const err of ["DENIED: requested access to the resource is denied", "UNAUTHORIZED: authentication required", "dial tcp: i/o timeout", ""]) {
        assert.notEqual(refuse(`echo "${err}" >&2; exit 1`).status, 0, err)
      }
    })
  })

  test("pushes k8s-do only to manifests/knowledgebase at the tag, with source and revision", () => {
    const run = named("Push the release artifact").run
    assert.ok(run.includes('flux push artifact "oci://${MANIFESTS}:${GITHUB_REF_NAME}"'))
    assert.ok(run.includes("--path=./k8s-do"))
    assert.ok(run.includes('--source="https://github.com/${GITHUB_REPOSITORY}"'))
    assert.ok(run.includes('--revision="${GITHUB_REF_NAME}@sha1:${GITHUB_SHA}"'))
    assert.ok(!/latest/.test(run), "never a latest tag")
    // The only push of an artifact in the workflow.
    const pushes = steps().filter(({ step }) => /flux push artifact/.test(step.run ?? ""))
    assert.deepEqual(pushes.map(({ job, step }) => `${job}/${step.name}`), ["manifests/Push the release artifact"])
    assert.ok(/MANIFESTS: \$\{\{ needs\.image\.outputs\.manifests \}\}/.test(raw))
  })
})

describe("GitHub Pages keeps publishing", () => {
  test("Pages build and deploy jobs share the pages concurrency group", () => {
    for (const name of ["build", "deploy"]) {
      assert.equal(jobs[name].concurrency.group, "pages", name)
      assert.equal(jobs[name].concurrency["cancel-in-progress"], false, name)
    }
    assert.equal(wf.concurrency, undefined, "no workflow-level group")
  })
})
