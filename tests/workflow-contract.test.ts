// Contract tests for .github/workflows/deploy.yml.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { BAD_DOMAINS, GOOD_DOMAINS, deployWorkflow, readText, runBash, scratchDir } from "./helpers.ts"

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

  test("every action is pinned to a full commit SHA with its version beside it", () => {
    const uses = steps().filter(({ step }) => step.uses)
    assert.ok(uses.length >= 10)
    for (const { job, step } of uses) assert.match(step.uses, /^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/, `${job}: ${step.uses}`)
    // YAML parsing drops comments: check the raw lines for the version.
    const lines = readText(".github/workflows/deploy.yml").split("\n").filter((l) => /^\s*(- )?uses: /.test(l))
    assert.equal(lines.length, uses.length)
    for (const line of lines) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line)
  })

  test("no checkout but the guard's keeps the token in .git/config", () => {
    for (const { job, step } of steps()) {
      if (!step.uses?.startsWith("actions/checkout@") || job === "guard") continue
      assert.equal(step.with?.["persist-credentials"], false, job)
    }
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
    assert.equal(job.env.NS, "${{ vars.K8S_NAMESPACE }}")
    assert.equal(job.env.IMAGE, "${{ needs.image.outputs.image }}")
    const good = {
      NS: "knowledgebase",
      APP_DOMAIN: "kb.example.org",
      IMAGE: `ghcr.io/firstchesapeake/knowledgebase@sha256:${"0f".repeat(32)}`,
    }
    const check = (env: Record<string, string>) => runBash(run, { ...good, ...env }).status
    assert.equal(check({}), 0)
    for (const d of GOOD_DOMAINS) assert.equal(check({ APP_DOMAIN: d }), 0, JSON.stringify(d))
    for (const d of BAD_DOMAINS) assert.notEqual(check({ APP_DOMAIN: d }), 0, JSON.stringify(d))
    for (const ns of ["", "kb\nx", "Kb", "kb.x", "a".repeat(64), "kb-"]) {
      assert.notEqual(check({ NS: ns }), 0, JSON.stringify(ns))
    }
    for (const image of [
      "ghcr.io/firstchesapeake/knowledgebase:sha-0123456789ab",
      `ghcr.io/firstchesapeake/other@sha256:${"0f".repeat(32)}`,
      `ghcr.io/firstchesapeake/knowledgebase@sha256:${"0f".repeat(31)}`,
      `${good.IMAGE}\n`,
      `docker.io/firstchesapeake/knowledgebase@sha256:${"0f".repeat(32)}`,
    ]) {
      assert.notEqual(check({ IMAGE: image }), 0, JSON.stringify(image))
    }
  })

  test("only a numeric revision reaches GITHUB_ENV", () => {
    const step = job.steps.find((s: any) => s.name === "Record current revision")
    const dir = scratchDir()
    const env = path.join(dir, "env")
    // A stand-in kubectl that prints the revision annotation.
    fs.writeFileSync(path.join(dir, "kubectl"), '#!/bin/sh\nprintf "%s" "$REVISION"\n', { mode: 0o755 })
    const run = (REVISION: string) => {
      fs.writeFileSync(env, "")
      return runBash(step.run, { NS: "kb", REVISION, GITHUB_ENV: env, PATH: `${dir}:${process.env.PATH}` })
    }
    assert.equal(run("7").status, 0)
    assert.equal(fs.readFileSync(env, "utf8"), "BEFORE=7\n")
    assert.equal(run("").status, 0, "first deploy")
    assert.equal(fs.readFileSync(env, "utf8"), "BEFORE=\n")
    for (const bad of ["7\nLD_PRELOAD=/tmp/x", "7 ", "x"]) {
      assert.notEqual(run(bad).status, 0, JSON.stringify(bad))
      assert.equal(fs.readFileSync(env, "utf8"), "", "nothing written on failure")
    }
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
    const rollback = job.steps.find((s: any) => /^failure\(\)/.test(s.if ?? ""))
    assert.ok(rollback, "a failure() step")
    assert.ok(rollback.run.includes("rollout undo"))
    assert.match(rollback.run, /exit 1\s*$/)
  })

  test("rolls back only once the apply has run", () => {
    // A failure before the apply changed nothing; an undo then would roll
    // the healthy release back.
    const ids = job.steps.map((s: any) => s.id)
    assert.ok(job.steps.find((s: any) => s.id === "apply")?.run.includes("kubectl"))
    assert.ok(job.steps.find((s: any) => s.id === "rollout")?.run.includes("rollout status"))
    assert.ok(ids.indexOf("apply") < ids.indexOf("rollout"))
    const rollback = job.steps.find((s: any) => /^failure\(\)/.test(s.if ?? ""))
    assert.equal(rollback.if, "failure() && (steps.apply.outcome == 'failure' || steps.rollout.outcome == 'failure')")
  })

  test("never prints pod logs into the public run log", () => {
    for (const s of job.steps) assert.ok(!/kubectl[^\n]*\blogs\b/.test(s.run ?? ""), s.name)
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
