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
- **Client Admin / Client User / Client Readonly** — the three roles a Client Member can have.
  Admin can configure and manage; User can operate day-to-day controls; Readonly can view but not
  act. See [[Event-Streaming-Management/Client-Administration/1. Members and Roles|Members and Roles]].
- **Stream key** — the credential your encoder (OBS, directly or through the plugin) uses to send
  video into the platform for a given event. Only a system admin can create, change, or delete a
  stream key; a Client Admin can view and reveal one but not generate a new one. See
  [[Event-Streaming-Management/Client-Administration/2. Stream Keys and Restream Keys|Stream Keys and Restream Keys]].
- **Restream key** — a separate credential (your destination's own RTMP key, e.g. YouTube's) used
  for the manual-restream-target path, distinct from the stream key used for ingest. Unlike stream
  keys, a Client Admin can create and delete these themselves. See
  [[Event-Streaming-Management/Client-Administration/2. Stream Keys and Restream Keys|Stream Keys and Restream Keys]].
- **Push vs. broadcast** — "pushing" is sending your already-ingested stream onward toward YouTube
  (the **Start Push** / **Stop Push** controls); "broadcast" is the YouTube Live broadcast itself
  that viewers watch, controlled separately with **Go Live** / **Stop Broadcast** once the push is
  active. See [[Event-Streaming-Management/Operators/3. Running a Live Event|Running a Live Event]].
- **Discovered vs. configured** — a **discovered** event is one the platform found automatically
  from the *FIRST* Events APIs but nobody has set up yet (no stream key, no other settings). It
  becomes **configured** once a Client Admin fills in its stream key and other settings. See
  [[Event-Streaming-Management/Operators/2. Managing Events|Managing Events]].
- **Operation mode** — a system-wide setting (`record_only`, `lite_mode`, or `full_power`) that
  gates how much of the pipeline runs platform-wide. See
  [[Event-Streaming-Management/System-Administration/4. System Settings Reference|System Settings Reference]].
- **Test event** — a synthetic event with fake matches that a system admin can create to rehearse
  the full pipeline (a real stream still has to be sent in) without touching real event data. Only
  system admins can create or configure test events. See
  [[Event-Streaming-Management/System-Administration/7. System Admins and Test Mode|System Admins and Test Mode]].
- **OBS Test Clock** — an unauthenticated browser-source URL a system admin can hand to any
  operator to sanity-check their OBS video/audio pipeline before a stream, without needing a test
  event. See
  [[Event-Streaming-Management/System-Administration/7. System Admins and Test Mode|System Admins and Test Mode]].
- **Signage** — physical or web-based displays (pit, queueing, audience, wait-time, or a custom
  URL) that the platform can drive on a per-event basis. See
  [[Event-Streaming-Management/Operators/5. Clips, Uploads and Signage#Signage|Clips, Uploads and Signage]].

# Frequently Asked Questions

> [!question]- Do I need the OBS plugin, or can I set OBS up myself?
> Either works. The plugin fills in your stream server/key and recommended encoder settings for
> you; without it, you copy the same values manually from the Stream Keys page. See
> [[Event-Streaming-Management/Operators/4. OBS Plugin Guide|OBS Plugin Guide]].

> [!question]- Why can't I click a control that a teammate can click?
> It's almost always your role. Readonly members can view everything in this section but can't
> click any control; several admin-only pages and buttons additionally require the Client Admin
> role specifically. See
> [[Event-Streaming-Management/Client-Administration/1. Members and Roles|Members and Roles]].

> [!question]- My upload/stream/event isn't doing what I expect, and this page didn't cover it.
> Start with [[Event-Streaming-Management/Operators/6. Troubleshooting|Troubleshooting]] (or the
> System Administration [[Event-Streaming-Management/System-Administration/6. Monitoring and Troubleshooting|Monitoring and Troubleshooting]] page if you're a system admin), then contact *FIRST*
> Chesapeake technology support at
> [technology@firstchesapeake.org](mailto:technology@firstchesapeake.org).
