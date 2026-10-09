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

type Run = { status: number | null; out: string; gh: string[]; dir: string }

// The env file's text, or a function of the run's directory (for paths in it).
type EnvFile = string | ((dir: string) => string)

function runScript(script: string, env: Record<string, string>, args: string[] = [], envText: EnvFile = ""): Run {
  const dir = freshDir()
  stubs(dir)
  const file = (name: string) => path.join(dir, name)
  fs.writeFileSync(file("gh-calls"), "")
  const envFile = file("env")
  fs.writeFileSync(envFile, typeof envText === "function" ? envText(dir) : envText)
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
    dir,
  }
}

describe("every script is strict", () => {
  test("there are scripts to check", () => {
    assert.ok(scripts.includes("scripts/set-github-variables.sh"))
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

describe("set-github-variables.sh", () => {
  const script = "scripts/set-github-variables.sh"
  const varSets = (r: Run) => r.gh.filter((c) => c.startsWith("variable set"))

  test("replaces upload-github-secrets.sh, which set no secret", () => {
    assert.ok(!fs.existsSync(repoPath("scripts/upload-github-secrets.sh")))
  })

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

  test("reads APP_DOMAIN from the env file", () => {
    const r = runScript(script, {}, [], "# comment\n\nAPP_DOMAIN=kb.example.org\n")
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(varSets(r), [`variable set APP_DOMAIN --repo ${REPO} --body kb.example.org`])
  })

  test("the env file is read as data, never run", () => {
    const text = (dir: string) =>
      [`APP_DOMAIN=$(touch ${path.join(dir, "marker-subst")})`, `touch ${path.join(dir, "marker-bare")}`, ""].join("\n")
    const r = runScript(script, {}, [], text)
    for (const m of ["marker-subst", "marker-bare"]) {
      assert.ok(!fs.existsSync(path.join(r.dir, m)), `${m} was created: the env file ran`)
    }
    assert.notEqual(r.status, 0, "a bare command is not a KEY=value line")
    assert.deepEqual(varSets(r), [])
  })

  for (const value of ["$(touch MARKER)", "`touch MARKER`", "${HOME}x", "a;touch MARKER"]) {
    test(`takes ${value} literally`, () => {
      let literal = ""
      const r = runScript(script, {}, [], (dir) => {
        literal = value.replace("MARKER", path.join(dir, "marker"))
        return `APP_DOMAIN=${literal}\n`
      })
      assert.equal(r.status, 0, r.out)
      assert.ok(!fs.existsSync(path.join(r.dir, "marker")), "the value ran")
      assert.deepEqual(varSets(r), [`variable set APP_DOMAIN --repo ${REPO} --body ${literal}`])
    })
  }

  for (const [line, want] of [
    ['APP_DOMAIN="kb.example.org"', "kb.example.org"],
    ["APP_DOMAIN='kb.example.org'", "kb.example.org"],
    ["APP_DOMAIN=\"kb.example.org'", "\"kb.example.org'"],
    ["APP_DOMAIN=\"a b\"", "a b"],
  ]) {
    test(`unquotes ${line}`, () => {
      const r = runScript(script, {}, [], `${line}\n`)
      assert.equal(r.status, 0, r.out)
      assert.deepEqual(varSets(r), [`variable set APP_DOMAIN --repo ${REPO} --body ${want}`])
    })
  }

  for (const line of ["not a pair", "lower=x", "export APP_DOMAIN=x", " APP_DOMAIN=x", "1APP=x"]) {
    test(`rejects the line ${JSON.stringify(line)}`, () => {
      const r = runScript(script, {}, [], `APP_DOMAIN=kb.example.org\n${line}\n`)
      assert.notEqual(r.status, 0, r.out)
      assert.match(r.out, /not a KEY=value line/)
      assert.deepEqual(varSets(r), [])
    })
  }

  // Each would change what runs next: the gh it finds, a library loaded
  // into every process, the host gh talks to.
  for (const line of ["PATH=/nonexistent", "LD_PRELOAD=/nonexistent/x.so", "GH_HOST=evil.example", "BASH_ENV=/tmp/x"]) {
    test(`refuses ${line}: the file sets APP_DOMAIN only`, () => {
      const r = runScript(script, {}, [], `APP_DOMAIN=kb.example.org\n${line}\n`)
      assert.notEqual(r.status, 0, r.out)
      assert.match(r.out, new RegExp(`${line.split("=")[0]} is not a setting`))
      assert.deepEqual(r.gh, [], "gh ran")
    })
  }
})

describe(".env stays out of the image", () => {
  test(".dockerignore excludes .env", () => {
    const lines = readText(".dockerignore").split("\n").map((l) => l.trim())
    assert.ok(
      lines.some((l) => [".env", "/.env", "**/.env", ".env*"].includes(l)),
      ".dockerignore lets .env into the build context",
    )
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
