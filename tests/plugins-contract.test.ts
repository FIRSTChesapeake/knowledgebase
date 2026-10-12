// Contract tests for where the Quartz plugins come from. Every remote plugin
// is an npm package, pinned by package-lock.json (version and sha512) and
// installed by npm ci; `npx quartz plugin install --from-config` only links
// and builds the local plugin, from its own lockfile. A github:, git+ or
// https:// source would be cloned from the tip of a branch on every build (a
// #ref is a branch or tag, never a commit), and quartz.lock.json does not pin
// it either, so these tests refuse any source that is not a locked npm
// package or a local folder.
import fs from "node:fs"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { loadYaml, readText, repoPath } from "./helpers.ts"

const LOCAL = /^\.\/plugins\/[a-z0-9-]+$/
const NPM = /^@[a-z0-9-]+\/[a-z0-9-]+$/
const REGISTRY = "https://registry.npmjs.org/"
// A package.json spec that installs from somewhere other than the registry,
// or under another package's name (an npm: alias).
const FOREIGN_SPEC = /^(npm:|git|http|file:|github:|link:|workspace:)/

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
      const spec = pkg.dependencies?.[source]
      if (typeof spec !== "string") problems.push(`${source}: not in package.json dependencies`)
      else if (FOREIGN_SPEC.test(spec)) problems.push(`${source}: package.json spec ${spec}`)
      const locked = lock.packages?.[`node_modules/${source}`]
      if (!locked) {
        problems.push(`${source}: not in package-lock.json`)
        continue
      }
      if (locked.name !== undefined && locked.name !== source) problems.push(`${source}: locked as ${locked.name}`)
      if (!String(locked.resolved ?? "").startsWith(`${REGISTRY}${source}/-/`)) problems.push(`${source}: resolved from ${locked.resolved}`)
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

// Every installed package in a lockfile that is not fetched from the npm
// registry with a sha512 checksum; [] when the rule holds. The root entry and
// symlinks into the tree (link: true) have nothing to fetch.
function lockfileProblems(lock: any): string[] {
  const problems: string[] = []
  if (!(lock.lockfileVersion >= 2)) problems.push(`lockfileVersion ${lock.lockfileVersion}`)
  for (const [key, entry] of Object.entries<any>(lock.packages ?? {})) {
    if (key === "" || entry.link === true) continue
    if (!String(entry.resolved ?? "").startsWith(REGISTRY)) problems.push(`${key}: resolved from ${entry.resolved}`)
    if (!/^sha512-/.test(String(entry.integrity ?? ""))) problems.push(`${key}: integrity ${entry.integrity}`)
  }
  return problems
}

const config = loadYaml("quartz.config.yaml")
const pkg = JSON.parse(readText("package.json"))
const lock = JSON.parse(readText("package-lock.json"))
const LOCAL_DIR = "plugins/note-properties"
const localPkg = JSON.parse(readText(`${LOCAL_DIR}/package.json`))
const localLock = JSON.parse(readText(`${LOCAL_DIR}/package-lock.json`))

describe("every Quartz plugin is a locked npm package or a local folder", () => {
  test("quartz.config.yaml", () => {
    assert.ok(config.plugins.length >= 10)
    assert.deepEqual(pluginSourceProblems(config, pkg, lock), [])
  })

  test("quartz.config.default.yaml has no remote sources", () => {
    assert.deepEqual(remoteSourceProblems(loadYaml("quartz.config.default.yaml")), [])
  })

  const NPM_NAME = "@quartz-community/explorer"
  const KEY = `node_modules/${NPM_NAME}`
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
      name: "an npm alias in package.json",
      mutate: (_c, p) => {
        p.dependencies[NPM_NAME] = "npm:evil-explorer@1.0.0"
      },
    },
    {
      name: "a git spec in package.json",
      mutate: (_c, p) => {
        p.dependencies[NPM_NAME] = "github:x/explorer"
      },
    },
    {
      name: "a file: spec in package.json",
      mutate: (_c, p) => {
        p.dependencies[NPM_NAME] = "file:../explorer"
      },
    },
    {
      name: "an npm alias in the lockfile",
      mutate: (_c, _p, l) => {
        l.packages[KEY].name = "evil-explorer"
        l.packages[KEY].resolved = `${REGISTRY}evil-explorer/-/evil-explorer-1.0.0.tgz`
      },
    },
    {
      name: "a lock entry resolved to another registry package",
      mutate: (_c, _p, l) => {
        l.packages[KEY].resolved = `${REGISTRY}evil-explorer/-/evil-explorer-1.0.0.tgz`
      },
    },
    {
      name: "an npm dependency missing from the lockfile",
      mutate: (_c, _p, l) => {
        delete l.packages[KEY]
      },
    },
    {
      name: "a locked package without integrity",
      mutate: (_c, _p, l) => {
        delete l.packages[KEY].integrity
      },
    },
    {
      name: "a locked package resolved off the npm registry",
      mutate: (_c, _p, l) => {
        l.packages[KEY].resolved = "https://example.com/x.tgz"
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

describe("every package in both lockfiles comes from the npm registry with a sha512 checksum", () => {
  test("package-lock.json", () => {
    assert.deepEqual(lockfileProblems(lock), [])
  })

  test(`${LOCAL_DIR}/package-lock.json`, () => {
    assert.deepEqual(lockfileProblems(localLock), [])
  })

  const someKey = Object.keys(lock.packages).find((k) => k !== "" && !lock.packages[k].link)!
  const cases: { name: string; mutate: (l: any) => void }[] = [
    { name: "a package without resolved", mutate: (l) => delete l.packages[someKey].resolved },
    { name: "a package resolved from a git host", mutate: (l) => (l.packages[someKey].resolved = "git+ssh://git@github.com/x/y.git#abc") },
    { name: "a package resolved over http", mutate: (l) => (l.packages[someKey].resolved = "http://registry.npmjs.org/x/-/x-1.0.0.tgz") },
    { name: "a package with a sha1 checksum", mutate: (l) => (l.packages[someKey].integrity = "sha1-abc") },
    { name: "a package without a checksum", mutate: (l) => delete l.packages[someKey].integrity },
    { name: "a version 1 lockfile", mutate: (l) => (l.lockfileVersion = 1) },
  ]
  for (const { name, mutate } of cases) {
    test(`refuses ${name}`, () => {
      const l = structuredClone(lock)
      mutate(l)
      assert.notDeepEqual(lockfileProblems(l), [])
    })
  }

  test("skips link entries", () => {
    const l = structuredClone(lock)
    l.packages["node_modules/linked"] = { resolved: "plugins/linked", link: true }
    assert.deepEqual(lockfileProblems(l), [])
  })
})

describe("the local plugins", () => {
  test(`${LOCAL_DIR}'s lockfile has the same dependency lists as its package.json`, () => {
    // The plugin install runs `npm install` (not `npm ci`) in the plugin
    // folder; it keeps the locked versions only while the lockfile's root
    // entry matches package.json.
    assert.ok(localLock.packages?.[""])
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      assert.deepEqual(localLock.packages[""][key] ?? {}, localPkg[key] ?? {}, key)
    }
  })

  test("none asks the installer to install dependencies at build time (quartz.requiresInstall)", () => {
    const dirs = fs
      .readdirSync(repoPath("plugins"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(repoPath("plugins", d.name, "package.json")))
      .map((d) => d.name)
    assert.ok(dirs.includes("note-properties"))
    for (const d of dirs) {
      const quartz = JSON.parse(readText(`plugins/${d}/package.json`)).quartz ?? {}
      assert.ok(!("requiresInstall" in quartz), d)
    }
  })
})

// Every command that installs or updates packages without the lockfile's
// say-so; [] when there is none. npm ci is the only install allowed, in any
// folder, so a step's working directory does not matter.
function installProblems(command: string): string[] {
  const text = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim()
  const verb = /(^|[\s;&|()`])(npm|pnpm|yarn)(\s+--?[\w-]+(=\S+)?)*\s+(install|i|add|update|up|upgrade)(?=$|[\s;&|()`])/
  const bareYarn = /(^|[\s;&|()`])yarn(?=$|\s*[;&|)`])/
  return verb.test(text) || bareYarn.test(text) ? [text] : []
}

// The shell commands of a Dockerfile's RUN instructions, continuation lines
// joined and exec form unwrapped; a heredoc RUN can't be read line by line,
// so it is refused rather than parsed.
function dockerRuns(dockerfile: string): { runs: string[]; problems: string[] } {
  const runs: string[] = []
  const problems: string[] = []
  for (const line of dockerfile.replace(/\\\n/g, " ").split("\n")) {
    const m = /^\s*RUN\s+(.*)$/i.exec(line)
    if (!m) continue
    const body = m[1].replace(/^(--\S+\s+)*/, "").trim()
    if (/<<-?\s*["']?\w+/.test(body)) problems.push(`heredoc RUN: ${body}`)
    else if (body.startsWith("[")) runs.push((JSON.parse(body) as string[]).join(" "))
    else runs.push(body)
  }
  return { runs, problems }
}

describe("every build installs from the lockfiles before the plugin install", () => {
  const INSTALL = "npx quartz plugin install --from-config"
  const NPM_CI = "npm ci --no-audit --no-fund"
  // The local plugin's own npm ci, in a subshell, before the plugin install.
  const localCi = (flags: string) =>
    new RegExp(`\\(cd ${LOCAL_DIR} && [^()]*\\b${NPM_CI}${flags}\\b[^()]*\\)[^()]*${INSTALL}`)

  test("the light tier", () => {
    const run = JSON.parse(readText(".test-tiers.json")).tiers.light.run as string
    assert.ok(run.startsWith(`${NPM_CI} `))
    assert.match(run, localCi(""))
    assert.deepEqual(installProblems(run), [])
  })

  test("the Dockerfile, with the local plugin's install scripts off", () => {
    const { runs, problems } = dockerRuns(readText("Dockerfile"))
    assert.deepEqual(problems, [])
    const install = runs.find((r) => r.includes(INSTALL))
    assert.ok(install, "no RUN line installs the plugins")
    assert.ok(install.startsWith(`${NPM_CI} `), install)
    assert.match(install, localCi(" --ignore-scripts"))
    for (const r of runs) assert.deepEqual(installProblems(r), [])
  })

  test("the Tests workflow", () => {
    const steps: any[] = loadYaml(".github/workflows/test.yml").jobs.light.steps
    const ci = steps.findIndex((s) => s.run === NPM_CI && !s["working-directory"])
    const local = steps.findIndex((s) => s["working-directory"] === LOCAL_DIR && String(s.run ?? "").split("\n").includes(NPM_CI))
    const install = steps.findIndex((s) => String(s.run ?? "").includes(INSTALL))
    assert.ok(ci >= 0 && local > ci && install > local)
    for (const s of steps) assert.deepEqual(installProblems(s.run ?? ""), [])
  })

  for (const bad of [
    "npm install",
    "npm  i",
    "npm --silent install left-pad",
    "npm i -D x",
    "cd plugins/note-properties && npm update",
    "npm up",
    "npm\tinstall",
    "x \\\n && npm install",
    "pnpm add x",
    "pnpm install",
    "yarn",
    "yarn && npm test",
    "yarn add x",
    "(npm install)",
  ]) {
    test(`the install check refuses ${JSON.stringify(bad)}`, () => {
      assert.notDeepEqual(installProblems(bad), [])
    })
  }

  for (const ok of [NPM_CI, INSTALL, "npm run build", "npm test", "npm ci", "npx tsx --test x", "echo yarnball"]) {
    test(`the install check allows ${JSON.stringify(ok)}`, () => {
      assert.deepEqual(installProblems(ok), [])
    })
  }

  test("the Dockerfile reader refuses a heredoc RUN and unwraps the exec form", () => {
    assert.notDeepEqual(dockerRuns("RUN <<EOF\nnpm install\nEOF\n").problems, [])
    assert.notDeepEqual(dockerRuns("RUN --mount=type=cache,target=/x <<-'EOT'\nnpm i\nEOT\n").problems, [])
    assert.deepEqual(dockerRuns('RUN ["npm", "install"]').runs, ["npm install"])
    assert.deepEqual(dockerRuns("run --mount=type=cache,target=/x npm \\\n install").runs, ["npm   install"])
  })
})
