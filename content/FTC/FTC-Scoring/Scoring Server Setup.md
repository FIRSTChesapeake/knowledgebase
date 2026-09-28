 Equipment needed: Scoring server computer, USB to Ethernet adapter (if necessary for the server laptop).
 
 This article will describe a few details that are specifically necessary for effective setup of the scoring server on the *FIRST* Chesapeake event & AV system. Any computer fulfilling the role of the FTC Live server with *FIRST* Chesapeake equipment should ensure that these settings are applied for compatibility with the rest of the *FIRST* Chesapeake ecosystem. This guide will **not** cover the setup and operation of the FTC Live software itself, for information on this please see the official FTC Live setup instructions, available each season from the [FTC Resources](https://ftc-resources.firstinspires.org/ftc) website.

### Before Starting FTC-Live
Ensure that the IP address of the scoring server (laptop) is correct. The IP address needs to be set statically. 
1. Connect the scoring server to the scoring network. This must be a wired Ethernet connection, either with a dedicated Ethernet port on the computer or through a USB Ethernet adapter. Ensure that this connection is to one of the Ethernet ports on the back of the A/V Streaming Unit labeled "LAN".
2. Open the network settings of the computer by right-clicking the network icon and selecting "Network and Internet settings".![[network-settings.png]]
3. Within the window that opens, click "Ethernet".
4. Check the entry within the Ethernet section to see what its IP settings are. If you see that the  value of the "IPv4 Address" is **192.168.XXX.2** (ignoring the value within the third number), this step has already been completed. If you see **any other value**, continue to the next steps.

> [!steps]- Tap to expand/collapse instructions on correcting the scoring server's IP address.
> Contents
> 1. Take note of the current settings displayed in the window. Specifically, note down the values shown for "IPv4 address", "IPv4 default gateway", and "IPv4 DNS servers".
> ![[ip-settings-display.jpg]]
> 2. Click the "Edit" button next to "IP assignment". In the window that appears, change the value to "Manual", and then click the switch underneath the header that says "IPv4" to turn it on.
>    ![[ipv4-address-manual-settings.png]]
> 3. Fill out the settings as follows:
> 	1. IP address: Copy the first 3 numbers that were previously displayed in the display (e.g., 192.168.253). Change the last number to 2 (e.g., 192.168.253.2). 
> 	2. Subnet mask: Insert the value 255.255.255.0.
> 	3. Gateway: Insert the numbers that were shown for "IPv4 default gateway" previously.
> 	4. Preferred DNS: Insert the numbers that were shown for "IPv4 DNS servers" previously.
> 	5. DNS over HTTPS: Off

Continue to setup FTC-Live as normal.
### After starting FTC-Live
Verify that the banner at the top of the FTC-Live default page states the same IP address (192.168.XXX.2) seen or configured in the previous steps. Then, test that the local DNS name is working correctly by opening up the web browser and inputting the address `http://scoring.northscore/` or `http://scoring.southscore/`, depending on whether your event is using the "north" or "south" set of event equipment (you can check with the FTA or Equipment Manager if you don't know this). This should show the FTC-Live server webpage. 
If the DNS name does not work correctly, connect with the Equipment Manager to troubleshoot network issues.