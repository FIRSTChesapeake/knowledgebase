// Contract tests for .github/workflows/deploy.yml.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { parseAllDocuments } from "yaml"
import { BAD_DOMAINS, GOOD_DOMAINS, deployWorkflow, loadYaml, readText, repoPath, runBash, scratchDir } from "./helpers.ts"

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

// Release tags: v + SemVer 2.0 without build metadata, at most 128 characters
// (the OCI tag limit).
const GOOD_TAGS = ["v26.14.0", "v0.0.1", "v1.2.3-rc.1", "v1.2.3-alpha-1.0a", "v1.2.3-0", `v1.2.3-${"a".repeat(121)}`]
const BAD_TAGS = [
  "", "26.14.0", "v1.2", "v1.2.3.4", "v01.2.3", "v1.02.3", "v1.2.03", "v1.2.3-", "v1.2.3-01", "v1.2.3-a..b",
  "v1.2.3+build.1", "v1.2.3,latest", "v1.2.3\nx", "\nv1.2.3", "main", "V1.2.3", `v1.2.3-${"a".repeat(122)}`,
]

// Problems with every permissions block: each must be exactly the expected
// object (a string such as write-all is never one).
const EXPECTED_PERMISSIONS: Record<string, unknown> = {
  guard: undefined,
  image: { contents: "read", packages: "write" },
  manifests: { contents: "read", packages: "write" },
}
function permissionProblems(w: any): string[] {
  const problems: string[] = []
  const exact = (where: string, actual: unknown, expected: unknown) => {
    if (typeof actual === "string") problems.push(`${where}: permissions is the string ${actual}`)
    else if (!isDeepStrictEqual(actual, expected)) problems.push(`${where}: ${JSON.stringify(actual)}`)
  }
  exact("workflow", w.permissions, { contents: "read" })
  for (const [name, job] of Object.entries<any>(w.jobs)) {
    if (!(name in EXPECTED_PERMISSIONS)) problems.push(`unexpected job ${name}`)
    else exact(name, job.permissions, EXPECTED_PERMISSIONS[name])
  }
  return problems
}

// Every reference to the secrets context but secrets.GITHUB_TOKEN, in any
// key or value of the parsed workflow (comments are not parsed). Expressions
// are case-insensitive, and if: conditions need no ${{ }}.
function foreignSecrets(w: unknown): string[] {
  const found: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\bsecrets\b(\s*\.\s*[A-Za-z0-9_-]+)?/gi)) {
        if (m[0] !== "secrets.GITHUB_TOKEN") found.push(m[0])
      }
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (walk(k), walk(x))
  }
  walk(w)
  return found
}

describe("trigger and on-main guard", () => {
  test("the trigger is v* tags only: no workflow_dispatch, no branches", () => {
    assert.deepEqual(Object.keys(wf.on), ["push"])
    assert.deepEqual(wf.on.push, { tags: ["v[0-9]*.[0-9]*.[0-9]*"] })
    assert.ok(!raw.includes("workflow_dispatch"))
  })

  describe("guard, run against real repositories, requires the commit to be on main", () => {
    const step = jobs.guard.steps.find((s: any) => s.name === "Require the deployed commit to be on main")
    const home = scratchDir()
    const gitEnv = {
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.org",
    }
    function git(cwd: string, ...args: string[]): string {
      const r = spawnSync("git", args, { cwd, env: { PATH: process.env.PATH, ...gitEnv }, encoding: "utf8" })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout.trim()
    }
    // An origin whose default branch is `branch`, and a clone of it with one
    // more commit on a topic branch.
    function repos(branch = "main") {
      const root = scratchDir()
      const origin = path.join(root, "origin")
      fs.mkdirSync(origin)
      git(origin, "init", "-q", "-b", branch)
      git(origin, "commit", "-q", "--allow-empty", "-m", "merged")
      const work = path.join(root, "work")
      git(root, "clone", "-q", origin, work)
      git(work, "checkout", "-q", "-b", "topic")
      git(work, "commit", "-q", "--allow-empty", "-m", "unmerged")
      return { work, merged: git(origin, "rev-parse", "HEAD"), unmerged: git(work, "rev-parse", "HEAD") }
    }
    const guard = (work: string, DEPLOY_SHA: string) => runBash(`cd "${work}"\n${step.run}`, { ...gitEnv, DEPLOY_SHA })

    test("checks out full history, without a persisted token", () => {
      assert.ok(jobs.guard.steps.some((s: any) => s.with?.["fetch-depth"] === 0))
      assert.equal(step.env.DEPLOY_SHA, "${{ github.sha }}")
    })

    test("passes a commit on main", () => {
      const { work, merged } = repos()
      const r = guard(work, merged)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /is on main/)
    })

    test("refuses a commit not on main, or one the repo doesn't have", () => {
      const { work, unmerged } = repos()
      const r = guard(work, unmerged)
      assert.notEqual(r.status, 0)
      assert.match(r.stdout, /is not on main/)
      assert.notEqual(guard(work, "0".repeat(40)).status, 0)
    })

    test("fails closed when origin has no main", () => {
      const { work, merged } = repos("trunk")
      const r = guard(work, merged)
      assert.notEqual(r.status, 0)
      assert.match(r.stdout, /Could not fetch origin\/main/)
    })
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
    assert.ok(/\$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(raw))
    assert.deepEqual(foreignSecrets(wf), [])
  })

  test("the secrets check catches every form of reference", () => {
    const forms = [
      "${{ secrets.DEPLOY_KEY }}",
      "${{ secrets['DEPLOY_KEY'] }}",
      '${{ secrets["GITHUB_TOKEN"] }}',
      "${{ toJSON(secrets) }}",
      "${{ SECRETS.DEPLOY_KEY }}",
      "${{ secrets . DEPLOY_KEY }}",
      "${{ secrets.GITHUB_TOKEN_2 }}",
    ]
    for (const form of forms) {
      const w = structuredClone(wf)
      w.jobs.image.steps[0].with = { token: form }
      assert.notDeepEqual(foreignSecrets(w), [], form)
    }
    const w = structuredClone(wf)
    w.jobs.guard.steps[0].if = "secrets.DEPLOY_KEY != ''"
    assert.notDeepEqual(foreignSecrets(w), [], "an if: condition")
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

  test("every permissions block is exactly the expected object", () => {
    assert.deepEqual(permissionProblems(wf), [])
  })

  test("the permissions check catches write-all, extra scopes and new jobs", () => {
    const mutations: [string, (w: any) => void][] = [
      ["workflow write-all", (w) => (w.permissions = "write-all")],
      ["workflow read-all", (w) => (w.permissions = "read-all")],
      ["workflow contents: write", (w) => (w.permissions.contents = "write")],
      ["guard write-all", (w) => (w.jobs.guard.permissions = "write-all")],
      ["guard packages: write", (w) => (w.jobs.guard.permissions = { packages: "write" })],
      ["image write-all", (w) => (w.jobs.image.permissions = "write-all")],
      ["image id-token: write", (w) => (w.jobs.image.permissions["id-token"] = "write")],
      ["image actions: write", (w) => (w.jobs.image.permissions.actions = "write")],
      ["manifests contents: write", (w) => (w.jobs.manifests.permissions.contents = "write")],
      ["manifests pages: write", (w) => (w.jobs.manifests.permissions.pages = "write")],
      ["a new job", (w) => (w.jobs.extra = { needs: "guard", permissions: { contents: "read" } })],
    ]
    for (const [name, mutate] of mutations) {
      const w = structuredClone(wf)
      mutate(w)
      assert.notDeepEqual(permissionProblems(w), [], name)
    }
  })

  test("packages: write appears only on the image and manifests jobs, each in image-publish", () => {
    const writers = Object.entries(jobs).filter(([, j]) => j.permissions?.packages === "write")
    assert.deepEqual(writers.map(([name]) => name).sort(), ["image", "manifests"])
    for (const [name, job] of writers) assert.equal(job.environment, "image-publish", name)
    assert.equal(wf.permissions.packages, undefined, "no workflow-level packages permission")
  })

  test("no job holds id-token or pages write: no signing, and GitHub Pages is not published", () => {
    for (const [name, job] of Object.entries(jobs)) {
      assert.equal(job.permissions?.pages, undefined, name)
      assert.equal(job.permissions?.["id-token"], undefined, name)
    }
  })

  test("the README requires the environment's v* rule and package Actions access", () => {
    const readme = readText("k8s-do/README.md")
    assert.match(readme, /Environment `image-publish`[^:]*:\s+\*\*Deployment\s+branches and tags:\*\*\s+selected only, the single rule\s+tag `v\*`\./)
    assert.match(readme, /\*\*Manage Actions access\*\*: only this repository/)
    assert.match(readme, /`manifests\/knowledgebase`/)
  })

  test("the README requires that only maintainers can change workflows, as a required setting", () => {
    const readme = readText("k8s-do/README.md")
    const required = readme.slice(readme.indexOf("### Required: who can release"), readme.indexOf("## Cutover checklist"))
    assert.match(required, /\*\*Only maintainers can change workflows\.\*\*[\s\S]*So one of these is\s+required:/)
    assert.match(required, /\*\*push ruleset\*\*[\s\S]*\*\*Restrict file paths\*\* with the path `\.github\/workflows\/\*\*`/)
    assert.match(required, /\*\*write access for maintainers\s+only\*\*/)
    assert.ok(!/optional/i.test(required), "nothing in the required section is optional")
  })
})

describe("expressions stay out of shell scripts", () => {
  // Every step with a run: whose script holds an expression, as job/step.
  function expressionsInRun(w: any): string[] {
    const found: string[] = []
    for (const [job, j] of Object.entries<any>(w.jobs ?? {})) {
      for (const step of j.steps ?? []) {
        if (typeof step.run === "string" && /\$\{\{/.test(step.run)) found.push(`${job} / ${step.name ?? step.run.slice(0, 40)}`)
      }
    }
    return found
  }

  for (const file of [".github/workflows/deploy.yml", ".github/workflows/test.yml"]) {
    test(`no \${{ }} inside run: in ${file}`, () => {
      const w = loadYaml(file)
      assert.ok(Object.values<any>(w.jobs).some((j) => j.steps?.some((s: any) => s.run)), "no run: steps to check")
      assert.deepEqual(expressionsInRun(w), [])
      // The check sees an expression put into any job's script.
      for (const job of Object.keys(w.jobs)) {
        const m = structuredClone(w)
        m.jobs[job].steps = [...(m.jobs[job].steps ?? []), { name: "x", run: 'echo "${{ github.head_ref }}"' }]
        assert.deepEqual(expressionsInRun(m), [`${job} / x`], job)
      }
    })
  }

  test("every uses: is pinned to a full commit SHA with its version beside it", () => {
    const uses = steps().filter(({ step }) => step.uses)
    assert.ok(uses.length >= 8)
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
      VERSION_TAG_RE: wf.env.VERSION_TAG_RE,
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

  describe("image tag", () => {
    const tags = jobs.image.steps.find((x: any) => x.id === "tags")
    function run(env: Record<string, string>) {
      const out = path.join(scratchDir(), "output")
      fs.writeFileSync(out, "")
      const r = runBash(tags.run, {
        VERSION_TAG_RE: wf.env.VERSION_TAG_RE,
        GITHUB_REPOSITORY_OWNER: "firstchesapeake",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        GITHUB_REF_TYPE: "tag",
        GITHUB_OUTPUT: out,
        ...env,
      })
      return { status: r.status, out: fs.readFileSync(out, "utf8") }
    }

    test("is the version only: no :sha- tag a later run could move", () => {
      const r = run({ GITHUB_REF_NAME: "v26.14.0" })
      assert.equal(r.status, 0)
      assert.ok(r.out.split("\n").includes("tags=ghcr.io/firstchesapeake/knowledgebase:v26.14.0"), r.out)
      assert.ok(!r.out.includes("sha-"))
    })

    test("admits every release version", () => {
      for (const tag of GOOD_TAGS) assert.equal(run({ GITHUB_REF_NAME: tag }).status, 0, tag)
    })

    test("refuses anything else, or a branch, writing nothing", () => {
      for (const tag of BAD_TAGS) {
        const r = run({ GITHUB_REF_NAME: tag })
        assert.notEqual(r.status, 0, JSON.stringify(tag))
        assert.equal(r.out, "", JSON.stringify(tag))
      }
      const r = run({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "v26.14.0" })
      assert.notEqual(r.status, 0)
      assert.equal(r.out, "")
    })
  })

  test("refuses a version already released before anything is built", () => {
    const s: any[] = jobs.image.steps
    const at = (pred: (x: any) => boolean) => s.findIndex(pred)
    const refuse = at((x) => x.name === "Refuse to overwrite a release")
    const tagsStep = at((x) => x.id === "tags")
    const login = at((x) => x.uses?.startsWith("docker/login-action@"))
    const flux = at((x) => x.uses?.startsWith("fluxcd/flux2/action@"))
    const build = at((x) => x.uses?.startsWith("docker/build-push-action@"))
    assert.ok(tagsStep < refuse && login < refuse && flux < refuse && refuse < build, JSON.stringify({ tagsStep, login, flux, refuse, build }))
    assert.equal(s[refuse].env.MANIFESTS, "${{ steps.tags.outputs.manifests }}")
    // The very check the manifests job makes before it pushes.
    const later = jobs.manifests.steps.find((x: any) => x.name === "Refuse to overwrite a release")
    assert.equal(s[refuse].run, later.run)
  })
})

describe("one release definition, one run per tag", () => {
  test("VERSION_TAG_RE is defined once, at workflow level, and every tag check uses it", () => {
    assert.match(wf.env.VERSION_TAG_RE, /^\^v/)
    const checks = steps().filter(({ step }) => /GITHUB_REF_NAME" =~/.test(step.run ?? ""))
    assert.deepEqual(checks.map(({ job, step }) => `${job}/${step.name ?? step.id}`).sort(), ["image/Compute image tags", "manifests/Validate inputs"])
    for (const { step } of checks) assert.ok(step.run.includes('=~ $VERSION_TAG_RE ]]'), step.name)
    assert.ok(!/=~ \^v/.test(raw), "a second, inline tag pattern")
  })

  test("the pattern is SemVer 2.0 without build metadata", () => {
    const re = new RegExp(wf.env.VERSION_TAG_RE)
    for (const tag of GOOD_TAGS) assert.ok(re.test(tag), tag)
    for (const tag of BAD_TAGS.filter((t) => t.length <= 128 && !t.includes("\n"))) assert.ok(!re.test(tag), tag)
  })

  // An empty pattern matches every tag: both checks must refuse to run
  // without one rather than admit anything.
  for (const [job, pick] of [
    ["image", (x: any) => x.id === "tags"],
    ["manifests", (x: any) => x.name === "Validate inputs"],
  ] as const) {
    test(`${job}: an unset or empty VERSION_TAG_RE admits no tag`, () => {
      const step = jobs[job].steps.find(pick)
      const out = path.join(scratchDir(), "output")
      const env = {
        IMAGE,
        MANIFESTS,
        GITHUB_REPOSITORY_OWNER: "firstchesapeake",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v1.2.3,ghcr.io/firstchesapeake/knowledgebase:latest",
        GITHUB_OUTPUT: out,
      }
      for (const re of [undefined, ""]) {
        fs.writeFileSync(out, "")
        const r = runBash(step.run, re === undefined ? env : { ...env, VERSION_TAG_RE: re })
        assert.notEqual(r.status, 0, `VERSION_TAG_RE=${JSON.stringify(re)}: ${r.stdout}`)
        assert.match(r.stdout, /VERSION_TAG_RE is not set/)
        assert.equal(fs.readFileSync(out, "utf8"), "")
      }
    })
  }

  test("runs for the same tag queue, never cancel, never run side by side", () => {
    assert.deepEqual(wf.concurrency, { group: "release-${{ github.ref_name }}", "cancel-in-progress": false })
    for (const [name, job] of Object.entries(jobs)) assert.equal(job.concurrency, undefined, name)
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
    const y = named("Install yq")
    assert.match(y.env.YQ_VERSION, /^v4\.\d+\.\d+$/)
    assert.match(y.env.YQ_SHA256, /^[0-9a-f]{64}$/)
    assert.ok(y.run.includes("sha256sum -c -"))
    assert.ok(y.run.includes("mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64"))
    assert.ok(index((x) => x.name === "Install yq") < index((x) => x.name === "Check the release"))
  })

  test("validates the image, artifact repository and tag, whole values only", () => {
    const run = named("Validate inputs").run
    const good = { IMAGE, MANIFESTS, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v26.14.0", VERSION_TAG_RE: wf.env.VERSION_TAG_RE }
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
      ...BAD_TAGS.map((GITHUB_REF_NAME) => ({ GITHUB_REF_NAME })),
    ]
    for (const b of bad) assert.notEqual(runBash(run, { ...good, ...b }).status, 0, JSON.stringify(b))
    for (const tag of GOOD_TAGS) assert.equal(runBash(run, { ...good, GITHUB_REF_NAME: tag }).status, 0, tag)
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
    const run: string = named("Check the release").run
    const BAKED = [
      "apiVersion: kustomize.config.k8s.io/v1beta1",
      "kind: Kustomization",
      "resources:",
      "- deployment.yaml",
      "images:",
      "- name: knowledgebase",
      "  newName: ghcr.io/firstchesapeake/knowledgebase",
      `  digest: ${DIGEST}`,
      "",
    ].join("\n")
    const pinned = (img: string) =>
      `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: knowledgebase\nspec:\n  template:\n    spec:\n      containers:\n      - image: ${img}\n        name: knowledgebase\n`
    const SERVICE = "apiVersion: v1\nkind: Service\nmetadata:\n  name: knowledgebase\n"
    const INGRESS = [
      "apiVersion: networking.k8s.io/v1",
      "kind: Ingress",
      "metadata:",
      "  name: knowledgebase",
      "spec:",
      "  tls:",
      "  - hosts:",
      "    - ${APP_DOMAIN}",
      "    secretName: knowledgebase-tls",
      "  rules:",
      "  - host: ${APP_DOMAIN}",
      "",
    ].join("\n")
    const OK = [pinned(IMAGE), SERVICE, INGRESS].join("---\n")
    // The release step's yq, when it is on PATH at the pinned version (the
    // light container has none); otherwise the yaml library. Both make what
    // the step makes: one JSON document per line.
    // As the step writes them: the last is the shell-quoted expression.
    const YQ_ARGS = ["--yaml-fix-merge-anchor-to-spec", "-o=json", "-I=0", "'explode(.)'"]
    const yqVersion = named("Install yq").env.YQ_VERSION.replace(/^v/, "")
    const yq = spawnSync("yq", ["--version"], { encoding: "utf8" })
    const haveYq = yq.status === 0 && yq.stdout.includes(`version v${yqVersion}`)
    function jsonl(yaml: string, dir: string): string {
      if (haveYq) {
        const src = path.join(dir, "in.yaml")
        fs.writeFileSync(src, yaml)
        const r = spawnSync("yq", [...YQ_ARGS.slice(0, -1), "explode(.)", src], { encoding: "utf8" })
        if (r.status !== 0) throw new Error(r.stderr)
        return r.stdout
      }
      return (
        parseAllDocuments(yaml)
          .map((d) => {
            if (d.errors.length > 0) throw new Error(d.errors[0].message)
            return JSON.stringify(d.toJS())
          })
          .join("\n") + "\n"
      )
    }
    function check(built: string, kustomization = BAKED, image = IMAGE) {
      const dir = scratchDir()
      fs.writeFileSync(path.join(dir, "k.jsonl"), jsonl(kustomization, dir))
      fs.writeFileSync(path.join(dir, "b.jsonl"), jsonl(built, dir))
      const r = spawnSync(process.execPath, [repoPath("scripts/check-release.mjs"), path.join(dir, "k.jsonl"), path.join(dir, "b.jsonl")], {
        env: { PATH: process.env.PATH, IMAGE: image },
        encoding: "utf8",
      })
      return { status: r.status, out: r.stdout + r.stderr }
    }

    test("builds, converts with yq and checks with scripts/check-release.mjs", () => {
      assert.deepEqual(run.trim().split("\n"), [
        'kustomize build k8s-do > "${RUNNER_TEMP}/built.yaml"',
        `yq ${YQ_ARGS.join(" ")} k8s-do/kustomization.yaml > "\${RUNNER_TEMP}/kustomization.jsonl"`,
        `yq ${YQ_ARGS.join(" ")} "\${RUNNER_TEMP}/built.yaml" > "\${RUNNER_TEMP}/built.jsonl"`,
        'node scripts/check-release.mjs "${RUNNER_TEMP}/kustomization.jsonl" "${RUNNER_TEMP}/built.jsonl"',
      ])
    })

    test("passes a release pinned to the pushed digest", () => {
      const r = check(OK)
      assert.equal(r.status, 0, r.out)
    })

    test("passes the real kustomization.yaml once the digest is baked", () => {
      const k = loadYaml("k8s-do/kustomization.yaml")
      k.images = [{ name: "knowledgebase", newName: "ghcr.io/firstchesapeake/knowledgebase", digest: DIGEST }]
      const r = check(OK, JSON.stringify(k))
      assert.equal(r.status, 0, r.out)
    })

    test("refuses an image left by name or tag, another digest, another repo, or no image", () => {
      for (const img of ["knowledgebase", "ghcr.io/firstchesapeake/knowledgebase:v1", `ghcr.io/firstchesapeake/knowledgebase@sha256:${"b2".repeat(32)}`, `ghcr.io/evil/knowledgebase@${DIGEST}`]) {
        assert.notEqual(check(pinned(img)).status, 0, img)
      }
      assert.notEqual(check(pinned(IMAGE) + "---\n" + pinned("busybox")).status, 0, "a second, unpinned image")
      assert.notEqual(check("kind: Service\nmetadata:\n  name: knowledgebase\n").status, 0, "no image at all")
    })

    test("refuses what a line-by-line read would miss", () => {
      const bypasses: [string, string][] = [
        ["quoted Secret", pinned(IMAGE) + '---\nkind: "Secret"\nmetadata:\n  name: x\n'],
        ["single-quoted Secret", pinned(IMAGE) + "---\nkind: 'Secret'\nmetadata:\n  name: x\n"],
        ["flow-style Secret", pinned(IMAGE) + "---\n{kind: Secret, metadata: {name: x}}\n"],
        ["flow-style containers", "apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: knowledgebase}\nspec: {template: {spec: {containers: [{image: busybox, name: x}]}}}\n"],
        ["an initContainer", pinned(IMAGE).replace("      containers:", "      initContainers:\n      - {image: busybox, name: init}\n      containers:")],
        ["a quoted image key", pinned(IMAGE) + '---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: other\nspec:\n  template:\n    spec:\n      containers:\n      - "image": busybox\n'],
        ["a ConfigMap", pinned(IMAGE) + "---\nkind: ConfigMap\nmetadata:\n  name: x\n"],
        ["a ClusterRoleBinding", pinned(IMAGE) + "---\nkind: ClusterRoleBinding\nmetadata:\n  name: x\n"],
        ["a namespace", pinned(IMAGE).replace("  name: knowledgebase\n", "  name: knowledgebase\n  namespace: kube-system\n")],
        ["an empty document", pinned(IMAGE) + "---\n---\n"],
      ]
      for (const [name, built] of bypasses) assert.notEqual(check(built).status, 0, name)
    })

    test("refuses a kustomization that could pull in or generate anything else", () => {
      const extras = [
        "secretGenerator:\n- name: x\n",
        "configMapGenerator:\n- name: x\n",
        "generators:\n- g.yaml\n",
        "components:\n- ../c\n",
        "helmCharts:\n- name: x\n",
        "transformers:\n- t.yaml\n",
        "patches:\n- path: p.yaml\n",
        "namespace: kube-system\n",
        "'secretGenerator': []\n",
      ]
      for (const extra of extras) assert.notEqual(check(OK, BAKED + extra).status, 0, extra)
      for (const resource of ["https://github.com/evil/x", "github.com/evil/x?ref=main", "../outside.yaml", "base", "/etc/x.yaml"]) {
        assert.notEqual(check(OK, BAKED.replace("- deployment.yaml", `- ${resource}`)).status, 0, resource)
      }
    })

    test("refuses a kustomization whose baked image is not this run's", () => {
      assert.notEqual(check(OK, BAKED.replace(/images:[\s\S]*/, "")).status, 0, "no images entry")
      assert.notEqual(check(OK, BAKED.replace(`  digest: ${DIGEST}`, "  newTag: v1")).status, 0, "a tag")
      assert.notEqual(check(OK, BAKED.replace("a1a1", "b2b2")).status, 0, "another digest")
      assert.notEqual(check(OK, BAKED + "- name: other\n  newName: x\n").status, 0, "a second image")
      assert.notEqual(check(OK, BAKED, "ghcr.io/firstchesapeake/knowledgebase:v1").status, 0, "IMAGE not a digest")
    })

    test("passes the real manifests, image pinned as kustomize pins it", () => {
      const files = ["service.yaml", "deployment.yaml", "ingress.yaml"].map((f) => readText(`k8s-do/${f}`))
      const built = files.join("\n---\n").replace(/^(\s*)image: knowledgebase$/m, `$1image: ${IMAGE}`)
      assert.ok(built.includes(IMAGE))
      const r = check(built)
      assert.equal(r.status, 0, r.out)
    })

    test("converts with the release step's pinned yq", { skip: haveYq ? false : `yq v${yqVersion} is not on PATH` }, () => {
      // Runs only where that yq is installed; every check above then goes
      // through it.
      assert.equal(check(OK).status, 0)
    })

    test("refuses a custom resource that borrows a core kind's name", () => {
      const swaps: [string, string][] = [
        ["Deployment", "apiVersion: apps/v1\n"],
        ["Service", "apiVersion: v1\n"],
        ["Ingress", "apiVersion: networking.k8s.io/v1\n"],
      ]
      for (const [kind, line] of swaps) {
        for (const other of ["evil.example.com/v1", "extensions/v1beta1", ""]) {
          const built = OK.replace(line, other ? `apiVersion: ${other}\n` : "")
          assert.notEqual(built, OK)
          const r = check(built)
          assert.notEqual(r.status, 0, `${other || "no apiVersion"} ${kind}`)
          assert.match(r.out, /is not allowed/)
        }
      }
    })

    test("leaves the cluster nothing to substitute but a whole ${APP_DOMAIN} host", () => {
      const cases: [string, string][] = [
        // The cluster substitutes keys too: this becomes an image: key there.
        ["a ${} key", pinned(IMAGE).replace("        name: knowledgebase", "        ${X:=image}: busybox\n        name: knowledgebase")],
        ["a $ in a key", pinned(IMAGE).replace("  name: knowledgebase\n", "  name: knowledgebase\n  labels:\n    $x: y\n")],
        ["a ${} value outside the Ingress", pinned(IMAGE).replace("  name: knowledgebase\n", "  name: knowledgebase\n  annotations:\n    a: ${NS}\n")],
        ["${APP_DOMAIN} outside a host", OK.replace("secretName: knowledgebase-tls", "secretName: ${APP_DOMAIN}")],
        ["another variable as the host", OK.replace("  - host: ${APP_DOMAIN}", "  - host: ${OTHER}")],
        ["a host built around ${APP_DOMAIN}", OK.replace("    - ${APP_DOMAIN}", "    - x.${APP_DOMAIN}")],
        ["a default in the substitution", OK.replace("  - host: ${APP_DOMAIN}", "  - host: ${APP_DOMAIN:=evil.example}")],
        ["${APP_DOMAIN} as a Deployment host", pinned(IMAGE).replace("  name: knowledgebase\n", "  name: knowledgebase\nspec2:\n  rules:\n  - host: ${APP_DOMAIN}\n")],
      ]
      for (const [name, built] of cases) {
        const r = check(built)
        assert.notEqual(r.status, 0, name)
        assert.match(r.out, /(key|substitution) /, name)
      }
    })

    test("refuses a merge key, which the cluster's decoder would resolve", () => {
      // An anchor is fine where its alias expands to an allowed value...
      const alias = pinned(IMAGE).replace("  name: knowledgebase\n", "  name: &n knowledgebase\n  labels: {app: *n}\n")
      assert.equal(check(alias).status, 0, check(alias).out)
      // ...but an alias can't smuggle in another image, and a merge key
      // can't add a field the check would not see, such as a namespace.
      const aliasImage = pinned("*img").replace("  name: knowledgebase\n", "  name: knowledgebase\n  labels: {x: &img busybox}\n")
      assert.notEqual(check(aliasImage).status, 0, "an aliased image")
      for (const merge of [
        "<<: {namespace: kube-system}",
        "<<: [{namespace: kube-system}]",
        "!!merge <<: {namespace: kube-system}",
        '"<<": {namespace: kube-system}',
      ]) {
        const merged = pinned(IMAGE).replace("metadata:\n  name: knowledgebase\n", `metadata:\n  ${merge}\n  name: knowledgebase\n`)
        const r = check(merged)
        assert.notEqual(r.status, 0, merge)
        assert.match(r.out, /names a namespace|"<<"/, merge)
      }
      const anchored = pinned(IMAGE).replace("metadata:\n  name: knowledgebase\n", "x: &m {namespace: kube-system}\nmetadata:\n  <<: *m\n  name: knowledgebase\n")
      assert.notEqual(check(anchored).status, 0, "a merged alias")
    })

    test("a name in the release can't start a workflow command of its own", () => {
      const r = check(pinned(IMAGE) + '---\nkind: ConfigMap\nmetadata:\n  name: "x\\n::stop-commands::t"\n')
      assert.notEqual(r.status, 0)
      for (const line of r.out.trim().split("\n")) assert.match(line, /^::error::/, line)
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

describe("GitHub Pages is retired", () => {
  test("the jobs are exactly guard, image and manifests", () => {
    assert.deepEqual(Object.keys(jobs).sort(), ["guard", "image", "manifests"])
  })

  test("no Pages action, pages concurrency group or github-pages environment", () => {
    assert.ok(!/upload-pages-artifact|deploy-pages|github-pages/.test(raw))
    for (const [name, job] of Object.entries(jobs)) assert.notEqual(job.concurrency?.group, "pages", name)
    assert.ok(!String(wf.concurrency?.group).includes("pages"))
  })
})

describe("the Tests workflow runs the light suites on every pull request", () => {
  const tw = loadYaml(".github/workflows/test.yml")
  const runs: string[] = Object.values<any>(tw.jobs).flatMap((j) => (j.steps ?? []).flatMap((s: any) => (s.run ?? "").split("\n")))

  test("triggers on pull requests and pushes to main only, never pull_request_target", () => {
    assert.deepEqual(tw.on, { pull_request: { branches: ["main"] }, push: { branches: ["main"] } })
  })

  test("is read-only: contents: read, no job permissions, no secrets", () => {
    assert.deepEqual(tw.permissions, { contents: "read" })
    for (const [name, job] of Object.entries<any>(tw.jobs)) assert.equal(job.permissions, undefined, name)
    assert.deepEqual(foreignSecrets(tw), [])
  })

  test("every action is pinned: a full commit SHA, or a container image by digest", () => {
    const uses = Object.values<any>(tw.jobs).flatMap((j) => (j.steps ?? []).filter((s: any) => s.uses).map((s: any) => s.uses))
    assert.ok(uses.length >= 3)
    for (const u of uses) assert.match(u, /^([a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}|docker:\/\/[a-z0-9./-]+@sha256:[0-9a-f]{64})$/, u)
    for (const j of Object.values<any>(tw.jobs)) {
      for (const s of j.steps) if (s.uses?.startsWith("actions/checkout@")) assert.equal(s.with?.["persist-credentials"], false)
    }
  })

  test("runs in the Dockerfile's pinned builder image", () => {
    const builder = /^FROM (\S+) AS builder$/m.exec(readText("Dockerfile"))![1]
    assert.equal(tw.jobs.light.container.image, builder)
    assert.equal(tw.jobs.light.name, "Light tests")
  })

  test("runs every command of the local light tier", () => {
    const light = JSON.parse(readText(".test-tiers.json")).tiers.light.run as string
    const commands = light
      .split("&&")
      .map((c) => c.trim().replace(/^\(|\)$/g, "").trim())
      .filter((c) => !c.startsWith("cd "))
    assert.ok(commands.length >= 8)
    for (const c of commands) assert.ok(runs.some((r) => r.trim() === c), c)
  })

  test("lints both workflows with ShellCheck on, here and in the light tier", () => {
    const lint = tw.jobs.actionlint.steps.find((s: any) => s.uses?.startsWith("docker://rhysd/actionlint@"))
    assert.ok(lint)
    assert.ok(!/shellcheck=/.test(lint.with?.args ?? ""))
    const extra = JSON.parse(readText(".test-tiers.json")).tiers.light.extra.find((e: any) => e.image.startsWith("rhysd/actionlint"))
    assert.ok(!extra.args.some((a: string) => a.startsWith("-shellcheck")), "ShellCheck disabled in the light tier")
    assert.deepEqual(extra.args.filter((a: string) => a.endsWith(".yml")).sort(), [".github/workflows/deploy.yml", ".github/workflows/test.yml"])
  })
})
