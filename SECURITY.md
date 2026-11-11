# Security policy

## Supported versions

Only the [latest release](https://github.com/NicolasAmorosi/himnova-live/releases/latest) gets
security fixes. Please check that the problem still happens there before reporting it.

## Reporting a vulnerability

**Don't open a public issue.** Report it privately through
[«Report a vulnerability»](https://github.com/NicolasAmorosi/himnova-live/security/advisories/new) on
the Security tab, or by email to nicolasamorosi@gmail.com.

Include the version, the operating system, the steps to reproduce it and, if a file triggers it
(a presentation, a video, a Bible module), that file or how to build one. You'll get an answer
within a week; once there is a fix, it ships in a release and the advisory is published with credit
to you, unless you'd rather stay anonymous.

Himnova Live runs offline and opens files the operator chooses, so the areas where a report matters
most are the ones that read those files (presentations, media, imported Bibles), the `worship://`
protocol that serves them to the windows, and the IPC bridge between the windows and the main
process.
