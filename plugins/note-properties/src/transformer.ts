import matter from "gray-matter";
import remarkFrontmatter from "remark-frontmatter";
import yaml from "js-yaml";
import toml from "toml";
import type {
  QuartzTransformerPlugin,
  BuildCtx,
  QuartzPluginData,
  FullSlug,
  FilePath,
} from "@quartz-community/types";
import { slugTag, slugifyFilePath, getFileExtension, transformLink } from "@quartz-community/utils";
import type { TransformOptions } from "@quartz-community/utils";
import { slugifyWikilinkTarget } from "./util/path";
import type { NotePropertiesOptions } from "./types";

const defaultOptions: NotePropertiesOptions = {
  includeAll: false,
  includedProperties: ["description", "tags", "aliases"],
  excludedProperties: [],
  hidePropertiesView: false,
  delimiters: "---",
  language: "yaml",
};

function coalesceAliases(data: Record<string, unknown>, aliases: string[]): unknown | undefined {
  for (const alias of aliases) {
    if (data[alias] !== undefined && data[alias] !== null) return data[alias];
  }
}

// toml tables have no prototype, so only stringify plain scalars
function scalarToString(input: unknown): string | undefined {
  if (typeof input === "string" || typeof input === "number") return input.toString();
  return undefined;
}

function coerceToArray(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;

  if (!Array.isArray(input)) {
    const str = scalarToString(input);
    if (str === undefined) return [];
    input = str.split(",").map((s: string) => s.trim());
  }

  return (input as unknown[])
    .filter((v: unknown) => typeof v === "string" || typeof v === "number")
    .map((v) => (v as string | number).toString());
}

// Dates reach created-modified-date as-is, so anything it cannot turn into a Date
// (a toml table, an array) is dropped here and the next date source is used.
function isDateLike(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || value instanceof Date;
}

const allowedFrontmatterLanguages = new Set(["yaml", "yml", "toml", "json"]);

// Mirrors how gray-matter picks the fence language (BOM stripped, text after the
// opening delimiter up to the end of the line, trimmed; the configured language
// when that is empty) so the two cannot disagree about which engine will run.
function assertAllowedFrontmatterLanguage(
  fileData: Buffer,
  matterOpts: { delimiters: string | [string, string]; language: string },
): void {
  const content = fileData.toString().replace(/^\uFEFF/, "");
  const { delimiters } = matterOpts;
  const open = Array.isArray(delimiters) ? delimiters[0] : delimiters;
  if (typeof open !== "string" || open === "") {
    throw new Error("Unsupported frontmatter delimiters: a non-empty string is required");
  }
  if (!content.startsWith(open) || content.charAt(open.length) === open.slice(-1)) return;

  const fence = matter.language(content.slice(open.length), { delimiters }).name;
  const language = String(fence || matterOpts.language).toLowerCase();
  if (!allowedFrontmatterLanguages.has(language)) {
    throw new Error("Unsupported frontmatter language: only yaml, toml and json are allowed");
  }
}

const rejectJavaScript = (): object => {
  throw new Error("JavaScript frontmatter is not supported");
};

function getAliasSlugs(aliases: string[]): FullSlug[] {
  return aliases.map((alias) => {
    const isMd = getFileExtension(alias) === ".md";
    const mockFp = isMd ? alias : alias + ".md";
    return slugifyFilePath(mockFp as FilePath);
  });
}

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const MDLINK_PATTERN = /\[(?:[^\]]*)\]\(([^)]+)\)/g;

function extractLinksFromValue(value: unknown): string[] {
  if (typeof value === "string") {
    const links: string[] = [];
    let match: RegExpExecArray | null;

    WIKILINK_PATTERN.lastIndex = 0;
    while ((match = WIKILINK_PATTERN.exec(value)) !== null) {
      links.push(slugifyWikilinkTarget(match[1]!));
    }

    MDLINK_PATTERN.lastIndex = 0;
    while ((match = MDLINK_PATTERN.exec(value)) !== null) {
      links.push(match[1]!);
    }

    return links;
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractLinksFromValue(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((v) => extractLinksFromValue(v));
  }

  return [];
}

function collectLinkTargetsFromValue(value: unknown): Set<string> {
  const targets = new Set<string>();
  if (typeof value === "string") {
    let match: RegExpExecArray | null;
    WIKILINK_PATTERN.lastIndex = 0;
    while ((match = WIKILINK_PATTERN.exec(value)) !== null) {
      targets.add(slugifyWikilinkTarget(match[1]!));
    }
    MDLINK_PATTERN.lastIndex = 0;
    while ((match = MDLINK_PATTERN.exec(value)) !== null) {
      targets.add(match[1]!);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      for (const t of collectLinkTargetsFromValue(item)) targets.add(t);
    }
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) {
      for (const t of collectLinkTargetsFromValue(v)) targets.add(t);
    }
  }
  return targets;
}

/** Quartz-internal frontmatter keys that should never appear in the properties table. */
const QUARTZ_INTERNAL_KEYS = new Set([
  "quartz-properties",
  "quartzProperties",
  "quartz-properties-collapse",
  "quartzPropertiesCollapse",
]);

function coerceToBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return undefined;
}
function getVisibleProperties(
  data: Record<string, unknown>,
  opts: NotePropertiesOptions,
): Record<string, unknown> {
  const excluded = new Set(opts.excludedProperties);
  // Always exclude Quartz-internal keys from the visible properties table
  for (const key of QUARTZ_INTERNAL_KEYS) {
    excluded.add(key);
  }
  if (opts.includeAll) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!excluded.has(key)) {
        result[key] = value;
      }
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const key of opts.includedProperties) {
    if (!excluded.has(key) && data[key] !== undefined) {
      result[key] = data[key];
    }
  }
  return result;
}

export const NoteProperties: QuartzTransformerPlugin<Partial<NotePropertiesOptions>> = (
  userOpts,
) => {
  const opts = { ...defaultOptions, ...userOpts };
  return {
    name: "NoteProperties",
    markdownPlugins(_ctx: BuildCtx) {
      const { allSlugs } = _ctx;
      return [
        [remarkFrontmatter, ["yaml", "toml"]],
        () => {
          return (_, file) => {
            const fileData = Buffer.from(file.value as Uint8Array);
            // gray-matter ships a default `javascript` engine (aliased from `js`) that
            // eval()s the frontmatter body, so a file opening with `---js` would run
            // arbitrary code during the build. Only yaml, toml and json (JSON.parse)
            // may parse: the fence language is checked against an allowlist first,
            // and gray-matter gets a fixed engine table rather than the plugin
            // options, so no engine or parser can be added through them. The
            // throwing javascript/js engines stay as a second layer.
            // Defaults are applied here, the way gray-matter would apply them, so the
            // check and the parser always see the same delimiters and language. The
            // options come from YAML config and are not type-checked at runtime.
            const matterOpts = {
              delimiters: opts.delimiters || "---",
              language: opts.language || "yaml",
            };
            assertAllowedFrontmatterLanguage(fileData, matterOpts);
            const { data } = matter(fileData, {
              ...matterOpts,
              engines: {
                yaml: (s) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as object,
                yml: (s) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as object,
                toml: (s) => toml.parse(s) as object,
                json: (s) => JSON.parse(s) as object,
                javascript: rejectJavaScript,
                js: rejectJavaScript,
              },
            });

            const title = scalarToString(data.title);
            if (title !== undefined && title !== "") {
              data.title = title;
            } else {
              data.title = file.stem ?? "Untitled";
            }

            const tags = coerceToArray(coalesceAliases(data, ["tags", "tag"]));
            if (tags) data.tags = [...new Set(tags.map((tag: string) => slugTag(tag)))];

            const aliases = coerceToArray(coalesceAliases(data, ["aliases", "alias"]));
            if (aliases) {
              data.aliases = aliases;
              file.data.aliases = getAliasSlugs(aliases);
              allSlugs.push(...file.data.aliases);
            }

            const permalink = scalarToString(data.permalink);
            if (permalink === undefined) {
              delete data.permalink;
            } else if (permalink !== "") {
              data.permalink = permalink as FullSlug;
              const fileAliases = (file.data.aliases as FullSlug[]) ?? [];
              fileAliases.push(data.permalink);
              file.data.aliases = fileAliases;
              allSlugs.push(data.permalink);
            }

            for (const field of ["description", "socialDescription", "lang"]) {
              if (data[field] === undefined) continue;
              const value = scalarToString(data[field]);
              if (value === undefined) {
                delete data[field];
              } else {
                data[field] = value;
              }
            }

            const cssclasses = coerceToArray(coalesceAliases(data, ["cssclasses", "cssclass"]));
            if (cssclasses) data.cssclasses = cssclasses;

            const socialImage = scalarToString(
              coalesceAliases(data, ["socialImage", "image", "cover"]),
            );

            const created = coalesceAliases(data, ["created", "date"]);
            if (created) data.created = created;

            const modified = coalesceAliases(data, [
              "modified",
              "lastmod",
              "updated",
              "last-modified",
            ]);
            if (modified) data.modified = modified;

            const published = coalesceAliases(data, ["published", "publishDate", "date"]);
            if (published) data.published = published;

            for (const field of ["created", "modified", "published"]) {
              if (data[field] !== undefined && !isDateLike(data[field])) delete data[field];
            }
            if (data.created !== undefined) data.modified ||= data.created;

            if (socialImage) {
              data.socialImage = socialImage;
            } else {
              delete data.socialImage;
            }

            const uniqueSlugs = [...new Set(allSlugs)];
            allSlugs.splice(0, allSlugs.length, ...uniqueSlugs);

            const frontmatterLinks = extractLinksFromValue(data);
            if (frontmatterLinks.length > 0) {
              const existingLinks = (file.data.frontmatterLinks as string[]) ?? [];
              file.data.frontmatterLinks = [...existingLinks, ...frontmatterLinks];
            }

            // Read per-note overrides for properties view visibility and collapsed state
            const showProperties = coerceToBool(
              coalesceAliases(data, ["quartz-properties", "quartzProperties"]),
            );
            const collapseProperties = coerceToBool(
              coalesceAliases(data, ["quartz-properties-collapse", "quartzPropertiesCollapse"]),
            );
            const visibleProps = getVisibleProperties(data, opts);
            file.data.noteProperties = {
              properties: visibleProps,
              hideView: opts.hidePropertiesView,
              showProperties,
              collapseProperties,
            };

            file.data.frontmatter = data as QuartzPluginData["frontmatter"];
          };
        },
      ];
    },
    htmlPlugins(ctx: BuildCtx) {
      return [
        () => {
          return (_tree: unknown, file: { data: Record<string, unknown> }) => {
            const noteProps = file.data.noteProperties as
              | { properties: Record<string, unknown>; resolvedLinks?: Record<string, string> }
              | undefined;
            if (!noteProps) return;

            const fileSlug = file.data.slug as FullSlug;
            const transformOptions: TransformOptions = {
              strategy: "shortest",
              allSlugs: ctx.allSlugs,
            };

            const targets = new Set<string>();
            for (const value of Object.values(noteProps.properties)) {
              for (const t of collectLinkTargetsFromValue(value)) targets.add(t);
            }

            if (targets.size === 0) return;

            const resolved: Record<string, string> = {};
            for (const target of targets) {
              resolved[target] = transformLink(fileSlug, target, transformOptions);
            }
            noteProps.resolvedLinks = resolved;
          };
        },
      ];
    },
  };
};

declare module "vfile" {
  interface DataMap {
    aliases: FullSlug[];
    frontmatterLinks: string[];
    noteProperties: {
      properties: Record<string, unknown>;
      hideView: boolean;
      showProperties?: boolean;
      collapseProperties?: boolean;
      resolvedLinks?: Record<string, string>;
    };
  }
}
