---
title: Event Streaming — FAQ and Glossary
---
# Contents
[[#Glossary]]
[[#Frequently Asked Questions]]

Terms and short answers that come up across all three audiences in this section. If a term has a
longer explanation elsewhere, this page links to it rather than repeating it.

# Glossary

- **Client** — the platform's word for a tenant organization's account (for example, your FRC/FTC
  program or league). Every user, stream key, event, and setting belongs to exactly one Client,
  except system-wide settings, which apply platform-wide. See
  [[Event-Streaming-Management/Client-Administration/1. Members and Roles|Members and Roles]].
- **Client Admin / Client User / Client Readonly** — the three roles a Client Member can have,
  shown in the dashboard as **Client Admin**, **User** and **Readonly**. **Readonly** watches
  (including the live preview), **User** operates the event day, and **Client Admin** configures and
  undoes. See [[Event-Streaming-Management/Client-Administration/1. Members and Roles#What Each Role Can Actually Do|What Each Role Can Actually Do]].
- **Stream key** — the credential your encoder (OBS, directly or through the plugin) uses to send
  video into the platform for a given event. **User** and above can reveal and copy one; only
  system admins add, edit, rotate or delete stream keys. See
  [[Event-Streaming-Management/Client-Administration/2. Stream Keys and Restream Keys|Stream Keys and Restream Keys]].
- **Restream key** — a separate credential (your destination's own RTMP key, e.g. YouTube's) used
  for the manual-restream-target path, distinct from the stream key used for ingest. Unlike stream
  keys, a Client Admin can create and delete these themselves. Rotating or deleting one is refused
  while an event using it has a live broadcast or a running push. See
  [[Event-Streaming-Management/Client-Administration/2. Stream Keys and Restream Keys|Stream Keys and Restream Keys]].
- **Push vs. broadcast** — "pushing" is sending your already-ingested stream onward toward YouTube
  (the **Start Push** / **Stop Push** controls); "broadcast" is the YouTube Live broadcast itself
  that viewers watch, controlled separately with **Go Live** / **Stop Broadcast** once the push is
  active. The push goes to today's broadcast and stays pinned to it until it's stopped. See
  [[Event-Streaming-Management/Operators/3. Running a Live Event|Running a Live Event]].
- **Discovered vs. configured** — a **discovered** event is one the platform found automatically
  from the *FIRST* Events APIs but nobody has set up yet (no stream key, no other settings). It
  becomes **configured** once a Client Admin fills in its stream key and other settings. See
  [[Event-Streaming-Management/Operators/2. Managing Events|Managing Events]].
- **Operation mode** — a system-wide setting (`record_only`, `lite_mode`, or `full_power`) that
  gates how much of the pipeline runs platform-wide. See
  [[Event-Streaming-Management/System-Administration/2. System Settings Reference|System Settings Reference]].
- **Test event** — a synthetic event with fake matches that a system admin can create to rehearse
  the full pipeline (a real stream still has to be sent in) without touching real event data. Only
  system admins create or unconfigure test events; client members can then configure and run one
  like any other event, except for its stream window. See
  [[Event-Streaming-Management/System-Administration/4. System Admins and Test Mode|System Admins and Test Mode]].
- **OBS Test Clock** — an unauthenticated browser-source URL a system admin can hand to any
  operator to sanity-check their OBS video/audio pipeline before a stream, without needing a test
  event. See
  [[Event-Streaming-Management/System-Administration/4. System Admins and Test Mode|System Admins and Test Mode]].
- **Signage** — physical or web-based displays (pit, queueing, audience, wait-time, or a custom
  URL) that the platform can drive on a per-event basis. See
  [[Event-Streaming-Management/Operators/5. Clips, Uploads and Signage#Signage|Clips, Uploads and Signage]].
- **Pre-event test** (status `pre_live`) — video is coming in before the event's start time. The
  event shows a "Pre-event test" badge, never restreams, and becomes live at the start time. See
  [[Event-Streaming-Management/Operators/6. Troubleshooting#The Event Shows Pre-Event Test and Start Push Is Refused|Troubleshooting]].
- **Stream window** — **Stream start** and **Stream end** on the event configuration page: when the
  event's stream key may publish, plus one day before as a pre-event test. See
  [[Event-Streaming-Management/Client-Administration/6. Event Configuration Reference#Stream Window|Event Configuration Reference]].
- **Holding / standby slate** — "Holding — standby slate on YouTube". If OBS drops during a push,
  the push keeps YouTube fed with a black slate while OBS reconnects, and gives up after the hold
  timeout. See
  [[Event-Streaming-Management/Operators/3. Running a Live Event#Starting and Stopping the Push|Running a Live Event]].
- **Today's broadcast** — the current, non-replaced YouTube broadcast for today's date in the
  event's timezone. **Start Push** and **Go Live** use it. See
  [[Event-Streaming-Management/Operators/8. YouTube Broadcasts|YouTube Broadcasts]].
- **Broadcast day** — a date listed under **Broadcast days** on the event's Livestream tab. See
  [[Event-Streaming-Management/Operators/8. YouTube Broadcasts|YouTube Broadcasts]].
- **Replaced broadcast** — an older broadcast for a day, shown as "Replaced" in the broadcast
  history. It stays on YouTube until a Client Admin uses **Delete on YouTube**. See
  [[Event-Streaming-Management/Operators/8. YouTube Broadcasts#Replaced Broadcasts and Delete on YouTube|YouTube Broadcasts]].
- **Action reason / 🔒** — a greyed-out control shows why you can't use it. A 🔒 means a role or
  system policy; no 🔒 means the event's current state. A 🔒 next to a field label means the field
  is locked. See [[Event-Streaming-Management/Client-Administration/1. Members and Roles#What Each Role Can Actually Do|What Each Role Can Actually Do]].
- **Invite expiry** — an invite link works for 7 days. See
  [[Event-Streaming-Management/Client-Administration/1. Members and Roles|Members and Roles]].

# Frequently Asked Questions

> [!question]- Do I need the OBS plugin, or can I set OBS up myself?
> Either works. The plugin fills in your stream server/key and recommended encoder settings for
> you; without it, you copy the same values manually from the Stream Keys page. See
> [[Event-Streaming-Management/Operators/4. OBS Plugin Guide|OBS Plugin Guide]].

> [!question]- Why can't I click a control that a teammate can click?
> Every role sees every control. One you can't use is greyed out and says why when you hover over it
> or tap it, and primary buttons also show the reason on a line underneath. Reasons starting with
> 🔒 come from your role or a system policy: "🔒 Needs User or above", "🔒 Needs Client Admin",
> "🔒 Turned off by system administrators" or "🔒 Set by system administrators". A reason without a
> 🔒 is about the event's current state (for example, the stream is live). The **YouTube**,
> **Slack**, **Members** and **Branding** pages stay hidden below **Client Admin**. See
> [[Event-Streaming-Management/Client-Administration/1. Members and Roles#What Each Role Can Actually Do|What Each Role Can Actually Do]].

> [!question]- YouTube says the stream is healthy but it won't play.
> YouTube's "healthy" only means it is *receiving* video; nothing in the platform checks that
> YouTube is actually playing the stream or that it has audio. Missing or non-AAC audio is a common
> cause. See
> [[Event-Streaming-Management/Operators/6. Troubleshooting#YouTube Shows Healthy but Won't Play|YouTube Shows Healthy but Won't Play]].

> [!question]- Why can't I change the YouTube channel, restream target or timezone?
> The restream mode and channel are locked while a broadcast is live, while the push is running, or
> while current broadcasts remain: "Delete or complete the *N* current broadcasts first (*dates*)
> to change the restream mode or channel." The timezone can only be changed by a system admin, and
> is locked while broadcast days from today on exist. See
> [[Event-Streaming-Management/Client-Administration/6. Event Configuration Reference#Field Locks|Field Locks]].

> [!question]- I replaced a broadcast. What happens to the old link?
> The old video stays on YouTube, and viewers with the old link won't see the new stream — share the
> new link. The old broadcast is listed as "Replaced", and a Client Admin can remove it with
> **Delete on YouTube**. A push that's already running stays on the old broadcast until you **Stop
> Push** and **Start Push** again. See
> [[Event-Streaming-Management/Operators/8. YouTube Broadcasts#Replacing a Broadcast|Replacing a Broadcast]].

> [!question]- My invite link expired.
> Invites last 7 days. An expired or already-used link shows "This invitation has expired or has
> already been used. Ask your administrator to send you a new invite." Ask a Client Admin to remove
> your pending membership and invite you again.

> [!question]- Video is coming in, so why can't I Start Push?
> The event is in a pre-event test: encoders can publish from the day before, but pushing to YouTube
> opens at the event's start time. See
> [[Event-Streaming-Management/Operators/6. Troubleshooting#The Event Shows Pre-Event Test and Start Push Is Refused|Troubleshooting]].

> [!question]- OBS dropped. Is YouTube still up?
> Yes, for a while. The push shows **Holding — standby slate on YouTube** and keeps YouTube's
> broadcast open with a black slate, with a "gives up in *m:ss*" countdown (10 minutes by default).
> Get OBS streaming again before the countdown ends and the push resumes by itself. If it gives up,
> **Start Push** again once OBS is back. See
> [[Event-Streaming-Management/Operators/3. Running a Live Event#Starting and Stopping the Push|Running a Live Event]].

> [!question]- My upload/stream/event isn't doing what I expect, and this page didn't cover it.
> Start with [[Event-Streaming-Management/Operators/6. Troubleshooting|Troubleshooting]] (or the
> System Administration [[Event-Streaming-Management/System-Administration/3. Monitoring and Troubleshooting|Monitoring and Troubleshooting]] page if you're a system admin), then contact *FIRST*
> Chesapeake technology support at
> [technology@firstchesapeake.org](mailto:technology@firstchesapeake.org).
