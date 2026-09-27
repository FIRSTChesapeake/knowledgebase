import test, { describe, before, after } from "node:test"
import assert from "node:assert"
import fs from "fs"
import os from "os"
import path from "path"
import { register } from "node:module"

// Quartz's built-in plugins import .scss files and *.inline.ts client scripts,
// which the real build bundles as text with esbuild. Load them as empty
// strings here so the loader can run under the plain test runner.
const bundledAssetHook = `export async function load(url, context, next) {
  if (/\\.scss$|\\.inline\\.[jt]s$/.test(url)) {
    return { format: "module", source: "export default ''", shortCircuit: true }
  }
  return next(url, context)
}`
register("data:text/javascript," + encodeURIComponent(bundledAssetHook))

// config-loader reads quartz.config.yaml from the working directory, which it
// captures when first imported, so switch to a scratch directory before the
// import. node --test runs each test file in its own process.
const originalCwd = process.cwd()
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quartz-strict-load-"))

const writeConfig = (plugins: unknown[]) => {
  const config = {
    configuration: { pageTitle: "Test", baseUrl: "example.com", locale: "en-US" },
    plugins,
  }
  fs.writeFileSync(path.join(scratch, "quartz.config.yaml"), JSON.stringify(config))
}

let loadQuartzConfig: typeof import("./config-loader").loadQuartzConfig

before(async () => {
  process.chdir(scratch)
  ;({ loadQuartzConfig } = await import("./config-loader"))
})

after(() => {
  process.chdir(originalCwd)
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe("enabled plugins that fail to load", () => {
  test("a config whose plugins all load does not throw", async () => {
    writeConfig([])
    const config = await loadQuartzConfig()
    assert.ok(config.plugins.emitters.length > 0)
  })

  test("an enabled plugin that cannot be loaded fails the build", async () => {
    writeConfig([{ source: "@quartz-test-fixture/not-installed", enabled: true }])
    await assert.rejects(loadQuartzConfig(), /1 enabled plugin\(s\) failed to load/)
  })

  test("a disabled plugin that cannot be loaded is ignored", async () => {
    writeConfig([{ source: "@quartz-test-fixture/not-installed", enabled: false }])
    await assert.doesNotReject(loadQuartzConfig())
  })
})
