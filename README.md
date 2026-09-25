# [View the Knowledgebase 🚀](https://firstchesapeake.github.io/knowledgebase/)
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
Required software: [Obsidian](https://obsidian.md) and [Node.JS](https://nodejs.org) v20 or higher.
1. Clone the Github repository.
2. Navigate to the folder of the cloned repository and issue the following command in a terminal:
   `npm i`.
3. Open Obsidian, then select the "Open Folder as Vault" option.
4. Navigate to the folder of the cloned repository and select the "content" folder within it, then select "Open Folder".
e.g., if the repository has been cloned to C:\\Users\\Admin\\Documents\\Knowledgebase, you should open C:\\Users\\Admin\\Documents\\Knowledgebase\\content as the vault.
5. Make any updates or changes (which are saved automatically by Obsidian). When you are finished, execute
   `npx quartz sync` in a terminal that is navigated to the folder of the cloned repository to sync changes with the Github repository.
   For details on editing and style suggestions, please see the repository's wiki.

When editing, it is recommended to enable the live Web preview by executing the command:
`npx quartz build --serve`. This will start a website on your local machine at http://localhost:8080 that automatically refreshes as content changes are made. The preview on Obsidian can sometimes be inaccurate to the final Web appearance.



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

Either way, you can watch the publish on the [Actions](https://github.com/FIRSTChesapeake/Knowledgebase/actions) tab under "Deploy Quartz site to GitHub Pages". It usually takes a few minutes; once it shows a green check, the website is updated. Only commits that are already on 'main' can be published: a tag on any other branch will fail.

