# Changelog

Releases and unreleased changes are recorded in [`CHANGELOG.md`](https://github.com/hmcdaniel03/jev-autopilot/blob/main/CHANGELOG.md) in the repository, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form with [semantic versioning](https://semver.org/). Tagged releases are on the [releases page](https://github.com/hmcdaniel03/jev-autopilot/releases).

This wiki is maintained alongside the code and describes the state of `main`. Where a behaviour is newer than the latest release, the page says so.

## Summary

- **Unreleased** (after 0.1.0): `/autopilot setup`, the guided first-time flow; `/autopilot name`; the decisions log says `let through after approval` instead of claiming the call ran; a turn that ended on an API error is not nudged; toasts are no longer double-prefixed; CI type-checks without a secret; README Quick start and Windows paths.
- **0.1.0** (2026-10-05): first public release. The machine-wide switch, Jev answers and screening, Telegram escalation with Proceed/Block, keep-going nudges, remote control from the chat, the secrets file, redaction, pairing with a random code, scoped approvals, `tempRoots`, the optional Firstmate integration, and the decisions log.

Only the latest release is supported; Claude Code's mods API can change between releases, so keep Claude Code current too.
