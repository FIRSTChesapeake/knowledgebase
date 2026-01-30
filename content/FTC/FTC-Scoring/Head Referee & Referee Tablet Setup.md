1. Ensure that the server is logged into with "Event Admin" permissions or higher. The default 'local' user has these permissions.
2. Click the FTC Logo to go to the event homepage.
3. Scroll down to section Event Administration and click Match Control Page.
	![[FTC-Live_match_control_annotated.png]]
4. In the match control page, open the Settings tab (shown by the red arrow).
5. Enable the following settings as shown below. 
![[FTC-Live_match_control_page_settings_annotated.png]]
These settings are explained in the table below.

|                      Setting                       |                                                         Description                                                         |
| :------------------------------------------------: | :-------------------------------------------------------------------------------------------------------------------------: |
|                Enable Live Scoring                 |                Allows Referees to Input scores through tablets (as opposed to filling out paper scoresheets)                |
| Require Referee Init Submit <br>before Match Start | Prevents starting a match until all referees (both scoring and penalty if configured) have submitted their pre-match setup. |
|           Enable Penalty Referee Tablets           |                            Allows penalty refs to key in penalties (requires 4 referee tablets).                            |
|              Enable HR Match Control               |    Head Referees can operate Match Control buttons (Will Show a warning banner on the Scorekeeper's Match Control Page)     |
|           Enable External Randomization            |       Check if using another source of random numbers like a giant foam die. Recommend to leave unchecked otherwise.        |

> [!caution] Warning
> Unchecking the "Require Referee Init Submit before Match Start" box allows starting a match without referee pre-match submission. The "Start Match" Button will show red, and clicking it will start a match without any warning whatsoever. Leave this option checked to reduce the likelihood of false starts.

6. If configured correctly, the Referee Score Tracking section on the event homepage will look like this:
   ![[FTC-Live_referee_score_tracking_correct.webp]]
7. The Head Referee Tablet should also have a new tab for Match Control.
    ![[FTC-Live_HR_match_control.webp]]