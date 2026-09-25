import test, { describe } from "node:test"
import assert from "node:assert"
import { unified } from "unified"
import remarkParse from "remark-parse"
import { VFile } from "vfile"
import { FrontMatter } from "./frontmatter"

const ctx = { cfg: { configuration: { locale: "en-US" } }, allSlugs: [] } as any

const unsupported = /Unsupported frontmatter language/
const rejected = /Unsupported frontmatter language|JavaScript frontmatter is not supported/
const payload = "globalThis.__pwned = 1; ({ title: 'x' })"

async function parse(source: string, userOpts?: any) {
  const processor = unified().use(remarkParse).use(FrontMatter(userOpts).markdownPlugins!(ctx))
  const file = new VFile({ path: "content/note.md", value: Buffer.from(source) })
  await processor.run(processor.parse(file), file)
  return file.data.frontmatter as Record<string, unknown>
}

async function assertRejectedWithoutEval(source: string, message: RegExp, userOpts?: any) {
  const g = globalThis as any
  delete g.__pwned
  await assert.rejects(parse(source, userOpts), message)
  assert.strictEqual(g.__pwned, undefined)
}

describe("frontmatter engines", () => {
  test("rejects ---js without executing it", async () => {
    await assertRejectedWithoutEval(`---js\n${payload}\n---\nbody\n`, rejected)
  })

  test("rejects ---javascript without executing it", async () => {
    await assertRejectedWithoutEval(`---javascript\n${payload}\n---\nbody\n`, rejected)
  })

  test("rejects mixed-case ---JS", async () => {
    await assertRejectedWithoutEval(`---JS\n${payload}\n---\nbody\n`, rejected)
  })

  test("rejects ---JavaScript", async () => {
    await assertRejectedWithoutEval(`---JavaScript\n${payload}\n---\nbody\n`, rejected)
  })

  test("rejects --- js with whitespace around the language", async () => {
    await assertRejectedWithoutEval(`--- js \n${payload}\n---\nbody\n`, rejected)
  })

  test("rejects ---js behind a BOM and CRLF line endings", async () => {
    await assertRejectedWithoutEval(`\uFEFF---js\r\n${payload}\r\n---\r\nbody\r\n`, rejected)
  })

  test("rejects ---constructor with the allowlist error", async () => {
    await assert.rejects(parse("---constructor\ntitle: x\n---\nbody\n"), unsupported)
  })

  test("rejects ---__proto__ with the allowlist error", async () => {
    await assert.rejects(parse("---__proto__\ntitle: x\n---\nbody\n"), unsupported)
  })

  test("plugin options cannot re-add an eval engine", async () => {
    const evalEngine = (s: string) => eval(s)
    await assertRejectedWithoutEval(`---js\n${payload}\n---\nbody\n`, rejected, {
      engines: { javascript: evalEngine, js: evalEngine },
    })
    await assertRejectedWithoutEval(`---js\n${payload}\n---\nbody\n`, rejected, {
      parsers: { javascript: evalEngine, js: evalEngine },
    })
    await assertRejectedWithoutEval(`---\n${payload}\n---\nbody\n`, unsupported, {
      language: "javascript",
    })
  })

  test("plugin options cannot replace an allowed engine", async () => {
    const g = globalThis as any
    delete g.__pwned
    const hijack = () => {
      g.__pwned = 1
      return { title: "hijacked" }
    }
    for (const lang of ["yaml", "yml", "json"]) {
      const body = lang === "json" ? '{"title": "safe"}' : "title: safe"
      const data = await parse(`---${lang}\n${body}\n---\nbody\n`, {
        engines: { [lang]: hijack },
        parsers: { [lang]: hijack },
      })
      assert.strictEqual(data.title, "safe")
    }
    assert.strictEqual(g.__pwned, undefined)
  })

  for (const delimiters of [undefined, null]) {
    test(`delimiters: ${delimiters} falls back to --- for the check too`, async () => {
      await assertRejectedWithoutEval(`---constructor\ntitle: x\n---\nbody\n`, unsupported, {
        delimiters,
      })
      const data = await parse("---\ntitle: Hello YAML\n---\nbody\n", { delimiters })
      assert.strictEqual(data.title, "Hello YAML")
    })
  }

  test("custom delimiters are checked with the same allowlist", async () => {
    await assertRejectedWithoutEval(`+++js\n${payload}\n+++\nbody\n`, rejected, {
      delimiters: "+++",
    })
    const data = await parse('+++toml\ntitle = "Hello TOML"\n+++\nbody\n', { delimiters: "+++" })
    assert.strictEqual(data.title, "Hello TOML")
  })

  test("parses yaml frontmatter", async () => {
    const data = await parse("---\ntitle: Hello YAML\n---\nbody\n")
    assert.strictEqual(data.title, "Hello YAML")
  })

  test("parses yaml frontmatter behind a BOM with CRLF line endings", async () => {
    const data = await parse("\uFEFF---\r\ntitle: Hello CRLF\r\n---\r\nbody\r\n")
    assert.strictEqual(data.title, "Hello CRLF")
  })

  test("parses ---yml frontmatter", async () => {
    const data = await parse("---yml\ntitle: Hello YML\n---\nbody\n")
    assert.strictEqual(data.title, "Hello YML")
  })

  test("parses toml frontmatter", async () => {
    const data = await parse('---toml\ntitle = "Hello TOML"\n---\nbody\n')
    assert.strictEqual(data.title, "Hello TOML")
  })

  test("parses json frontmatter", async () => {
    const data = await parse('---json\n{"title": "Hello JSON"}\n---\nbody\n')
    assert.strictEqual(data.title, "Hello JSON")
  })

  test("a file with no frontmatter still parses", async () => {
    const data = await parse("# Heading\n\nbody\n")
    assert.strictEqual(data.title, "note")
  })
})
