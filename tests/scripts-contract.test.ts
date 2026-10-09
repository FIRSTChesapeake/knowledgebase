// Contract tests for scripts/ (pushing settings to GitHub), .env.example and
// the .env ignore rule. The scripts run against a stand-in gh binary:
// nothing reaches GitHub.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { readText, repoPath, scratchDir, walkFiles } from "./helpers.ts"

const scripts = walkFiles("scripts").filter((f) => f.endsWith(".sh"))
const REPO = "example-owner/knowledgebase"

// One scratch root, a fresh directory under it per use.
const root = scratchDir()
const freshDir = () => fs.mkdtempSync(path.join(root, "run-"))

// gh records its calls.
function stubs(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "gh"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$GH_CALLS"',
      'case "$1 $2" in',
      '  "auth status") exit 0;;',
      `  "repo view") echo ${REPO};;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
}

type Run = { status: number | null; out: string; gh: string[] }

function runScript(script: string, env: Record<string, string>, args: string[] = []): Run {
  const dir = freshDir()
  stubs(dir)
  const file = (name: string) => path.join(dir, name)
  fs.writeFileSync(file("gh-calls"), "")
  const envFile = file("env")
  fs.writeFileSync(envFile, "")
  const r = spawnSync("bash", [repoPath(script), ...args], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      TMPDIR: dir,
      KB_ENV_FILE: envFile,
      GH_CALLS: file("gh-calls"),
      ...env,
    },
    encoding: "utf8",
  })
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    gh: fs.readFileSync(file("gh-calls"), "utf8").split("\n").filter(Boolean),
  }
}

describe("every script is strict", () => {
  test("there are scripts to check", () => {
    assert.ok(scripts.includes("scripts/upload-github-secrets.sh"))
  })

  for (const file of scripts) {
    test(`${file} runs under set -euo pipefail and never traces`, () => {
      const lines = readText(file).split("\n")
      assert.equal(lines[0], "#!/usr/bin/env bash")
      const first = lines.slice(1).find((l) => l.trim() !== "" && !l.startsWith("#"))
      assert.equal(first, "set -euo pipefail")
      assert.ok(!/^\s*set\s+-[a-z]*x/m.test(readText(file)), "set -x")
    })

    test(`${file} talks to no cluster and stores no credential`, () => {
      // Releases reach the cluster as an artifact it pulls; nothing here
      // holds or uploads a cluster credential.
      const text = readText(file)
      assert.ok(!/\b(kubectl|helm|doctl|flux)\b/.test(text), "a cluster tool")
      assert.ok(!/KUBECONFIG|gh secret set/.test(text), "a cluster credential or a GitHub secret")
    })
  }
})

describe("upload-github-secrets.sh", () => {
  const script = "scripts/upload-github-secrets.sh"

  test("sets the repo variable APP_DOMAIN and nothing else", () => {
    const r = runScript(script, { APP_DOMAIN: "kb.example.org", K8S_NAMESPACE: "kb", KUBECONFIG_KB_FILE: "/dev/null" })
    assert.equal(r.status, 0, r.out)
    const writes = r.gh.filter((c) => /^(variable|secret) /.test(c))
    assert.deepEqual(writes, [`variable set APP_DOMAIN --repo ${REPO} --body kb.example.org`])
  })

  test("skips an unset value with a warning", () => {
    const r = runScript(script, {})
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /Skipping variable APP_DOMAIN/)
    assert.ok(!r.gh.some((c) => c.startsWith("secret set") || c.startsWith("variable set")), r.gh.join("\n"))
  })

  test("takes no arguments", () => {
    const r = runScript(script, { APP_DOMAIN: "kb.example.org" }, ["kb.example.org"])
    assert.notEqual(r.status, 0)
    assert.equal(r.gh.length, 0)
  })
})

describe(".env stays out of git", () => {
  const ignore = readText(".gitignore").split("\n").map((l) => l.trim())

  test(".gitignore ignores .env and nothing else of that name", () => {
    assert.ok(ignore.includes(".env") || ignore.includes("/.env"))
    for (const line of ignore) {
      if (line.startsWith("#") || line === ".env" || line === "/.env") continue
      assert.ok(!/(^|\/)\.env|\*\.example/.test(line), `${line} would ignore .env.example`)
    }
  })

  test(".env.example holds APP_DOMAIN only, commented", () => {
    const lines = readText(".env.example").split("\n")
    const keys: Record<string, string> = {}
    lines.forEach((line, i) => {
      if (line === "" || line.startsWith("#")) return
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
      assert.ok(m, `not KEY=value: ${line}`)
      assert.ok(lines[i - 1]?.startsWith("#"), `${m![1]} has no comment above it`)
      keys[m![1]] = m![2]
    })
    assert.deepEqual(keys, { APP_DOMAIN: "kb.firstchs.org" })
    assert.match(readText(".env.example"), /config repo/, "says where namespace and cluster settings live")
  })
})
