# @quartz-community/note-properties (local copy)

This is an in-repo copy of [quartz-community/note-properties](https://github.com/quartz-community/note-properties)
at upstream commit `6abae397e87c57ac9af9a9cd4a1567f22b686c91` (1.0.0), loaded from
`quartz.config.yaml` with `source: ./plugins/note-properties`. It exists because the upstream
plugin still lets a page run JavaScript at build time (see #57 and #64).

## Local changes

- **Frontmatter language allowlist.** gray-matter ships a `javascript` engine (aliased `js`)
  that `eval`s the frontmatter body, so a page opening with `---js` would run code during the
  build. The fence language is now checked against yaml, yml, toml and json before parsing,
  gray-matter gets a fixed engine table that the plugin options cannot extend or replace, and
  the `javascript`/`js` engines throw.
- **Scalar coercion.** `title`, `permalink`, `description`, `socialDescription`, `lang` and
  `socialImage` are only kept when they are strings or numbers; tags, aliases and cssclasses
  drop non-scalar values. toml tables have no prototype and used to crash `.toString()`.
- **Dates.** `created`, `modified` and `published` are removed when they are not a string,
  number or Date, so created-modified-date falls back to git or the filesystem instead of
  receiving a table.
- **Dependencies.** `toml` is `~4.2.0` (upstream bundles `^3.0.0`) and `js-yaml` is `^4.3.2`.
  Both are bundled into `dist/` at install time, so they are pinned here by this folder's
  `package-lock.json`.
- Tests for all of the above are in `test/frontmatterEngines.test.ts` and
  `test/frontmatterCoercion.test.ts` (`npm ci && npm test` in this folder).
- Upstream's `.github/` and `.changeset/` release tooling is not copied.

`dist/` is built by `npx quartz plugin install` and must never be committed: the plugin
loader uses an existing `dist/` as is, so a stale one would run old code.

---

Upstream README:

Parses frontmatter properties and renders them as a visible properties view on the page, similar to Obsidian's properties panel.

## Installation

```bash
npx quartz plugin add github:quartz-community/note-properties
```

## Usage

This plugin serves as both a **transformer** (parsing frontmatter) and a **component** (displaying the properties view).

```yaml title="quartz.config.yaml"
plugins:
  # Transformer (parses frontmatter)
  - source: github:quartz-community/note-properties
    enabled: true
    options:
      includeAll: false
      includedProperties:
        - description
        - tags
        - aliases
      excludedProperties: []
      hidePropertiesView: false
      delimiters: "---"
      language: yaml

  # Component (displays properties in the page layout)
  - source: github:quartz-community/note-properties
    enabled: true
    layout:
      position: beforeBody
      priority: 15
```

For advanced use cases, you can override in TypeScript:

```ts title="quartz.ts (override)"
import * as ExternalPlugin from "./.quartz/plugins";

ExternalPlugin.NoteProperties({
  includeAll: false,
  includedProperties: ["description", "tags", "aliases"],
  excludedProperties: [],
  hidePropertiesView: false,
  delimiters: "---",
  language: "yaml",
});
```

## Configuration

| Option               | Type       | Default                              | Description                                               |
| -------------------- | ---------- | ------------------------------------ | --------------------------------------------------------- |
| `includeAll`         | `boolean`  | `false`                              | Whether to include all frontmatter properties.            |
| `includedProperties` | `string[]` | `["description", "tags", "aliases"]` | Properties to include when `includeAll` is `false`.       |
| `excludedProperties` | `string[]` | `[]`                                 | Properties to exclude when `includeAll` is `true`.        |
| `hidePropertiesView` | `boolean`  | `false`                              | Whether to hide the rendered properties view on the page. |
| `delimiters`         | `string`   | `"---"`                              | The frontmatter delimiter style.                          |
| `language`           | `string`   | `"yaml"`                             | The frontmatter language (`"yaml"` or `"toml"`).          |

## Documentation

See the [Quartz documentation](https://quartz.jzhao.xyz/plugins/Frontmatter) for more information.

## License

MIT
