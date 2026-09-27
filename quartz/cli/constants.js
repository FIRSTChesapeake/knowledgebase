import path from "path"
import { readFileSync } from "fs"
import { spawnSync } from "child_process"

/**
 * All constants relating to helpers or handlers
 */
export const ORIGIN_NAME = "origin"
export const UPSTREAM_NAME = "upstream"
export const QUARTZ_SOURCE_BRANCH = "v5"
// `quartz sync --pull` pulls from a per-contributor staging branch on origin,
// "<git user.name with whitespace as _>-v4", rather than upstream's v5 branch.
// The -v4 suffix is kept so existing staging branches keep working.
const localUsername = (
  spawnSync("git", ["config", "user.name"], { encoding: "utf-8" }).stdout ?? ""
)
  .trim()
  .replaceAll(/\s/g, "_")
export const SYNC_BRANCH = localUsername + "-v4"
export const QUARTZ_SOURCE_REPO = "https://github.com/jackyzha0/quartz.git"
export const cwd = process.cwd()
export const cacheDir = path.join(cwd, ".quartz-cache")
export const cacheFile = "./quartz/.quartz-cache/transpiled-build.mjs"
export const fp = "./quartz/build.ts"
export const { version } = JSON.parse(readFileSync("./package.json").toString())
export const contentCacheFolder = path.join(cacheDir, "content-cache")
