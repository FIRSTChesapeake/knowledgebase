---
title: Event Streaming — System Administration
---
# Contents
[[#Guides in This Section]]

This guide is for system administrators — the people with cross-Client, platform-wide access. If
you're looking for day-to-day use of the platform instead, see
[[Event-Streaming-Management/Operators/index|Operators]] or
[[Event-Streaming-Management/Client-Administration/index|Client Administration]].

> [!warning] This Section Covers System Administration
> The pages in this section are for people with the system-admin role. Nothing here is needed to
> run an event day-to-day.

# Guides in This Section

1. [[Event-Streaming-Management/System-Administration/1. Architecture Overview|Architecture Overview]] — the services, the job queue pipeline, how the YouTube restream reads the stream and finds its destination, live preview, the event status lifecycle, and operation modes.
2. [[Event-Streaming-Management/System-Administration/2. System Settings Reference|System Settings Reference]] — every tab of the system admin Settings page.
3. [[Event-Streaming-Management/System-Administration/3. Monitoring and Troubleshooting|Monitoring and Troubleshooting]] — status, logs, jobs, and reading health-check banners.
4. [[Event-Streaming-Management/System-Administration/4. System Admins and Test Mode|System Admins and Test Mode]] — cross-client access, actions only system admins can take, and rehearsing the pipeline safely.

Deployment, secrets and network-security details are documented in the kube-match-splitter
repository's `DEPLOYMENT.md`, for people with repository access.
