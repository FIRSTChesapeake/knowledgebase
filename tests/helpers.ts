import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseAllDocuments, parse } from "yaml"

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function repoPath(...parts: string[]): string {
  return path.join(repoRoot, ...parts)
}

export function readText(rel: string): string {
  return fs.readFileSync(repoPath(rel), "utf8")
}

// A string as a RegExp source that matches it literally: every metacharacter, backslash included, is escaped.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Every non-empty document in a (possibly multi-document) YAML file.
export function loadYamlDocs(rel: string): any[] {
  return parseAllDocuments(readText(rel))
    .map((doc) => {
      if (doc.errors.length > 0) throw new Error(`${rel}: ${doc.errors[0].message}`)
      return doc.toJS()
    })
    .filter((doc) => doc != null)
}

export function loadYaml(rel: string): any {
  return parse(readText(rel))
}

// Repo-relative paths of the files directly in a directory with the given extension.
export function listFiles(relDir: string, ext: string): string[] {
  return fs
    .readdirSync(repoPath(relDir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => path.posix.join(relDir, e.name))
    .sort()
}

// Every file under a directory, recursively, repo-relative.
export function walkFiles(relDir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(repoPath(relDir), { withFileTypes: true })) {
    const rel = path.posix.join(relDir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(rel))
    else if (e.isFile()) out.push(rel)
  }
  return out.sort()
}

export function kustomization(): any {
  return loadYaml("k8s-do/kustomization.yaml")
}

// The release's objects: every file k8s-do/kustomization.yaml lists.
export function appManifests(): { file: string; doc: any }[] {
  return (kustomization().resources as string[]).flatMap((name) => {
    const file = path.posix.join("k8s-do", name)
    return loadYamlDocs(file).map((doc) => ({ file, doc }))
  })
}

// Runs a script the way a GitHub Actions `run:` step does (bash -e), with
// only the given environment plus PATH.
export function runBash(
  script: string,
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-e", "-c", script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

// APP_DOMAIN values every validation must refuse: a second line (which
// build-args would read as an argument of its own), labels and names over
// the DNS limits, and characters no hostname has.
export const BAD_DOMAINS: string[] = [
  "",
  "kb",
  "kb.example.org\nBUILDKIT_SYNTAX=evil/frontend",
  "kb.example.org\n",
  "\nkb.example.org",
  "KB.example.org",
  "kb.example.org|x",
  "kb.example.org/x",
  "kb.example.org&",
  "-kb.example.org",
  "kb..example.org",
  `${"a".repeat(64)}.example.org`,
  `${"a.".repeat(126)}org`, // 255 characters
]
export const GOOD_DOMAINS: string[] = [
  "kb.example.org",
  "kb.test.invalid",
  `${"a".repeat(63)}.example.org`,
  `${"a.".repeat(125)}org`, // 253 characters
]

// A fresh temporary directory, removed when the test process exits.
export function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-contract-"))
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function deployWorkflow(): any {
  return loadYaml(".github/workflows/deploy.yml")
}
