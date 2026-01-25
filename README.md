# [View the Knowledgebase 🚀](https://firstchesapeake.github.io/knowledgebase/)
Welcome to the Chesapeake Knowledgebase repository. This repository is intended to host instructions for the setup of equipment at [FRC](https://www.firstinspires.org/robotics/frc/) and [FTC](https://www.firstinspires.org/robotics/ftc/) events that are hosted by [FIRST Chesapeake](https://firstchesapeake.org/). 

# Project Details

The goal of this Knowledgebase is to provide relatively 'evergreen' documentation that does not change from year to year. Game-specific documentation should not be included unless it substantially changes the setup instructions.


Current scope:
- FRC
	- Audio/Visual (A/V) setup instructions

Desired future additions:
- FRC
	- Pit power setup instructions
- FTC
	- Audio/Visual (A/V) setup instructions
	- Scoring system setup instructions
	- Field display Raspberry Pi setup instructions

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
The 'main' branch hosts the live content on the website.

