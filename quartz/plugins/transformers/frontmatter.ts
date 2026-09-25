import matter from "gray-matter"
import remarkFrontmatter from "remark-frontmatter"
import { QuartzTransformerPlugin } from "../types"
import yaml from "js-yaml"
import toml from "toml"
import { FilePath, FullSlug, getFileExtension, slugifyFilePath, slugTag } from "../../util/path"
import { QuartzPluginData } from "../vfile"
import { i18n } from "../../i18n"

export interface Options {
  delimiters: string | [string, string]
  language: "yaml" | "toml"
}

const defaultOptions: Options = {
  delimiters: "---",
  language: "yaml",
}

function coalesceAliases(data: { [key: string]: any }, aliases: string[]) {
  for (const alias of aliases) {
    if (data[alias] !== undefined && data[alias] !== null) return data[alias]
  }
}

function coerceToArray(input: string | string[]): string[] | undefined {
  if (input === undefined || input === null) return undefined

  // coerce to array
  if (!Array.isArray(input)) {
    input = input
      .toString()
      .split(",")
      .map((tag: string) => tag.trim())
  }

  // remove all non-strings
  return input
    .filter((tag: unknown) => typeof tag === "string" || typeof tag === "number")
    .map((tag: string | number) => tag.toString())
}

function getAliasSlugs(aliases: string[]): FullSlug[] {
  const res: FullSlug[] = []
  for (const alias of aliases) {
    const isMd = getFileExtension(alias) === "md"
    const mockFp = isMd ? alias : alias + ".md"
    const slug = slugifyFilePath(mockFp as FilePath)
    res.push(slug)
  }

  return res
}

const allowedFrontmatterLanguages = new Set(["yaml", "yml", "toml", "json"])

// Mirrors how gray-matter picks the fence language (BOM stripped, text after the
// opening delimiter up to the end of the line, trimmed; the configured language
// when that is empty) so the two cannot disagree about which engine will run.
function assertAllowedFrontmatterLanguage(
  fileData: Buffer,
  matterOpts: Pick<Options, "delimiters" | "language">,
) {
  const content = fileData.toString().replace(/^\uFEFF/, "")
  const { delimiters } = matterOpts
  const open = Array.isArray(delimiters) ? delimiters[0] : delimiters
  if (typeof open !== "string" || open === "") {
    throw new Error("Unsupported frontmatter delimiters: a non-empty string is required")
  }
  if (!content.startsWith(open) || content.charAt(open.length) === open.slice(-1)) return

  const fence = matter.language(content.slice(open.length), { delimiters }).name
  const language = (fence || matterOpts.language).toLowerCase()
  if (!allowedFrontmatterLanguages.has(language)) {
    throw new Error("Unsupported frontmatter language: only yaml, toml and json are allowed")
  }
}

export const FrontMatter: QuartzTransformerPlugin<Partial<Options>> = (userOpts) => {
  const opts = { ...defaultOptions, ...userOpts }
  return {
    name: "FrontMatter",
    markdownPlugins(ctx) {
      const { cfg, allSlugs } = ctx
      return [
        [remarkFrontmatter, ["yaml", "toml"]],
        () => {
          return (_, file) => {
            const fileData = Buffer.from(file.value as Uint8Array)
            // gray-matter ships a default `javascript` engine (aliased from `js`) that
            // eval()s the frontmatter body, so a file opening with `---js` would run
            // arbitrary code during the build. Only yaml, toml and json (JSON.parse)
            // may parse: the fence language is checked against an allowlist first,
            // and gray-matter gets a fixed engine table rather than the plugin
            // options, so no engine or parser can be added through them. The
            // throwing javascript/js engines stay as a second layer.
            // Defaults are applied here, the way gray-matter would apply them, so the
            // check and the parser always see the same delimiters and language.
            const matterOpts = {
              delimiters: opts.delimiters || "---",
              language: opts.language || "yaml",
            }
            assertAllowedFrontmatterLanguage(fileData, matterOpts)
            const { data } = matter(fileData, {
              ...matterOpts,
              engines: {
                yaml: (s) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as object,
                yml: (s) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as object,
                toml: (s) => toml.parse(s) as object,
                json: (s) => JSON.parse(s),
                javascript: () => {
                  throw new Error("JavaScript frontmatter is not supported")
                },
                js: () => {
                  throw new Error("JavaScript frontmatter is not supported")
                },
              },
            })

            if (data.title != null && data.title.toString() !== "") {
              data.title = data.title.toString()
            } else {
              data.title = file.stem ?? i18n(cfg.configuration.locale).propertyDefaults.title
            }

            const tags = coerceToArray(coalesceAliases(data, ["tags", "tag"]))
            if (tags) data.tags = [...new Set(tags.map((tag: string) => slugTag(tag)))]

            const aliases = coerceToArray(coalesceAliases(data, ["aliases", "alias"]))
            if (aliases) {
              data.aliases = aliases // frontmatter
              file.data.aliases = getAliasSlugs(aliases)
              allSlugs.push(...file.data.aliases)
            }

            if (data.permalink != null && data.permalink.toString() !== "") {
              data.permalink = data.permalink.toString() as FullSlug
              const aliases = file.data.aliases ?? []
              aliases.push(data.permalink)
              file.data.aliases = aliases
              allSlugs.push(data.permalink)
            }

            const cssclasses = coerceToArray(coalesceAliases(data, ["cssclasses", "cssclass"]))
            if (cssclasses) data.cssclasses = cssclasses

            const socialImage = coalesceAliases(data, ["socialImage", "image", "cover"])

            const created = coalesceAliases(data, ["created", "date"])
            if (created) {
              data.created = created
            }

            const modified = coalesceAliases(data, [
              "modified",
              "lastmod",
              "updated",
              "last-modified",
            ])
            if (modified) data.modified = modified
            data.modified ||= created // if modified is not set, use created

            const published = coalesceAliases(data, ["published", "publishDate", "date"])
            if (published) data.published = published

            if (socialImage) data.socialImage = socialImage

            // Remove duplicate slugs
            const uniqueSlugs = [...new Set(allSlugs)]
            allSlugs.splice(0, allSlugs.length, ...uniqueSlugs)

            // fill in frontmatter
            file.data.frontmatter = data as QuartzPluginData["frontmatter"]
          }
        },
      ]
    },
  }
}

declare module "vfile" {
  interface DataMap {
    aliases: FullSlug[]
    frontmatter: { [key: string]: unknown } & {
      title: string
    } & Partial<{
        tags: string[]
        aliases: string[]
        modified: string
        created: string
        published: string
        description: string
        socialDescription: string
        publish: boolean | string
        draft: boolean | string
        lang: string
        enableToc: string
        cssclasses: string[]
        socialImage: string
        comments: boolean | string
      }>
  }
}
