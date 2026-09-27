import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import matter from "gray-matter";
import { VFile } from "vfile";
import { NoteProperties } from "../src/transformer";
import type { BuildCtx } from "@quartz-community/types";
import type { NotePropertiesOptions } from "../src/types";

const unsupported = /Unsupported frontmatter language/;
const rejected = /Unsupported frontmatter language|JavaScript frontmatter is not supported/;
const payload = "globalThis.__pwned = 1; ({ title: 'x' })";

type Globals = typeof globalThis & { __pwned?: unknown };
const g = globalThis as Globals;

// Options are typed, but they come from YAML config at runtime, so the tests pass
// values the type would not allow.
function parse(source: string, userOpts?: Record<string, unknown>): Record<string, unknown> {
  const plugin = NoteProperties(userOpts as Partial<NotePropertiesOptions>);
  const ctx = { allSlugs: [] } as unknown as BuildCtx;
  const transformerFactory = plugin.markdownPlugins!(ctx)[1] as () => (
    tree: unknown,
    file: VFile,
  ) => void;
  const file = new VFile({ value: Buffer.from(source), path: "content/note.md" });
  file.data = {};
  transformerFactory()(null, file);
  return file.data.frontmatter as Record<string, unknown>;
}

function expectRejectedWithoutEval(
  source: string,
  message: RegExp,
  userOpts?: Record<string, unknown>,
): void {
  delete g.__pwned;
  expect(() => parse(source, userOpts)).toThrow(message);
  expect(g.__pwned).toBeUndefined();
}

describe("frontmatter engines", () => {
  beforeEach(() => {
    delete g.__pwned;
  });

  describe("a ---js payload with side effects", () => {
    let dir: string;
    let marker: string;
    let jsPayload: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "note-properties-"));
      marker = path.join(dir, "PWNED");
      jsPayload = `(require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), globalThis.__pwned = 1, { title: "x" })`;
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      delete g.__pwned;
    });

    it("would run under gray-matter's default engines (control)", () => {
      // gray-matter only caches calls made without options, so this runs every time
      matter(`---js\n${jsPayload}\n---\nbody\n`, { language: "yaml" });
      expect(g.__pwned).toBe(1);
      expect(fs.existsSync(marker)).toBe(true);
    });

    it("is rejected by the plugin without being executed", () => {
      expect(() => parse(`---js\n${jsPayload}\n---\nbody\n`)).toThrow(rejected);
      expect(g.__pwned).toBeUndefined();
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  it("rejects ---js without executing it", () => {
    expectRejectedWithoutEval(`---js\n${payload}\n---\nbody\n`, rejected);
  });

  it("rejects ---javascript without executing it", () => {
    expectRejectedWithoutEval(`---javascript\n${payload}\n---\nbody\n`, rejected);
  });

  it("rejects mixed-case ---JS", () => {
    expectRejectedWithoutEval(`---JS\n${payload}\n---\nbody\n`, rejected);
  });

  it("rejects ---JavaScript", () => {
    expectRejectedWithoutEval(`---JavaScript\n${payload}\n---\nbody\n`, rejected);
  });

  it("rejects --- js with whitespace around the language", () => {
    expectRejectedWithoutEval(`--- js \n${payload}\n---\nbody\n`, rejected);
  });

  it("rejects ---js behind a BOM and CRLF line endings", () => {
    expectRejectedWithoutEval(`\uFEFF---js\r\n${payload}\r\n---\r\nbody\r\n`, rejected);
  });

  it("rejects ---constructor with the allowlist error", () => {
    expect(() => parse("---constructor\ntitle: x\n---\nbody\n")).toThrow(unsupported);
  });

  it("rejects ---__proto__ with the allowlist error", () => {
    expect(() => parse("---__proto__\ntitle: x\n---\nbody\n")).toThrow(unsupported);
  });

  it("plugin options cannot re-add an eval engine", () => {
    const evalEngine = (s: string) => eval(s);
    expectRejectedWithoutEval(`---js\n${payload}\n---\nbody\n`, rejected, {
      engines: { javascript: evalEngine, js: evalEngine },
    });
    expectRejectedWithoutEval(`---js\n${payload}\n---\nbody\n`, rejected, {
      parsers: { javascript: evalEngine, js: evalEngine },
    });
    expectRejectedWithoutEval(`---\n${payload}\n---\nbody\n`, unsupported, {
      language: "javascript",
    });
  });

  it("plugin options cannot replace an allowed engine", () => {
    const hijack = () => {
      g.__pwned = 1;
      return { title: "hijacked" };
    };
    for (const lang of ["yaml", "yml", "json"]) {
      const body = lang === "json" ? '{"title": "safe"}' : "title: safe";
      const data = parse(`---${lang}\n${body}\n---\nbody\n`, {
        engines: { [lang]: hijack },
        parsers: { [lang]: hijack },
      });
      expect(data.title).toBe("safe");
    }
    expect(g.__pwned).toBeUndefined();
  });

  for (const delimiters of [undefined, null]) {
    it(`delimiters: ${delimiters} falls back to --- for the check too`, () => {
      expectRejectedWithoutEval(`---constructor\ntitle: x\n---\nbody\n`, unsupported, {
        delimiters,
      });
      const data = parse("---\ntitle: Hello YAML\n---\nbody\n", { delimiters });
      expect(data.title).toBe("Hello YAML");
    });
  }

  it("custom delimiters are checked with the same allowlist", () => {
    expectRejectedWithoutEval(`+++js\n${payload}\n+++\nbody\n`, rejected, {
      delimiters: "+++",
    });
    const data = parse('+++toml\ntitle = "Hello TOML"\n+++\nbody\n', { delimiters: "+++" });
    expect(data.title).toBe("Hello TOML");
  });

  it("parses yaml frontmatter", () => {
    expect(parse("---\ntitle: Hello YAML\n---\nbody\n").title).toBe("Hello YAML");
  });

  it("parses yaml frontmatter behind a BOM with CRLF line endings", () => {
    expect(parse("\uFEFF---\r\ntitle: Hello CRLF\r\n---\r\nbody\r\n").title).toBe("Hello CRLF");
  });

  it("parses ---yml frontmatter", () => {
    expect(parse("---yml\ntitle: Hello YML\n---\nbody\n").title).toBe("Hello YML");
  });

  it("parses toml frontmatter", () => {
    expect(parse('---toml\ntitle = "Hello TOML"\n---\nbody\n').title).toBe("Hello TOML");
  });

  it("parses json frontmatter", () => {
    expect(parse('---json\n{"title": "Hello JSON"}\n---\nbody\n').title).toBe("Hello JSON");
  });

  it("a file with no frontmatter still parses", () => {
    expect(parse("# Heading\n\nbody\n").title).toBe("note");
  });
});
