## Troubleshooting Guide
1. Is the Raspberry Pi and monitor power LED lit? If yes, proceed to step 2. If no, proceed to [[#No Power]]. 
2. Is the monitor showing anything? (Note: The monitor being powered on with a green LED but showing only a black screen counts as showing something.) If yes, proceed to step 3. If no, proceed to [[#No Display]].
3. Is the monitor showing a rocket ship image and an error message? If yes, proceed to [[#Kiosk Error Messages]]. If no, proceed to step 4.
4. Is the monitor showing a list of multiple FTC events? If yes, proceed to [[#No Event Code]]. If no, proceed to step 5.
5. Is the monitor showing either a black screen or a FIRST-themed season image? If yes, proceed to [[#No Kiosk]]. If no, proceed to step 6.
6. If you have reached this point and have an issue that has not been addressed, contact the FTA for resolution, and afterwards, please file an issue on this [document repository](https://github.com/FIRSTChesapeake/Knowledgebase/issues) so that it can be added to this list.

### No Power
Verify that the power strip coming to the field is switched on and plugged into a good outlet. Verify that all power adapters are securely plugged into an outlet of the power strip (try moving to different outlets). Press the power button on both the Raspberry Pi and the monitor. 
If none of this helps, contact the FTA for resolution, and afterwards, please file an issue on this [document repository](https://github.com/FIRSTChesapeake/Knowledgebase/issues) so that it can be added to this list.

### No Display
Verify that the HDMI cable is securely plugged into the monitor and the Raspberry Pi. If this doesn't work, use the buttons on the monitor to pull up the menu and verify that the HDMI input is selected (don't rely on 'Auto'). Try a different HDMI cable. 
If none of this helps, contact the FTA for resolution, and afterwards, please file an issue on this [document repository](https://github.com/FIRSTChesapeake/Knowledgebase/issues) so that it can be added to this list.

### No Event Code
This state indicates that the Raspberry Pi kiosk successfully connected to the FTC-Live server, but was unable to determine what the current event is. If multiple events are defined in the FTC-Live database, this will trigger this error. The preferred way to fix this issue is to have the Technical Director (formerly Lead Scorekeeper) "hide" all events that are not currently being played. Talk with the Technical Director if you are seeing this issue. If the Technical Director hid all other events, reboot the kiosk to try again. If hiding is not possible, manually defining the current event code will fix this issue. To do this:
1. Connect a USB keyboard to the Raspberry Pi. 
2. While holding the left CTRL and ALT buttons, press F2. This will change to a text terminal view.
3. Log in with the username `pi` and password `mushroom`.
4. Execute the command exactly as shown: `nano /home/pi/.config/openbox/environment`
5. A window should open with some textual content on the screen. If the top window is empty, or a small notification at the bottom of the dark window appears briefly saying `[New File]`, the command was run incorrectly. Check spelling and try again.
6. Locate the line that says `FTCEVENTSERVER_EVENTCODE`. Replace any content after the equals sign with the event code of this event (check with the scorekeeper or FTA if you do not know this). Once finished, hold the CTRL key and hit the X key, then release both. When prompted, press Y to save, then Enter, accepting any overwrite notices.
7. Reboot the Raspberry Pi.
If none of this helps, contact the FTA for resolution, and afterwards, please file an issue on this [document repository](https://github.com/FIRSTChesapeake/Knowledgebase/issues) so that it can be added to this list.
### No Kiosk
This state indicates something went wrong with running the startup script. You will likely need the assistance of the FTA to resolve this issue. To determine what went wrong:
1. Connect a USB keyboard to the Raspberry Pi. 
2. While holding the left CTRL and ALT buttons, press F2. This will change to a text terminal view.
3. Log in with the username `pi` and password `mushroom`.
4. Execute the command exactly as shown: `tail -n 5 /home/pi/RPIKiosk.log`
5. Observe the time stamp at the beginning of the log lines. If they are recent, work with the FTA to diagnose the issue, potentially utilizing more of the contents of the log file. If they are not recent, execute the command exactly as shown:
	`sudo dos2unix /etc/xdg/openbox/autostart`
	You will need to enter the password of the `pi` user; `mushroom`.
6. Reboot the Raspberry Pi after any actions to attempt starting the kiosk again.
If none of this helps, continue to work with the FTA for resolution, and afterwards, please file an issue on this [document repository](https://github.com/FIRSTChesapeake/Knowledgebase/issues) so that it can be added to this list.
## Kiosk Error Messages
This state indicates the Raspberry Pi kiosk has initialized successfully but has detected an error. Possible solutions to each displayed error are shown below. After taking any steps to rectify the issue, it is necessary to reboot the Raspberry Pi.
##### System failed to have eth0 or wlan0 go to up state. Please check cable and/or WiFi config.
Ensure that the Ethernet cable is plugged into the Raspberry Pi securely. There should be LEDs lit up around the Ethernet connector to indicate active link and activity. We do not utilize Wi-Fi connections for the field displays.
##### System failed to receive IP address in reasonable time (~50 seconds).
Ensure that the A/V system has been powered up for several minutes before powering up the Raspberry Pis. Unplug and plug the Ethernet connection back in, then reboot the kiosk. If this message persists, a deeper network issue may be present; consult Equipment Manager or FTA.

##### FTC Server '(IP address)' with hostname '(hostname)' port '(port)' is NOT online! Please check if the IP is correct or if the server is online/accessible.
Note that the contents (IP address), (hostname), and (port) will be filled in by numeric values if this error is displayed.
Verify that the IP address listed in the error message is the same as the IP address for the scorekeeper laptop. If it is not, reset the address using the steps below. If it is, verify that the FTC-Live software is running on the scorekeeper laptop, then reboot the Raspberry Pi.
1. Connect a USB keyboard to the Raspberry Pi. 
2. While holding the left CTRL and ALT buttons, press F2. This will change to a text terminal view.
3. Log in with the username `pi` and password `mushroom`.
4. Execute the command exactly as shown: `nano /home/pi/.config/openbox/environment`
5. A window should open with some textual content on the screen. If the top window is empty, or a small notification at the bottom of the dark window appears briefly saying `[New File]`, the command was run incorrectly. Check spelling and try again.
6. Locate the line that says `FTCEVENTSERVER_IP.` Replace any content after the equals sign with the IP address of the scoring server as it appears on the scorekeeper laptop. Once finished, hold the CTRL key and hit the X key, then release both. When prompted, press Y to save, then Enter, accepting any overwrite notices.
7. Reboot the Raspberry Pi.
If none of this helps, contact the FTA for resolution, and afterwards, please file an issue on this [document repository](https://github.com/FIRSTChesapeake/Knowledgebase/issues) so that it can be added to this list.
##### No mode selected! Please verify then reboot. or More than one MODE has been selected! Please verify then reboot.
Verify that the MODE switch has been set to a valid value as shown in the [[Field Timer (Raspberry Pi) Setup|FTC Scoring Setup guide]]. 
##### The selected FIELD is incorrect! Please verify then reboot.
Verify that the FIELD switch has been set to a valid value for the event as shown in the [[Field Timer (Raspberry Pi) Setup|FTC Scoring Setup guide]]. This is most commonly caused by setting a field that does not exist (e.g., FIELD 3 is set for an event with only 2 fields).

