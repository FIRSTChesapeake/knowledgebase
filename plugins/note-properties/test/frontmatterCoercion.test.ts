import { describe, it, expect } from "vitest";
import { VFile } from "vfile";
import { NoteProperties } from "../src/transformer";
import type { BuildCtx } from "@quartz-community/types";

function run(md: string, stem = "note"): VFile {
  const plugin = NoteProperties({});
  const ctx = { allSlugs: [] } as unknown as BuildCtx;
  const transformerFactory = plugin.markdownPlugins!(ctx)[1] as () => (
    tree: unknown,
    file: VFile,
  ) => void;
  const file = new VFile({ value: Buffer.from(md), path: `${stem}.md` });
  file.data = {};
  transformerFactory()(null, file);
  return file;
}

function parse(md: string, stem = "note"): Record<string, unknown> {
  return run(md, stem).data.frontmatter as Record<string, unknown>;
}

describe("toml frontmatter", () => {
  it("parses title, tags and aliases", () => {
    const fm = parse('---toml\ntitle = "Hello"\ntags = ["A b", "c"]\naliases = ["x"]\n---\nbody');
    expect(fm.title).toBe("Hello");
    expect(fm.tags).toEqual(["a-b", "c"]);
    expect(fm.aliases).toEqual(["x"]);
  });

  it("offset date-time is a Date and fills created, modified and published", () => {
    const fm = parse("---toml\ndate = 2024-01-02T03:04:05Z\n---\n");
    expect(fm.created).toBeInstanceOf(Date);
    expect((fm.created as Date).toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(fm.modified).toBe(fm.created);
    expect(fm.published).toBe(fm.created);
  });

  it("local date is kept as a string", () => {
    expect(parse("---toml\ndate = 2024-01-02\n---\n").created).toBe("2024-01-02");
  });

  it("empty block falls back to the file stem for the title", () => {
    expect(parse("---toml\n---\n", "my-page").title).toBe("my-page");
  });

  it("table-valued title falls back to the file stem", () => {
    expect(parse("---toml\ntitle = { a = 1 }\n---\n", "my-page").title).toBe("my-page");
  });

  it("table-valued tags are dropped", () => {
    expect(parse("---toml\ntags = { x = 1 }\n---\n").tags).toEqual([]);
  });

  it("table-valued permalink is ignored", () => {
    const file = run("---toml\npermalink = {}\n---\n");
    expect((file.data.frontmatter as Record<string, unknown>).permalink).toBeUndefined();
    expect(file.data.aliases).toBeUndefined();
  });

  it("tables inside a tags array are dropped", () => {
    expect(parse('---toml\ntags = [{ a = 1 }, "x"]\n---\n').tags).toEqual(["x"]);
  });

  it("table-valued aliases and cssclasses do not throw", () => {
    const fm = parse("---toml\naliases = {}\ncssclasses = {}\n---\n");
    expect(fm.aliases).toEqual([]);
    expect(fm.cssclasses).toEqual([]);
  });

  it("table-valued socialDescription is removed", () => {
    expect(
      parse("---toml\nsocialDescription = { a = 1 }\n---\n").socialDescription,
    ).toBeUndefined();
  });

  it("table-valued lang is removed", () => {
    expect(parse("---toml\nlang = { a = 1 }\n---\n").lang).toBeUndefined();
  });

  for (const field of ["socialImage", "image", "cover"]) {
    it(`table-valued ${field} does not become socialImage`, () => {
      expect(parse(`---toml\n${field} = { a = 1 }\n---\n`).socialImage).toBeUndefined();
    });
  }

  it("table-valued description is removed", () => {
    expect(parse("---toml\ndescription = { a = 1 }\n---\n").description).toBeUndefined();
  });

  it("string description, socialDescription, lang and image are kept", () => {
    const fm = parse(
      '---toml\ndescription = "d"\nsocialDescription = "s"\nlang = "de"\nimage = "a.png"\n---\n',
    );
    expect(fm.description).toBe("d");
    expect(fm.socialDescription).toBe("s");
    expect(fm.lang).toBe("de");
    expect(fm.socialImage).toBe("a.png");
  });

  // created-modified-date reads these keys raw, so a table must not reach it.
  for (const field of ["date", "created", "modified", "lastmod", "published"]) {
    it(`table-valued ${field} is removed from the dates`, () => {
      const fm = parse(`---toml\n${field} = { y = 1 }\n---\n`);
      expect(fm.created).toBeUndefined();
      expect(fm.modified).toBeUndefined();
      expect(fm.published).toBeUndefined();
    });
  }

  it("array-valued modified is removed but a valid created still fills it", () => {
    const fm = parse('---toml\ncreated = "2024-01-02"\nmodified = [1, 2]\n---\n');
    expect(fm.created).toBe("2024-01-02");
    expect(fm.modified).toBe("2024-01-02");
  });

  it("invalid toml throws", () => {
    expect(() => parse("---toml\na = 1\na = 2\n---\n")).toThrow();
  });
});

describe("yaml frontmatter", () => {
  it("parses title, tags and keeps dates as strings", () => {
    const fm = parse("---\ntitle: Hi\ntags: [x]\ndate: 2024-01-02\n---\nbody");
    expect(fm.title).toBe("Hi");
    expect(fm.tags).toEqual(["x"]);
    expect(fm.created).toBe("2024-01-02");
  });

  it("numeric title and permalink are kept as strings", () => {
    const file = run("---\ntitle: 2024\npermalink: 42\n---\n");
    const fm = file.data.frontmatter as Record<string, unknown>;
    expect(fm.title).toBe("2024");
    expect(fm.permalink).toBe("42");
    expect(file.data.aliases).toEqual(["42"]);
  });

  it("wikilinks in a yaml string still become frontmatterLinks", () => {
    const file = run('---\nrelated: "[[Other Note]]"\n---\nbody');
    expect(file.data.frontmatterLinks).toEqual(["other-note"]);
  });

  it("draft and socialImage keys used by the site are kept", () => {
    const fm = parse("---\ntitle: T\ndraft: true\nsocialImage: pic.webp\n---\n");
    expect(fm.draft).toBe(true);
    expect(fm.socialImage).toBe("pic.webp");
  });
});
