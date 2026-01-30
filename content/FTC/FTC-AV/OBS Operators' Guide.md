---
draft: "true"
---
 - Walkthrough of OBS interface
- Description of scenes
- Walkthrough of ProPresenter interface
- Description of interfaces between PP and OBS (NDI, alphas, etc)
- Opening Ceremonies walkthrough
- Alliance Selection walkthrough
- Description of OBS auto switcher https://obs.vens.co/ (also add setup instructions to [[FTC/FTC-AV/Track 5/5b. Finish OBS Setup]]) if the test works well.

# Description of Scenes
- Blue Only (Field 1)
	Composite scene. The audience display is on top, with a fullscreen display of the camera connected to  the "Blue" input on the Streaming Unit underneath it. For consistency's sake, this should correspond to the camera displaying Field 1.
- Red Only (Field 2)
	Same as the above, but the "Red" input. This should be Field 2.
- Center Only
	Composite scene. The audience display is on top, with a fullscreen display of the camera connected to the "Center" input underneath it. This should be the camera capturing the area between the two fields, for opening and closing ceremonies.
- Alliance Selection
	Composite scene. The audience display is on top, with the center camera input underneath it, scaled down and positioned slightly to the left of center. During alliance selection, the overlay contains a key in this position. Adjustments to the thumbnail may be needed when alliance selection begins.
- Inspection
	**This scene is obsolete.** Fullscreen display of the dedicated inspection status screen.  In most cases, A/V should ask the scorekeeper to display the inspection status on the audience display, as this display is themed (where the dedicated display is not).
- Audio
	**This scene should not be switched to.** This is a "utility" scene that provides the audio from the board to other scenes, so that sources only need to be updated one time to update all relevant video scenes.
- ProPresenter
	**This scene should not be switched to.** This is a "utility" scene that provides the input from the video playback application, ProPresenter, to other scenes, for the same reasons as the Audio scene.
- Particle
	Fullscreen scene. Contains a FIRST Chesapeake logo over looping particle video. Useful for starting/stopping streams or otherwise serving as a scene to cover dead air.
- Aud Display (Main)
  **This scene should not be switched to.** This is a "utility" scene that provides the input from the scoring system/audience display, to other scenes, for the same reasons as the Audio and ProPresenter scenes.
- Test
	**This scene is obsolete.** Fullscreen display of a projector test pattern. Should not be necessary with the latest projector equipment.
# General Video Event Flow
## Venue Open until Start of Stream - Typically 7:00-10:00 AM
- Center Only with audience display overlay showing fullscreen inspection status
- Play event-specific welcome video when crowd begins to enter. ProPresenter will show on top of audience display overlay.
	- Recommend alternating between the two periodically.
- When all teams are finished with inspection, it is recommended to alternate between Particle and the event welcome video.
## Start of Stream - Typically 10:00 AM
- Particle to start all streams until opening ceremonies. 
- **Note down the time of stream start** in the OBS Autoswitcher to provide a start point for stream time stamps. If this isn't completely accurate, that is OK - the timestamps can be corrected afterwards.
## Opening Ceremonies
- Center Only without audience display overlay. **Temporarily disconnect the auto-switcher from OBS to avoid having scenes changed on you by the scorekeepers performing match operations during opening ceremonies.**
	- Can either request scorekeepers to show "video only" in FTC Live, or temporarily hide the Aud Display (Main) scene (click the eye icon to hide) within the Center Only scene.
- Videos play during the opening ceremonies - they are called out in the script. Use ProPresenter to play the videos over the Center Only scene - **do not play opening ceremony videos through FTC Live**.
- After opening ceremonies conclude, re-connect the auto-switcher to OBS if it was disconnected previously.
## Match Play - For Morning Qualifiers, Afternoon Qualifiers, and Playoff Matches
- Alternate (preferably using autoswitcher) between Red Only and Blue Only scenes according to the match currently being played. See the linked section of [[FTC/FTC-AV/Track 5/5b. Finish OBS Setup#12. Open the auto-switcher tool at https //obs.vens.co in a new browser window.||Finish OBS Setup]] (step 12 onwards) for details on configuring the autoswitcher. 
## Lunch
- Leave the autoswitcher and the scenes alone, but it's recommended to display a message explaining that the event is at lunch, and when it is scheduled to resume. This is easiest to do by asking the scorekeepers to put up a message with this information.
## Alliance Selection
- Alliance Selection - be aware that you may need to make adjustments to the camera view within the overlay. Pan/zoom the image so that only the area between fields is visible for best effect.
## Awards
- Center Only with audience display overlay. **Temporarily disconnect the auto-switcher from OBS to avoid having scenes changed on you by the scorekeepers performing match operations towards the end of awards breaks.** Be sure to reconnect after the award break is finished.