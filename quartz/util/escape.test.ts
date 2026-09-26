import test, { describe } from "node:test"
import assert from "node:assert"
import { escapeHTML, unescapeHTML } from "./escape"

describe("unescapeHTML", () => {
  test("decodes each entity once", () => {
    assert.strictEqual(unescapeHTML("&lt;b&gt; &quot;x&quot; &#039;y&#039; &amp;"), `<b> "x" 'y' &`)
  })

  test("does not double-unescape an escaped entity", () => {
    assert.strictEqual(unescapeHTML("&amp;lt;script&amp;gt;"), "&lt;script&gt;")
  })

  test("round-trips escapeHTML", () => {
    const input = `<a href="x">&lt;Tom & 'Jerry'&gt;</a>`
    assert.strictEqual(unescapeHTML(escapeHTML(input)), input)
  })
})
