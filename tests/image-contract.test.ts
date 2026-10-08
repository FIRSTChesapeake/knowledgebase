// Contract tests for the production image: Dockerfile, .dockerignore,
// nginx/default.conf and the parts of quartz.config.yaml the build rewrites.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { appManifests, loadYaml, readText } from "./helpers.ts"

const dockerfile = readText("Dockerfile")
const lines = dockerfile.split("\n")
const fromLines = lines.filter((l) => /^FROM\s+/.test(l))

describe("Dockerfile", () => {
  test("serves from a pinned nginx-unprivileged alpine image", () => {
    const final = fromLines[fromLines.length - 1]
    assert.match(final, /^FROM nginxinc\/nginx-unprivileged:\d+\.\d+-alpine(\s|$)/)
  })

  test("builds with a full (non-slim) node image", () => {
    assert.ok(fromLines.length >= 2, "multi-stage build")
    const builder = fromLines[0]
    assert.match(builder, /^FROM node:\S+ AS builder$/)
    assert.ok(!builder.includes("slim"), "the quartz CLI needs git, which slim images lack")
  })

  test("validates APP_DOMAIN before rendering it into baseUrl", () => {
    const argAt = lines.findIndex((l) => /^ARG APP_DOMAIN\s*$/.test(l))
    assert.ok(argAt >= 0, "ARG APP_DOMAIN with no default")
    const validateAt = lines.findIndex((l, i) => i > argAt && l.startsWith("RUN") && l.includes("grep -Eqx"))
    const sedAt = lines.findIndex((l) => l.includes("sed -i") && l.includes("baseUrl"))
    assert.ok(validateAt > argAt, "a validation RUN follows the ARG")
    assert.ok(sedAt > validateAt, "the sed comes after validation")
    assert.ok(dockerfile.includes('"s|^  baseUrl: .*$|  baseUrl: ${APP_DOMAIN}|"'))
    assert.ok(dockerfile.includes('grep -qxF "  baseUrl: ${APP_DOMAIN}" quartz.config.yaml'))
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
