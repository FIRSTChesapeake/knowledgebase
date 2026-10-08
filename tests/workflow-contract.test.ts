// Contract tests for .github/workflows/deploy.yml.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { deployWorkflow } from "./helpers.ts"

const wf = deployWorkflow()
const jobs: Record<string, any> = wf.jobs

function needsOf(job: any): string[] {
  if (!job.needs) return []
  return Array.isArray(job.needs) ? job.needs : [job.needs]
}

function steps(): { job: string; step: any }[] {
  return Object.entries(jobs).flatMap(([job, j]) => (j.steps ?? []).map((step: any) => ({ job, step })))
}

describe("trigger and on-main guard", () => {
  test("publishes on version tags and manual dispatch only", () => {
    assert.deepEqual(Object.keys(wf.on).sort(), ["push", "workflow_dispatch"])
    assert.deepEqual(wf.on.push, { tags: ["v[0-9]*.[0-9]*.[0-9]*"] })
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
})

describe("permissions", () => {
  test("top level grants contents: read only", () => {
    assert.deepEqual(wf.permissions, { contents: "read" })
  })

  test("packages: write appears only on the image job", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const write = job.permissions?.packages === "write"
      assert.equal(write, name === "image", name)
    }
  })
})

describe("expressions stay out of shell scripts", () => {
  test("no run: interpolates secrets, vars or step outputs", () => {
    for (const { job, step } of steps()) {
      if (!step.run) continue
      assert.ok(!/\$\{\{/.test(step.run), `${job} / ${step.name ?? step.run.slice(0, 40)}`)
    }
  })

  test("docker actions are pinned to a full commit SHA", () => {
    const docker = steps().filter(({ step }) => step.uses?.startsWith("docker/"))
    assert.ok(docker.length >= 3)
    for (const { step } of docker) assert.match(step.uses, /^docker\/[a-z-]+@[0-9a-f]{40}$/)
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
    const validate = s.findIndex((x: any) => x.env?.APP_DOMAIN && /grep -Eqx/.test(x.run ?? ""))
    const build = s.findIndex((x: any) => x.uses?.startsWith("docker/build-push-action@"))
    assert.ok(validate >= 0 && validate < build)
  })
})

describe("deploy-cluster job", () => {
  const job = jobs["deploy-cluster"]
  const runOf = (pred: (s: any) => boolean) => job.steps.filter(pred).map((s: any) => s.run).join("\n")

  test("runs in an environment, serialised without cancellation", () => {
    assert.equal(job.environment.name, "production")
    assert.equal(job.concurrency.group, "knowledgebase-cluster")
    assert.equal(job.concurrency["cancel-in-progress"], false)
    assert.ok(needsOf(job).includes("image"))
  })

  test("validates every value it renders into the manifests", () => {
    const run = runOf((s) => s.name === "Validate inputs")
    for (const v of ["$NS", "$APP_DOMAIN", "$IMAGE"]) assert.ok(run.includes(`printf '%s' "${v}"`), v)
    assert.equal(job.env.NS, "${{ vars.K8S_NAMESPACE }}")
  })

  test("writes the kubeconfig from the secret with mode 600", () => {
    const step = job.steps.find((s: any) => s.env?.KUBECONFIG_B64)
    assert.equal(step.env.KUBECONFIG_B64, "${{ secrets.KUBECONFIG_KB }}")
    assert.ok(step.run.includes("chmod 600 ~/.kube/config"))
    assert.ok(!/echo[^\n]*KUBECONFIG_B64/.test(step.run), "never echoes the kubeconfig")
  })

  test("fails on unrendered placeholders", () => {
    assert.ok(runOf((s) => s.name === "Render manifests").includes("grep -rl '__[A-Z_]*__' k8s-do-rendered"))
  })

  test("waits for the rollout with a timeout", () => {
    assert.match(runOf((s) => /rollout status/.test(s.run ?? "")), /rollout status deployment\/knowledgebase --timeout=\d+s/)
  })

  test("rolls back and stays red on failure", () => {
    const rollback = job.steps.find((s: any) => s.if === "failure()")
    assert.ok(rollback, "a failure() step")
    assert.ok(rollback.run.includes("rollout undo"))
    assert.match(rollback.run, /exit 1\s*$/)
  })
})

describe("GitHub Pages keeps publishing", () => {
  test("Pages build and deploy jobs share the pages concurrency group", () => {
    for (const name of ["build", "deploy"]) {
      assert.equal(jobs[name].concurrency.group, "pages", name)
      assert.equal(jobs[name].concurrency["cancel-in-progress"], false, name)
    }
    assert.equal(wf.concurrency, undefined, "no workflow-level group: the cluster jobs have their own")
  })

  test("only the Pages deploy job holds pages and id-token write", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const holds = job.permissions?.pages === "write" || job.permissions?.["id-token"] === "write"
      assert.equal(holds, name === "deploy", name)
    }
  })
})
