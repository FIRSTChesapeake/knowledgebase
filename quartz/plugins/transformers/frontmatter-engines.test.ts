import test, { describe } from "node:test"
import assert from "node:assert"
import { unified } from "unified"
import remarkParse from "remark-parse"
import { VFile } from "vfile"
import { FrontMatter } from "./frontmatter"

const ctx = { cfg: { configuration: { locale: "en-US" } }, allSlugs: [] } as any

async function parse(source: string) {
  const processor = unified().use(remarkParse).use(FrontMatter().markdownPlugins!(ctx))
  const file = new VFile({ path: "content/note.md", value: Buffer.from(source) })
  await processor.run(processor.parse(file), file)
  return file.data.frontmatter as Record<string, unknown>
}

describe("frontmatter engines", () => {
  test("rejects ---js without executing it", async () => {
    const g = globalThis as any
    delete g.__pwned
    await assert.rejects(
      parse("---js\nglobalThis.__pwned = 1; ({ title: 'x' })\n---\nbody\n"),
      /JavaScript frontmatter is not supported/,
    )
    assert.strictEqual(g.__pwned, undefined)
  })

  test("rejects ---javascript without executing it", async () => {
    const g = globalThis as any
    delete g.__pwned
    await assert.rejects(
      parse("---javascript\nglobalThis.__pwned = 1; ({ title: 'x' })\n---\nbody\n"),
      /JavaScript frontmatter is not supported/,
    )
    assert.strictEqual(g.__pwned, undefined)
  })

  test("rejects mixed-case ---JS", async () => {
    const g = globalThis as any
    delete g.__pwned
    await assert.rejects(
      parse("---JS\nglobalThis.__pwned = 1; ({ title: 'x' })\n---\nbody\n"),
      /JavaScript frontmatter is not supported/,
    )
    assert.strictEqual(g.__pwned, undefined)
  })

  test("parses yaml frontmatter", async () => {
    const data = await parse("---\ntitle: Hello YAML\n---\nbody\n")
    assert.strictEqual(data.title, "Hello YAML")
  })

  test("parses toml frontmatter", async () => {
    const data = await parse('---toml\ntitle = "Hello TOML"\n---\nbody\n')
    assert.strictEqual(data.title, "Hello TOML")
  })
})
