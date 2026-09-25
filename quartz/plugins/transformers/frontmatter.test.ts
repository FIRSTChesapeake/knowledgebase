import test, { describe } from "node:test"
import assert from "node:assert"
import { unified } from "unified"
import remarkParse from "remark-parse"
import { VFile } from "vfile"
import { FrontMatter } from "./frontmatter"
import fs from "fs"
import os from "os"
import path from "path"
import { coerceDate, CreatedModifiedDate } from "./lastmod"
import { BuildCtx } from "../../util/ctx"
import { FilePath } from "../../util/path"

async function parse(md: string, stem = "note") {
  const ctx = { cfg: { configuration: { locale: "en-US" } }, allSlugs: [] } as unknown as BuildCtx
  const file = new VFile({ value: Buffer.from(md), path: `${stem}.md` })
  const processor = unified().use(remarkParse).use(FrontMatter().markdownPlugins!(ctx))
  await processor.run(processor.parse(file), file)
  return file.data.frontmatter!
}

describe("toml frontmatter", () => {
  test("parses title, tags and aliases", async () => {
    const fm = await parse(
      '---toml\ntitle = "Hello"\ntags = ["A b", "c"]\naliases = ["x"]\n---\nbody',
    )
    assert.strictEqual(fm.title, "Hello")
    assert.deepStrictEqual(fm.tags, ["A-b", "c"])
    assert.deepStrictEqual(fm.aliases, ["x"])
  })

  test("offset date-time is a Date and fills created, modified and published", async () => {
    const fm = await parse("---toml\ndate = 2024-01-02T03:04:05Z\n---\n")
    const created: unknown = fm.created
    assert(created instanceof Date)
    assert.strictEqual(created.toISOString(), "2024-01-02T03:04:05.000Z")
    assert.strictEqual(fm.modified, fm.created)
    assert.strictEqual(fm.published, fm.created)
  })

  test("local date is kept as a string", async () => {
    const fm = await parse("---toml\ndate = 2024-01-02\n---\n")
    assert.strictEqual(fm.created, "2024-01-02")
  })

  test("empty block falls back to the file stem for the title", async () => {
    const fm = await parse("---toml\n---\n", "my-page")
    assert.strictEqual(fm.title, "my-page")
  })

  test("table-valued title falls back to the file stem", async () => {
    const fm = await parse("---toml\ntitle = { a = 1 }\n---\n", "my-page")
    assert.strictEqual(fm.title, "my-page")
  })

  test("table-valued tags are dropped", async () => {
    const fm = await parse("---toml\ntags = { x = 1 }\n---\n")
    assert.deepStrictEqual(fm.tags, [])
  })

  test("table-valued permalink is ignored", async () => {
    const fm = await parse("---toml\npermalink = {}\n---\n")
    assert.strictEqual(fm.permalink, undefined)
  })

  test("table-valued date does not throw when coerced", async () => {
    const fm = await parse("---toml\ndate = { y = 1 }\n---\n")
    const before = Date.now()
    const dt = coerceDate("note.md", fm.created)
    assert(dt.getTime() >= before)
  })

  test("tables inside a tags array are dropped", async () => {
    const fm = await parse('---toml\ntags = [{ a = 1 }, "x"]\n---\n')
    assert.deepStrictEqual(fm.tags, ["x"])
  })

  test("table-valued aliases and cssclasses do not throw", async () => {
    const fm = await parse("---toml\naliases = {}\ncssclasses = {}\n---\n")
    assert.deepStrictEqual(fm.aliases, [])
    assert.deepStrictEqual(fm.cssclasses, [])
  })

  test("table-valued socialDescription is removed", async () => {
    const fm = await parse("---toml\nsocialDescription = { a = 1 }\n---\n")
    assert.strictEqual(fm.socialDescription, undefined)
  })

  test("table-valued lang is removed", async () => {
    const fm = await parse("---toml\nlang = { a = 1 }\n---\n")
    assert.strictEqual(fm.lang, undefined)
  })

  for (const field of ["socialImage", "image", "cover"]) {
    test(`table-valued ${field} does not become socialImage`, async () => {
      const fm = await parse(`---toml\n${field} = { a = 1 }\n---\n`)
      assert.strictEqual(fm.socialImage, undefined)
    })
  }

  test("table-valued description is removed", async () => {
    const fm = await parse("---toml\ndescription = { a = 1 }\n---\n")
    assert.strictEqual(fm.description, undefined)
  })

  test("string description, socialDescription, lang and image are kept", async () => {
    const fm = await parse(
      '---toml\ndescription = "d"\nsocialDescription = "s"\nlang = "de"\nimage = "a.png"\n---\n',
    )
    assert.strictEqual(fm.description, "d")
    assert.strictEqual(fm.socialDescription, "s")
    assert.strictEqual(fm.lang, "de")
    assert.strictEqual(fm.socialImage, "a.png")
  })

  test("table-valued date falls back to the filesystem", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lastmod-"))
    const fp = path.join(dir, "note.md")
    fs.writeFileSync(fp, "---toml\nmodified = { y = 1 }\n---\n")
    const mtime = new Date("2020-05-06T07:08:09Z")
    fs.utimesSync(fp, mtime, mtime)
    try {
      const file = new VFile({ value: fs.readFileSync(fp), path: fp })
      file.data.frontmatter = { title: "note", modified: { y: 1 } as unknown as string }
      file.data.filePath = fp as FilePath
      file.data.relativePath = "note.md" as FilePath
      const ctx = { argv: { directory: dir } } as unknown as BuildCtx
      const plugins = CreatedModifiedDate({ priority: ["frontmatter", "filesystem"] })
      const [attach] = plugins.markdownPlugins!(ctx) as unknown as [
        () => (tree: unknown, file: VFile) => Promise<void>,
      ]
      await attach()(undefined, file)
      assert.strictEqual(file.data.dates!.modified.getTime(), mtime.getTime())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("invalid toml throws", async () => {
    await assert.rejects(parse("---toml\na = 1\na = 2\n---\n"))
  })
})

describe("yaml frontmatter", () => {
  test("parses title, tags and keeps dates as strings", async () => {
    const fm = await parse("---\ntitle: Hi\ntags: [x]\ndate: 2024-01-02\n---\nbody")
    assert.strictEqual(fm.title, "Hi")
    assert.deepStrictEqual(fm.tags, ["x"])
    assert.strictEqual(fm.created, "2024-01-02")
  })
})
