// Checks a release before it is pushed: the kustomization the job baked and
// the objects `kustomize build` made of it, both already converted to JSON by
// yq (one document per line), so no YAML quoting or flow style slips past a
// text match. Node built-ins only: the release job installs no packages.
//
//   IMAGE=<repo@sha256:...> node scripts/check-release.mjs <kustomization.json> <built.jsonl>
//
// Fails closed: anything not on an allow-list is an error. The cluster's
// admission policies are the real boundary; this stops a bad release before
// it is published.
import fs from "node:fs"
import { pathToFileURL } from "node:url"

const KINDS = ["Service", "Deployment", "Ingress"]
const KUSTOMIZATION_KEYS = ["apiVersion", "kind", "resources", "images"]
const RESOURCE = /^[a-z0-9][a-z0-9-]*\.yaml$/
const IMAGE_REF = /^ghcr\.io\/[a-z0-9-]+\/knowledgebase@sha256:[0-9a-f]{64}$/

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export function kustomizationProblems(k, image) {
  if (!isObject(k)) return ["kustomization.yaml is not a mapping"]
  const problems = []
  for (const key of Object.keys(k)) {
    if (!KUSTOMIZATION_KEYS.includes(key)) problems.push(`kustomization.yaml sets ${JSON.stringify(key)}`)
  }
  if (k.apiVersion !== "kustomize.config.k8s.io/v1beta1") problems.push("kustomization.yaml apiVersion")
  if (k.kind !== "Kustomization") problems.push("kustomization.yaml kind")
  if (!Array.isArray(k.resources) || k.resources.length === 0) {
    problems.push("kustomization.yaml lists no resources")
  } else {
    for (const r of k.resources) {
      if (typeof r !== "string" || !RESOURCE.test(r)) problems.push(`resource ${JSON.stringify(r)} is not a local file`)
    }
  }
  // Written by the bake step: exactly the one image, pinned to this run's push.
  const images = k.images
  if (!Array.isArray(images) || images.length !== 1 || !isObject(images[0])) {
    problems.push("kustomization.yaml must pin exactly one image")
  } else {
    const [i] = images
    for (const key of Object.keys(i)) {
      if (!["name", "newName", "digest"].includes(key)) problems.push(`images entry sets ${JSON.stringify(key)}`)
    }
    if (i.name !== "knowledgebase" || `${i.newName}@${i.digest}` !== image) problems.push("images entry is not this run's image")
  }
  return problems
}

// Every value under a key named "image", anywhere in the object.
function imagesIn(value, found = []) {
  if (Array.isArray(value)) {
    for (const v of value) imagesIn(v, found)
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === "image") found.push(v)
      else imagesIn(v, found)
    }
  }
  return found
}

export function builtProblems(docs, image) {
  const problems = []
  let images = 0
  for (const doc of docs) {
    if (!isObject(doc)) {
      problems.push("an empty or non-mapping document")
      continue
    }
    // Quoted: a name is the release's text, and a newline in it would start
    // a workflow command of its own.
    const what = JSON.stringify(`${doc.kind}/${doc.metadata?.name}`)
    if (!KINDS.includes(doc.kind)) problems.push(`${what}: kind ${JSON.stringify(doc.kind)} is not allowed`)
    if (doc.metadata?.namespace !== undefined) problems.push(`${what}: names a namespace`)
    for (const i of imagesIn(doc)) {
      images++
      if (i !== image || !IMAGE_REF.test(i)) problems.push(`${what}: image ${JSON.stringify(i)} is not the digest this run pushed`)
    }
  }
  if (images === 0) problems.push("the release holds no image")
  return problems
}

function main() {
  const [kustomizationFile, builtFile] = process.argv.slice(2)
  const image = process.env.IMAGE ?? ""
  if (!kustomizationFile || !builtFile || !IMAGE_REF.test(image)) {
    console.log("::error::usage: IMAGE=<repo@sha256:...> check-release.mjs <kustomization.json> <built.jsonl>")
    process.exit(1)
  }
  const parse = (file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l))
  const k = parse(kustomizationFile)
  const problems = [
    ...(k.length === 1 ? kustomizationProblems(k[0], image) : ["kustomization.yaml must be one document"]),
    ...builtProblems(parse(builtFile), image),
  ]
  for (const p of problems) console.log(`::error::${p}`)
  if (problems.length > 0) process.exit(1)
  console.log(`The release pins ${image}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
