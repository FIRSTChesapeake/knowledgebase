// Contract tests for the production image: Dockerfile, .dockerignore,
// nginx/default.conf and the parts of quartz.config.yaml the build rewrites.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { BAD_DOMAINS, GOOD_DOMAINS, appManifests, loadYaml, readText, runBash } from "./helpers.ts"

const dockerfile = readText("Dockerfile")
const lines = dockerfile.split("\n")
const fromLines = lines.filter((l) => /^FROM\s+/.test(l))

// Each RUN instruction with its line index, continuation lines joined as
// Docker joins them, without the RUN keyword.
function runInstructions(): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = []
  for (let at = 0; at < lines.length; at++) {
    if (!lines[at].startsWith("RUN ")) continue
    let text = ""
    for (let i = at; i < lines.length; i++) {
      if (!lines[i].endsWith("\\")) {
        text += lines[i]
        break
      }
      text += lines[i].slice(0, -1)
    }
    out.push({ at, text: text.replace(/^RUN\s+/, "") })
  }
  return out
}

// The RUN that validates APP_DOMAIN with a whole-string [[ =~ ]] check.
function validation(): { at: number; text: string } {
  const run = runInstructions().find((r) => r.text.includes('"$APP_DOMAIN" =~'))
  assert.ok(run, "a RUN validating APP_DOMAIN with [[ =~ ]]")
  return run
}

describe("Dockerfile", () => {
  test("serves from a pinned nginx-unprivileged alpine image", () => {
    const final = fromLines[fromLines.length - 1]
    assert.match(final, /^FROM nginxinc\/nginx-unprivileged:\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/)
  })

  test("every base image is pinned by digest, with its tag beside it", () => {
    for (const from of fromLines) assert.match(from, /^FROM [a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}( AS \w+)?$/, from)
  })

  test("builds with a full (non-slim) node image", () => {
    assert.ok(fromLines.length >= 2, "multi-stage build")
    const builder = fromLines[0]
    assert.match(builder, /^FROM node:\S+@sha256:[0-9a-f]{64} AS builder$/)
    assert.ok(!builder.includes("slim"), "the quartz CLI needs git, which slim images lack")
  })

  test("validates APP_DOMAIN before rendering it into baseUrl", () => {
    const argAt = lines.findIndex((l) => /^ARG APP_DOMAIN\s*$/.test(l))
    assert.ok(argAt >= 0, "ARG APP_DOMAIN with no default")
    const validateAt = validation().at
    const sedAt = lines.findIndex((l) => l.includes("sed -i") && l.includes("baseUrl"))
    assert.ok(validateAt > argAt, "a validation RUN follows the ARG")
    assert.ok(sedAt > validateAt, "the sed comes after validation")
    assert.ok(dockerfile.includes('"s|^  baseUrl: .*$|  baseUrl: ${APP_DOMAIN}|"'))
    assert.ok(dockerfile.includes('grep -qxF "  baseUrl: ${APP_DOMAIN}" quartz.config.yaml'))
  })

  test("the APP_DOMAIN check runs under bash and refuses all but one whole hostname", () => {
    const shellAt = lines.findIndex((l) => l === 'SHELL ["/bin/bash", "-o", "pipefail", "-c"]')
    const argAt = lines.findIndex((l) => /^ARG APP_DOMAIN\s*$/.test(l))
    assert.ok(shellAt >= 0 && shellAt < argAt, "bash is the RUN shell before the check")
    const run = validation().text
    for (const d of GOOD_DOMAINS) assert.equal(runBash(run, { APP_DOMAIN: d }).status, 0, JSON.stringify(d))
    for (const d of BAD_DOMAINS) assert.notEqual(runBash(run, { APP_DOMAIN: d }).status, 0, JSON.stringify(d))
  })

  test("only the built site and nginx config reach the final stage", () => {
    const finalAt = lines.lastIndexOf(fromLines[fromLines.length - 1])
    const copies = lines.slice(finalAt).filter((l) => l.startsWith("COPY"))
    assert.deepEqual(copies, [
      "COPY --from=builder /src/public /usr/share/nginx/html",
      "COPY nginx/default.conf /etc/nginx/conf.d/default.conf",
    ])
  })

  test("the image listens on the port the Deployment targets", () => {
    assert.ok(lines.includes("EXPOSE 8080"))
  })
})

describe("quartz.config.yaml", () => {
  const text = readText("quartz.config.yaml")

  test("has exactly one baseUrl line for the image build to rewrite", () => {
    assert.equal(text.split("\n").filter((l) => /^  baseUrl: /.test(l)).length, 1)
  })

  test("keeps the CNAME emitter disabled", () => {
    const config = loadYaml("quartz.config.yaml")
    const cname = config.plugins.filter((p: any) => p.source === "@quartz-community/cname")
    assert.equal(cname.length, 1)
    assert.equal(cname[0].enabled, false)
  })
})

describe(".dockerignore", () => {
  const entries = readText(".dockerignore")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))

  test("keeps dependencies and build output out of the context", () => {
    assert.ok(entries.includes("node_modules"))
    assert.ok(entries.includes("public"))
  })

  test("keeps .git and content/ in the context", () => {
    for (const e of entries) {
      assert.ok(!/^(\*\*\/)?\.git\/?$/.test(e) && e !== ".git*", `${e} excludes .git`)
      assert.ok(!/^(\*\*\/)?content(\/.*)?$/.test(e), `${e} excludes content`)
      assert.notEqual(e, "*", "excludes everything")
    }
  })
})

describe("nginx/default.conf", () => {
  const conf = readText("nginx/default.conf")

  test("serves Quartz routes and the 404 page", () => {
    assert.match(conf, /^\s*listen 8080;/m)
    assert.match(conf, /try_files \$uri \$uri\.html \$uri\/ =404;/)
    assert.match(conf, /error_page 404 \/404\.html;/)
    assert.match(conf, /location = \/healthz/)
    assert.match(conf, /absolute_redirect off;/)
  })

  test("sends no Strict-Transport-Security of its own (ingress-nginx does)", () => {
    assert.ok(!/^\s*add_header\s+Strict-Transport-Security/im.test(conf))
  })

  test("sets headers only at server level", () => {
    // Walk the braces: any add_header at depth > 1 sits inside a location.
    let depth = 0
    for (const line of conf.split("\n")) {
      const code = line.replace(/#.*/, "")
      if (/\badd_header\b/.test(code)) assert.equal(depth, 1, `add_header inside a block: ${line.trim()}`)
      depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length
    }
    assert.equal(depth, 0, "balanced braces")
  })

  test("the Deployment's port and probes agree with the conf", () => {
    const [{ doc }] = appManifests().filter(({ doc }) => doc.kind === "Deployment")
    const c = doc.spec.template.spec.containers[0]
    const port = c.ports.find((p: any) => p.name === "http")
    assert.equal(port.containerPort, 8080)
    for (const probe of [c.readinessProbe, c.livenessProbe]) {
      assert.equal(probe.httpGet.path, "/healthz")
      assert.equal(probe.httpGet.port, "http")
    }
  })
})
