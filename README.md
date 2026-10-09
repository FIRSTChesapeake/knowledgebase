# [View the Knowledgebase 🚀](https://kb.firstchs.org/)
Welcome to the Chesapeake Knowledgebase repository. This repository is intended to host instructions for the setup of equipment at [FRC](https://www.firstinspires.org/robotics/frc/) and [FTC](https://www.firstinspires.org/robotics/ftc/) events that are hosted by [FIRST Chesapeake](https://firstchesapeake.org/). 

# Project Details

The goal of this Knowledgebase is to provide relatively 'evergreen' documentation that does not change from year to year. Game-specific documentation should not be included unless it substantially changes the setup instructions.



Current scope:
- FRC
	- Audio/Visual (A/V) setup instructions
- FTC
	- Audio/Visual (A/V) setup instructions
	- Selected Scoring system setup instructions (small articles)

Desired future additions:
- FRC
	- Pit power setup instructions

# Contributing
Required software: [Obsidian](https://obsidian.md) and [Node.JS](https://nodejs.org) v22 or higher.
1. Clone the Github repository.
2. Navigate to the folder of the cloned repository and issue the following command in a terminal:
   `npm i`, then `npx quartz plugin install --from-config` (this builds the site's local frontmatter plugin, see "Updating Quartz" below).
3. Open Obsidian, then select the "Open Folder as Vault" option.
4. Navigate to the folder of the cloned repository and select the "content" folder within it, then select "Open Folder".
e.g., if the repository has been cloned to C:\\Users\\Admin\\Documents\\Knowledgebase, you should open C:\\Users\\Admin\\Documents\\Knowledgebase\\content as the vault.
5. Make any updates or changes (which are saved automatically by Obsidian). When you are finished, execute
   `npx quartz sync` in a terminal that is navigated to the folder of the cloned repository to sync changes with the Github repository.
   For details on editing and style suggestions, please see the repository's wiki.

When editing, it is recommended to enable the live Web preview by executing the command:
`npx quartz build --serve` (run `npx quartz plugin install --from-config` once first, if you haven't). This will start a website on your local machine at http://localhost:8080 that automatically refreshes as content changes are made. The preview on Obsidian can sometimes be inaccurate to the final Web appearance.

Page addresses on the website are all lowercase (for example `.../ftc/ftc-av/...`). Addresses from before the Quartz 5 update, which kept the capital letters, still work: they redirect to the lowercase page.



# Merging
Note that the above steps will not cause the new content to appear on the website. The Quartz tool syncs changes to an intermediate branch, which is entitled with your Git username, a dash, and 'v4'.
This is to provide a staging ground for changes. When ready, please open a [Pull Request](https://github.com/FIRSTChesapeake/Knowledgebase/pulls) and request to merge into the 'main' branch.
The 'main' branch holds the content that is ready to publish, but merging into it does **not** update the website by itself. See "Publishing to the website" below.

# Publishing to the website
Merged your Pull Request but the website hasn't changed? That is expected. The website is only rebuilt when a new version tag (e.g. `v26.7.0`) is pushed to GitHub. This lets several merged changes be reviewed together and published at once.

Versions look like `26.7.0`: the year, then a running number. You can see the history in the changelog at the top of `content/index.md`. The tag uses the same number as the changelog, with a `v` in front, so the page and the tag always match.

To publish everything currently on 'main':
1. Add a new "Changes from vPREVIOUS" entry to the changelog callout at the top of `content/index.md`, and bump the version and date in its header line. Do this in the same Pull Request as your changes, or in a Pull Request of its own.
2. Merge that Pull Request into 'main'.
3. Push a tag with exactly the same number as the changelog, prefixed with `v` (for example `v26.7.0`). Using a terminal:
   `git checkout main`
   `git pull`
   `git tag v26.7.0`
   `git push origin v26.7.0`

Without a terminal: on GitHub, go to [Releases](https://github.com/FIRSTChesapeake/Knowledgebase/releases) → "Draft a new release" → "Choose a tag", type the new version (e.g. `v26.7.0`) and select "Create new tag on publish", make sure the target is 'main', then select "Publish release".

Either way, you can watch the publish on the [Actions](https://github.com/FIRSTChesapeake/Knowledgebase/actions) tab under "Deploy knowledgebase". Only commits that are already on 'main' can be published: a tag on any other branch will fail. The website is served from the CHS cluster at https://kb.firstchs.org, which picks up the new version on its own a few minutes after the run shows a green check (see `k8s-do/README.md`). The old GitHub Pages copy is no longer updated.

# Updating Quartz
The site is built with [Quartz](https://github.com/jackyzha0/quartz) 5, imported from upstream commit `97a2d05` (the `v5` branch on 2026-09-20). The framework files (`quartz/`, `package.json`, `package-lock.json`, `quartz.ts`, `quartz.config.default.yaml` and the other root build files) are a copy of upstream. The site's own settings live in `quartz.config.yaml`, and its style changes in `quartz/styles/custom.scss`.

To update Quartz, copy the framework files from a newer upstream commit in a single change, the same way, and record the commit here. Then compare `quartz.config.default.yaml` with the previous one and carry any new settings into `quartz.config.yaml`. Don't run `npx quartz upgrade` or `npx quartz create`: this repository doesn't follow upstream's branch history, so an upgrade would conflict on every file.

A few files in `quartz/` carry local changes that must be reapplied after an update:
- `quartz/plugins/loader/config-loader.ts`, `componentLoader.ts` and `frameLoader.ts`: an enabled plugin that fails to install, load or start stops the build. Upstream only prints a warning and publishes the site without that plugin, for example with raw page headers and drafts when the frontmatter plugin is missing. Tested by `config-loader.strict.test.ts`.
- `quartz/util/escape.ts`: `unescapeHTML` decodes `&amp;` last. Tested by `escape.test.ts`.
- `quartz/cli/constants.js` and `handlers.js`: `npx quartz sync` uses the per-user staging branch.
- `quartz/styles/custom.scss`, `quartz/static/icon.png` and `og-image.png`: the site's styles and icons.

`plugins/note-properties` is a local copy of Quartz's frontmatter plugin. The upstream plugin still lets a page whose header starts with `---js` run JavaScript while the site is built, and it bundles an outdated `toml` parser. The local copy only accepts YAML, TOML and JSON headers and pins current parser versions. Its README lists every change against upstream. When updating Quartz, keep this copy unless upstream has fixed both problems. Run its tests with `npm ci && npm test` inside that folder.
