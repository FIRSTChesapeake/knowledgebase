// Contract tests for the production image: Dockerfile, .dockerignore,
// nginx/default.conf and the parts of quartz.config.yaml the build rewrites.
import { createHash } from "node:crypto"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { BAD_DOMAINS, GOOD_DOMAINS, appManifests, loadYaml, readText, runBash, walkFiles } from "./helpers.ts"

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

  test("no floating syntax frontend: the builder's own parser reads the file", () => {
    // A # syntax= line pulls a frontend image at build time, and it sees
    // the whole build context.
    const directives = lines.filter((l) => /^#\s*syntax\s*=/i.test(l))
    assert.deepEqual(directives, [])
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

  // The report-only CSP as directive name -> sources.
  function csp(): Map<string, string[]> {
    const m = conf.match(/^\s*add_header\s+Content-Security-Policy-Report-Only\s+"([^"]+)"\s+always;\s*$/m)
    assert.ok(m, "an add_header Content-Security-Policy-Report-Only \"...\" always;")
    const out = new Map<string, string[]>()
    for (const part of m[1].split(";")) {
      const [name, ...sources] = part.trim().split(/\s+/)
      if (name) out.set(name, sources)
    }
    return out
  }

  test("sends a report-only Content-Security-Policy at server level", () => {
    let depth = 0
    let seen = false
    for (const line of conf.split("\n")) {
      const code = line.replace(/#.*/, "")
      if (/\badd_header\s+Content-Security-Policy-Report-Only\b/.test(code)) {
        assert.equal(depth, 1, "in the server block, not a location")
        seen = true
      }
      depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length
    }
    assert.ok(seen, "the header is set")
    assert.ok(csp().size > 0)
  })

  test("the CSP locks down defaults and allows no wildcard source", () => {
    const policy = csp()
    assert.deepEqual(policy.get("default-src"), ["'self'"])
    assert.deepEqual(policy.get("object-src"), ["'none'"])
    assert.deepEqual(policy.get("base-uri"), ["'self'"])
    assert.deepEqual(policy.get("frame-ancestors"), ["'none'"])
    assert.deepEqual(policy.get("form-action"), ["'self'"])
    for (const [name, sources] of policy) {
      for (const s of sources) {
        assert.ok(!s.includes("*"), `${name} allows a wildcard: ${s}`)
        assert.ok(!/^[a-z][a-z0-9+.-]*:$/i.test(s) || s === "data:", `${name} allows a whole scheme: ${s}`)
      }
    }
  })

  test("the CSP's script hashes cover Quartz's inline scripts", () => {
    const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`
    const scriptSrc = csp().get("script-src") ?? []

    // renderPage.tsx: one contentIndex fetch per page, relative to the root.
    const renderPage = readText("quartz/components/renderPage.tsx")
    assert.match(renderPage, /const contentIndexPath = joinSegments\(baseDir, "static\/contentIndex\.json"\)/)
    const template = renderPage.match(/const contentIndexScript = `(.*)`/)
    assert.ok(template, "renderPage.tsx builds contentIndexScript")
    const depths = walkFiles("content")
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.split("/").length - 2)
    const deepest = Math.max(1, ...depths)
    const prefixes = ["/", "./"]
    for (let d = 1; d <= deepest; d++) prefixes.push("../".repeat(d))
    for (const p of prefixes) {
      const script = template[1].replace("${contentIndexPath}", `${p}static/contentIndex.json`)
      assert.ok(scriptSrc.includes(sha(script)), `no hash for: ${script}`)
    }

    // pages/404.tsx: the case-insensitive redirect.
    const notFound = readText("quartz/components/pages/404.tsx").match(/__html: `([\s\S]*?)`,/)
    assert.ok(notFound, "404.tsx has an inline script")
    assert.ok(scriptSrc.includes(sha(notFound[1])), "no hash for the 404 page script")
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
