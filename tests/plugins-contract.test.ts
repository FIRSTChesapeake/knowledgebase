// Contract tests for where the Quartz plugins come from. Every remote plugin
// is an npm package, pinned by package-lock.json (version and sha512) and
// installed by npm ci; `npx quartz plugin install --from-config` only links
// and builds the local plugin. A github:, git+ or https:// source would be
// cloned from the tip of a branch on every build (a #ref is a branch or tag,
// never a commit), and quartz.lock.json does not pin it either, so these
// tests refuse any source that is not a locked npm package or a local folder.
import fs from "node:fs"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { loadYaml, readText, repoPath } from "./helpers.ts"

const LOCAL = /^\.\/plugins\/[a-z0-9-]+$/
const NPM = /^@[a-z0-9-]+\/[a-z0-9-]+$/

function sourceOf(entry: any): unknown {
  return typeof entry === "string" ? entry : entry?.source
}

// Every plugin whose source is not a string: an object, a missing source.
function nonStringSources(config: any): string[] {
  const problems: string[] = []
  for (const [i, entry] of (config.plugins ?? []).entries()) {
    const s = sourceOf(entry)
    if (typeof s !== "string") problems.push(`plugin ${i}: ${typeof s === "object" && s !== null ? "object source" : "no source"}`)
  }
  return problems
}

// Every plugin source that is neither a locked npm package nor a local
// plugin folder; [] when the rule holds. Disabled entries count too: the
// installer's --from-config pass does not look at `enabled`.
function pluginSourceProblems(config: any, pkg: any, lock: any): string[] {
  const problems = nonStringSources(config)
  for (const entry of config.plugins ?? []) {
    const source = sourceOf(entry)
    if (typeof source !== "string") continue
    if (LOCAL.test(source)) {
      if (!fs.existsSync(repoPath(source, "package.json"))) problems.push(`${source}: no package.json`)
    } else if (NPM.test(source)) {
      if (!pkg.dependencies?.[source]) problems.push(`${source}: not in package.json dependencies`)
      const locked = lock.packages?.[`node_modules/${source}`]
      if (!locked) {
        problems.push(`${source}: not in package-lock.json`)
        continue
      }
      if (!String(locked.resolved ?? "").startsWith("https://registry.npmjs.org/")) problems.push(`${source}: resolved from ${locked.resolved}`)
      if (!/^sha512-/.test(String(locked.integrity ?? ""))) problems.push(`${source}: no sha512 integrity`)
    } else {
      problems.push(`${source}: neither a locked npm package nor a local plugin`)
    }
  }
  return problems
}

// The upstream default config, which Quartz falls back to when there is no
// quartz.config.yaml, names the frontmatter plugin by its npm name, which
// this repo replaces with the local copy and does not install. So it is only
// held to the part of the rule that matters for a fallback: no source that
// the installer would clone.
function remoteSourceProblems(config: any): string[] {
  return [
    ...nonStringSources(config),
    ...(config.plugins ?? [])
      .map(sourceOf)
      .filter((s: unknown) => typeof s === "string" && !LOCAL.test(s) && !NPM.test(s))
      .map((s: string) => `${s}: a remote source`),
  ]
}

const config = loadYaml("quartz.config.yaml")
const pkg = JSON.parse(readText("package.json"))
const lock = JSON.parse(readText("package-lock.json"))

describe("every Quartz plugin is a locked npm package or a local folder", () => {
  test("quartz.config.yaml", () => {
    assert.ok(config.plugins.length >= 10)
    assert.deepEqual(pluginSourceProblems(config, pkg, lock), [])
  })

  test("quartz.config.default.yaml has no remote sources", () => {
    assert.deepEqual(remoteSourceProblems(loadYaml("quartz.config.default.yaml")), [])
  })

  const NPM_NAME = "@quartz-community/explorer"
  const setSource = (source: any, enabled = true) => (c: any) => {
    c.plugins.push({ source, enabled })
  }
  const cases: { name: string; mutate: (c: any, p: any, l: any) => void }[] = [
    { name: "a github: source", mutate: setSource("github:quartz-community/explorer") },
    { name: "a github: source with a #ref", mutate: setSource("github:quartz-community/explorer#v1.0.0") },
    { name: "a git+ source", mutate: setSource("git+https://github.com/x/y.git") },
    { name: "an https:// source", mutate: setSource("https://github.com/x/y") },
    { name: "an http:// source", mutate: setSource("http://example.com/x.tgz") },
    { name: "an npm name with a #ref", mutate: setSource(`${NPM_NAME}#main`) },
    { name: "an object source", mutate: setSource({ repo: "github:x/y" }) },
    { name: "a disabled github: source", mutate: setSource("github:x/y", false) },
    { name: "an npm name missing from package.json", mutate: setSource("@quartz-community/not-a-dependency") },
    {
      name: "an npm dependency missing from the lockfile",
      mutate: (_c, _p, l) => {
        delete l.packages[`node_modules/${NPM_NAME}`]
      },
    },
    {
      name: "a locked package without integrity",
      mutate: (_c, _p, l) => {
        delete l.packages[`node_modules/${NPM_NAME}`].integrity
      },
    },
    {
      name: "a locked package resolved off the npm registry",
      mutate: (_c, _p, l) => {
        l.packages[`node_modules/${NPM_NAME}`].resolved = "https://example.com/x.tgz"
      },
    },
    { name: "a local path outside plugins/", mutate: setSource("../plugins/note-properties") },
    { name: "an absolute path", mutate: setSource("/tmp/x") },
    { name: "a local plugin folder that doesn't exist", mutate: setSource("./plugins/does-not-exist") },
  ]

  test("the lockfile cases below mutate a plugin the config lists", () => {
    assert.ok(config.plugins.some((e: any) => sourceOf(e) === NPM_NAME))
  })

  for (const { name, mutate } of cases) {
    test(`refuses ${name}`, () => {
      const [c, p, l] = structuredClone([config, pkg, lock])
      mutate(c, p, l)
      assert.notDeepEqual(pluginSourceProblems(c, p, l), [])
    })
  }

  test("the default-config check refuses a remote source too", () => {
    const c = structuredClone(config)
    c.plugins.push({ source: "github:x/y", enabled: false })
    assert.notDeepEqual(remoteSourceProblems(c), [])
  })
})

describe("the local plugin's lockfile agrees with its manifest", () => {
  // The plugin install runs `npm install` (not `npm ci`) in the plugin
  // folder; it keeps the locked versions only while the lockfile's root
  // entry matches package.json.
  const localPkg = JSON.parse(readText("plugins/note-properties/package.json"))
  const localLock = JSON.parse(readText("plugins/note-properties/package-lock.json"))

  test("lockfileVersion 2 or later, with a root package entry", () => {
    assert.ok(localLock.lockfileVersion >= 2)
    assert.ok(localLock.packages?.[""])
  })

  test("the same dependencies and devDependencies", () => {
    assert.deepEqual(localLock.packages[""].dependencies ?? {}, localPkg.dependencies ?? {})
    assert.deepEqual(localLock.packages[""].devDependencies ?? {}, localPkg.devDependencies ?? {})
  })
})

describe("every build installs from the lockfile before the plugin install", () => {
  const INSTALL = "npx quartz plugin install --from-config"
  const NPM_CI = "npm ci --no-audit --no-fund"
  const rootInstall = /(^|[;&|(]\s*)npm (install|i)(\s|$)/m

  test("the light tier", () => {
    const run = JSON.parse(readText(".test-tiers.json")).tiers.light.run as string
    assert.ok(run.startsWith(`${NPM_CI} `))
    assert.ok(run.indexOf(NPM_CI) < run.indexOf(INSTALL))
    assert.ok(!rootInstall.test(run), run)
  })

  test("the Dockerfile", () => {
    const runs = readText("Dockerfile")
      .replace(/\\\n/g, " ")
      .split("\n")
      .filter((l) => l.startsWith("RUN "))
    const install = runs.find((r) => r.includes(INSTALL))
    assert.ok(install, "no RUN line installs the plugins")
    assert.ok(install.indexOf(NPM_CI) >= 0 && install.indexOf(NPM_CI) < install.indexOf(INSTALL), install)
    for (const r of runs) assert.ok(!rootInstall.test(r.replace(/^RUN /, "")), r)
  })

  test("the Tests workflow", () => {
    const steps: any[] = loadYaml(".github/workflows/test.yml").jobs.light.steps
    const ci = steps.findIndex((s) => s.run === NPM_CI && !s["working-directory"])
    const install = steps.findIndex((s) => String(s.run ?? "").includes(INSTALL))
    assert.ok(ci >= 0 && install > ci)
    for (const s of steps) if (!s["working-directory"]) assert.ok(!rootInstall.test(s.run ?? ""), s.run)
  })
})
