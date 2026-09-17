---
title: Event Streaming Management
---
# Contents
[[#What Is Event Streaming Management]]
[[#Who This Section Is For]]
[[#Before You Start]]
[[#Getting Help]]

# What Is Event Streaming Management

This section documents the platform *FIRST* Chesapeake uses to turn a live event stream into
published, per-match highlight clips. In short, the platform:

- Ingests a live RTMP stream from an event's A/V setup.
- Automatically detects match timing from the *FIRST* Events APIs (and, for FRC events, The Blue
  Alliance).
- Cuts a clip for each match and uploads it to YouTube.
- Optionally restreams the event as a full YouTube broadcast, and can drive event signage
  (pit/queue/audience displays) through the same platform.

This is a separate system from the A/V hardware setup covered in [[FTC/FTC-AV/index|FTC A/V Setup Guide]]
and [[FRC/FRC-AV/index|FRC A/V Home]] — those guides get a clean stream out of OBS; this section covers
what happens to that stream afterward.

# Who This Section Is For

Pick the guide that matches what you're doing:

- **[[Event-Streaming-Management/Operators/index|Operators]]** — you're an A/V volunteer running
  this platform at or after an event: setting up an event, watching it go live, and reviewing what
  gets published.
- **[[Event-Streaming-Management/Client-Administration/index|Client Administration]]** — you
  administer your organization's account on the platform: members, roles, integrations, and
  branding.
- **[[Event-Streaming-Management/System-Administration/index|System Administration]]** — you
  install, configure, or operate the platform itself: Kubernetes deployment, secrets, system-wide
  settings, and troubleshooting.

# Before You Start

You'll need a stream to send this platform in the first place. If you haven't set up the A/V
hardware and OBS for your event yet, start with [[FTC/FTC-AV/index|FTC A/V Setup Guide]] or
[[FRC/FRC-AV/index|FRC A/V Home]] first, then come back here.

The platform's web dashboard is at [splitter.firstchs.org](https://splitter.firstchs.org).

# Getting Help

If a guide in this section doesn't cover what you're seeing, or something looks broken, contact
*FIRST* Chesapeake technology support at
[technology@firstchesapeake.org](mailto:technology@firstchesapeake.org).
