import fs from "node:fs"
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

// App manifests applied by CI: k8s-do/*.yaml, never k8s-do/bootstrap/.
export function appManifests(): { file: string; doc: any }[] {
  return listFiles("k8s-do", ".yaml").flatMap((file) =>
    loadYamlDocs(file).map((doc) => ({ file, doc })),
  )
}

export function deployWorkflow(): any {
  return loadYaml(".github/workflows/deploy.yml")
}

// The placeholders the deploy workflow's render step substitutes.
export function renderedPlaceholders(): string[] {
  const text = readText(".github/workflows/deploy.yml")
  return [...text.matchAll(/-e "s\|(__[A-Z_]+__)\|/g)].map((m) => m[1]).sort()
}
