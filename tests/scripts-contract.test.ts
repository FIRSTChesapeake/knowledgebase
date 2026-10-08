// Contract tests for scripts/ (pushing settings to GitHub and rotating the
// deploy token), .env.example and the .env ignore rule. The scripts run
// against stand-in kubectl and gh binaries: nothing reaches a cluster or
// GitHub.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { parse } from "yaml"
import { readText, repoPath, scratchDir, walkFiles } from "./helpers.ts"

const scripts = walkFiles("scripts").filter((f) => f.endsWith(".sh"))
const REPO = "example-owner/knowledgebase"
const SERVER = "https://cluster.test.invalid:6443"
const CA = Buffer.from("not a real certificate").toString("base64")

const b64url = (s: string) => Buffer.from(s).toString("base64url")
// A token shaped like a service account token, with the given expiry.
function fakeToken(exp: number): string {
  return [
    b64url(JSON.stringify({ alg: "RS256", kid: "test" })),
    b64url(JSON.stringify({ aud: ["test"], exp, sub: "system:serviceaccount:kb:kb-deployer" })),
    b64url("not a real signature"),
  ].join(".")
}
const now = () => Math.floor(Date.now() / 1000)
const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")

// kubectl answers the admin calls from FAKE_* and the can-i checks as a
// correctly bound kb-deployer would (CAN_SECRETS=yes breaks that), and
// records each can-i's kubeconfig path and its mode. gh records its calls
// and the secret body it reads from stdin.
function stubs(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "kubectl"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$KUBECTL_CALLS"',
      'case "$*" in',
      '  *"auth can-i"*) printf "%s %s\\n" "$2" "$(stat -c %a "$2")" >> "$KC_SEEN";;',
      "esac",
      'case "$*" in',
      '  *"config view"*"--raw"*) printf "%s" "$FAKE_CA";;',
      '  *"config view"*) printf "%s" "$FAKE_SERVER";;',
      '  *"create token kb-deployer"*) printf "%s\\n" "$FAKE_TOKEN";;',
      '  *"auth can-i patch deployments/knowledgebase") echo yes;;',
      '  *"auth can-i get secrets") echo "${CAN_SECRETS:-no}"; [ "${CAN_SECRETS:-no}" = yes ];;',
      '  *"auth can-i get pods --subresource=log") echo no; exit 1;;',
      "  *) exit 1;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, "gh"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$GH_CALLS"',
      'case "$1 $2" in',
      '  "auth status") exit 0;;',
      `  "repo view") echo ${REPO};;`,
      '  "secret set") cat > "$GH_SECRET";;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
}

type Run = { status: number | null; out: string; gh: string[]; kubectl: string[]; secret: string | null; seen: string[] }

function runScript(script: string, env: Record<string, string>, args: string[] = []): Run {
  const dir = scratchDir()
  stubs(dir)
  const file = (name: string) => path.join(dir, name)
  for (const name of ["gh-calls", "kubectl-calls", "kc-seen"]) fs.writeFileSync(file(name), "")
  const envFile = file("env")
  fs.writeFileSync(envFile, "")
  const r = spawnSync("bash", [repoPath(script), ...args], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      TMPDIR: dir,
      KB_ENV_FILE: envFile,
      GH_CALLS: file("gh-calls"),
      KUBECTL_CALLS: file("kubectl-calls"),
      KC_SEEN: file("kc-seen"),
      GH_SECRET: file("secret"),
      FAKE_SERVER: SERVER,
      FAKE_CA: CA,
      ...env,
    },
    encoding: "utf8",
  })
  const lines = (name: string) => fs.readFileSync(file(name), "utf8").split("\n").filter(Boolean)
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    gh: lines("gh-calls"),
    kubectl: lines("kubectl-calls"),
    secret: fs.existsSync(file("secret")) ? fs.readFileSync(file("secret"), "utf8") : null,
    seen: lines("kc-seen"),
  }
}

// Nothing of the token, nor the uploaded value, is printed or passed to gh
// as an argument.
function assertNoLeak(r: Run, token: string): void {
  for (const part of token.split(".")) {
    assert.ok(!r.out.includes(part), "a token segment was printed")
    assert.ok(!r.gh.join("\n").includes(part), "a token segment reached gh's arguments")
  }
  assert.ok(!/token:/.test(r.out), "kubeconfig content was printed")
  if (r.secret) assert.ok(!r.out.includes(r.secret.slice(0, 40)), "the secret value was printed")
}

describe("every script is strict", () => {
  test("there are scripts to check", () => {
    assert.ok(scripts.includes("scripts/upload-github-secrets.sh"))
    assert.ok(scripts.includes("scripts/rotate-deploy-token.sh"))
  })

  for (const file of scripts) {
    test(`${file} runs under set -euo pipefail and never traces`, () => {
      const lines = readText(file).split("\n")
      assert.equal(lines[0], "#!/usr/bin/env bash")
      const first = lines.slice(1).find((l) => l.trim() !== "" && !l.startsWith("#"))
      assert.equal(first, "set -euo pipefail")
      assert.ok(!/^\s*set\s+-[a-z]*x/m.test(readText(file)), "set -x would print the token")
    })

    test(`${file} prints no token or kubeconfig variable`, () => {
      for (const line of readText(file).split("\n")) {
        assert.ok(!/\b(echo|printf|info|warn|success|die)\b.*\$\{?(TOKEN|token|CA)\b/.test(line), line)
        // Reading the kubeconfig to stdout, rather than piping it to gh.
        assert.ok(!/\bcat\s+"?\$\{?(kc|file)\b/.test(line), line)
      }
    })
  }
})

describe("rotate-deploy-token.sh", () => {
  const script = "scripts/rotate-deploy-token.sh"

  test("mints, checks, uploads and stores the expiry, printing no token", () => {
    const exp = now() + 90 * 86400
    const token = fakeToken(exp)
    const r = runScript(script, { FAKE_TOKEN: token, K8S_NAMESPACE: "kb", KB_ADMIN_CONTEXT: "admin-ctx" })
    assert.equal(r.status, 0, r.out)
    assert.ok(r.kubectl.some((c) => c === "--context admin-ctx -n kb create token kb-deployer --duration=2160h"), r.kubectl.join("\n"))

    // The secret: one line of base64, decoding to the README's kubeconfig.
    assert.ok(r.secret, "KUBECONFIG_KB was set")
    assert.match(r.secret!, /^[A-Za-z0-9+/=]+$/)
    const kc = parse(Buffer.from(r.secret!, "base64").toString("utf8"))
    assert.equal(kc["current-context"], "kb-deployer")
    assert.equal(kc.users[0].user.token, token)
    assert.equal(kc.clusters[0].cluster.server, SERVER)
    assert.equal(kc.clusters[0].cluster["certificate-authority-data"], CA)
    assert.equal(kc.contexts[0].context.namespace, "kb")

    assert.ok(r.gh.includes(`secret set KUBECONFIG_KB --env production --repo ${REPO}`), r.gh.join("\n"))
    assert.ok(r.gh.includes(`variable set KUBECONFIG_KB_EXPIRES --repo ${REPO} --body ${iso(exp)}`), r.gh.join("\n"))
    assert.ok(r.out.includes(iso(exp)), "prints the real expiry")
    assertNoLeak(r, token)

    // The three can-i checks ran against the built file, which was private
    // and is gone.
    assert.equal(r.seen.length, 3)
    for (const line of r.seen) {
      const [kcPath, mode] = line.split(" ")
      assert.equal(mode, "600", kcPath)
      assert.ok(!fs.existsSync(kcPath), `${kcPath} was not removed`)
      assert.ok(!fs.existsSync(path.dirname(kcPath)), "temp directory was not removed")
    }
  })

  test("uploads nothing when kb-deployer can do more than deploy", () => {
    const token = fakeToken(now() + 90 * 86400)
    const r = runScript(script, { FAKE_TOKEN: token, K8S_NAMESPACE: "kb", CAN_SECRETS: "yes" })
    assert.notEqual(r.status, 0)
    assert.match(r.out, /can-i get secrets/)
    assert.ok(!r.gh.some((c) => c.startsWith("secret set") || c.startsWith("variable set")), r.gh.join("\n"))
    assert.equal(r.secret, null)
    assertNoLeak(r, token)
    for (const line of r.seen) assert.ok(!fs.existsSync(line.split(" ")[0]), "temp file left behind")
  })

  test("warns when the API server capped the duration", () => {
    const exp = now() + 30 * 86400
    const r = runScript(script, { FAKE_TOKEN: fakeToken(exp), K8S_NAMESPACE: "kb" })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /capped the token below 2160h/)
    assert.ok(r.gh.includes(`variable set KUBECONFIG_KB_EXPIRES --repo ${REPO} --body ${iso(exp)}`))
  })

  test("refuses a bad namespace or duration before minting anything", () => {
    for (const env of [{ K8S_NAMESPACE: "" }, { K8S_NAMESPACE: "Kb" }, { K8S_NAMESPACE: "kb\nx" }, { K8S_NAMESPACE: "kb", KB_TOKEN_DURATION: "90d" }]) {
      const r = runScript(script, { FAKE_TOKEN: fakeToken(now() + 86400 * 90), ...env })
      assert.notEqual(r.status, 0, JSON.stringify(env))
      assert.ok(!r.kubectl.some((c) => c.includes("create token")), JSON.stringify(env))
    }
  })

  test("takes no arguments", () => {
    const r = runScript(script, { FAKE_TOKEN: fakeToken(now() + 86400 * 90), K8S_NAMESPACE: "kb" }, ["kb-deployer.kubeconfig"])
    assert.notEqual(r.status, 0)
    assert.equal(r.kubectl.length, 0)
  })
})

describe("upload-github-secrets.sh", () => {
  const script = "scripts/upload-github-secrets.sh"
  const kubeconfig = (token: string) => {
    const file = path.join(scratchDir(), "kb-deployer.kubeconfig")
    fs.writeFileSync(file, `apiVersion: v1\nkind: Config\nusers:\n  - name: kb-deployer\n    user:\n      token: ${token}\n`, { mode: 0o600 })
    return file
  }

  test("sets the repo variables, and the kubeconfig named by KUBECONFIG_KB_FILE with its expiry", () => {
    const exp = now() + 60 * 86400
    const token = fakeToken(exp)
    const file = kubeconfig(token)
    const r = runScript(script, { APP_DOMAIN: "kb.example.org", K8S_NAMESPACE: "kb", KUBECONFIG_KB_FILE: file })
    assert.equal(r.status, 0, r.out)
    assert.ok(r.gh.includes(`variable set APP_DOMAIN --repo ${REPO} --body kb.example.org`))
    assert.ok(r.gh.includes(`variable set K8S_NAMESPACE --repo ${REPO} --body kb`))
    assert.ok(r.gh.includes(`secret set KUBECONFIG_KB --env production --repo ${REPO}`))
    assert.ok(r.gh.includes(`variable set KUBECONFIG_KB_EXPIRES --repo ${REPO} --body ${iso(exp)}`))
    assert.equal(r.secret, fs.readFileSync(file).toString("base64"))
    assertNoLeak(r, token)
  })

  test("skips unset values with a warning", () => {
    const r = runScript(script, {})
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /Skipping variable APP_DOMAIN/)
    assert.match(r.out, /Skipping variable K8S_NAMESPACE/)
    assert.match(r.out, /Skipping secret KUBECONFIG_KB/)
    assert.ok(!r.gh.some((c) => c.startsWith("secret set") || c.startsWith("variable set")), r.gh.join("\n"))
  })

  test("refuses an expired or unreadable token, uploading nothing", () => {
    for (const token of [fakeToken(now() - 60), "not-a-token"]) {
      const r = runScript(script, { KUBECONFIG_KB_FILE: kubeconfig(token) })
      assert.notEqual(r.status, 0, token)
      assert.equal(r.secret, null)
      assert.ok(!r.gh.some((c) => c.startsWith("secret set")))
      assertNoLeak(r, token)
    }
  })

  test("never takes the kubeconfig as an argument", () => {
    const r = runScript(script, {}, [kubeconfig(fakeToken(now() + 86400 * 60))])
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

  test(".env.example comments every value and holds no secret", () => {
    const lines = readText(".env.example").split("\n")
    const keys: Record<string, string> = {}
    lines.forEach((line, i) => {
      if (line === "" || line.startsWith("#")) return
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
      assert.ok(m, `not KEY=value: ${line}`)
      assert.ok(lines[i - 1]?.startsWith("#"), `${m![1]} has no comment above it`)
      keys[m![1]] = m![2]
    })
    assert.equal(keys.APP_DOMAIN, "kb.firstchs.org")
    assert.equal(keys.K8S_NAMESPACE, "kb")
    assert.match(keys.GHCR_OWNER, /^[a-z0-9-]+$/)
    assert.ok("KB_ADMIN_KUBECONFIG" in keys && "KB_ADMIN_CONTEXT" in keys)
    for (const [k, v] of Object.entries(keys)) {
      assert.ok(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v), `${k} looks like a token`)
      assert.ok(!/https?:\/\//.test(v), `${k} holds an address`)
      if (/TOKEN$|SECRET|PASSWORD|KUBECONFIG_KB$/.test(k)) assert.equal(v, "", `${k} must be empty`)
    }
  })
})
