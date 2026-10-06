# Changelog

All notable changes to jev-autopilot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- `/autopilot setup`: a guided first-time flow. It checks the Claude Code version,
  creates `~/.claude/jev-autopilot/secrets.env` readable by you only from a
  commented template, says exactly where to put each secret (an editor line, or a
  one-line terminal command per OS that reads the value hidden; never the chat),
  checks the bot token with Telegram's `getMe` and the TypeSafe key with the
  non-billed `GET /v1/models`, asks your name and saves it as `ownerName`, issues
  the pairing code, and offers to switch autopilot on. Re-running it resumes where
  it stopped. Paths and commands are spelled for macOS/Linux and for Windows.
- `/autopilot name <name>` sets `ownerName` without leaving Claude Code.
- `/autopilot help`: how autopilot works (what on and off do, phone approvals,
  steering from Telegram, keep-going nudges, Claude Code's permission mode
  underneath, the daily routine) and every command. `/autopilot setup` shows the
  same explainer before it offers to switch autopilot on, and the first
  `/autopilot on` on a machine points to it.
- README: a Quick start (two install commands, `/autopilot setup` and
  `/autopilot help`) is the way in; the manual install and setup steps are gone,
  leaving a short Advanced and troubleshooting section (clone install, where the
  secrets file lives, re-running setup).
- CONTRIBUTING.md: pull requests are raised through
  [no-mistakes](https://github.com/kunchenguid/no-mistakes), whose pipeline runs the
  same checks as CI (`.no-mistakes.yaml`). A required check, **PR must be raised via
  no-mistakes**, rejects a PR whose body lacks a completed no-mistakes attestation for
  its current head; it is derived from kunchenguid/firstmate (MIT). The README's
  Development notes moved there.

### Fixed

- Notices no longer read `jev-autopilot: autopilot: …`; Claude Code already names
  the plugin.
- CI type-checks every push without an `ANTHROPIC_API_KEY` secret.
- The decisions log says an approved call was `let through after approval`, not that
  it ran: Claude Code's own permission mode can still deny it. The README says so.
- A turn that ended on an API error (sign-in revoked, outage) is no longer nudged to
  keep going; the nudge could only fail the same way.

## [0.1.0] - 2026-10-05

First public release.

### Added

- `/autopilot on|off`, a machine-wide switch for every session: TypeSafe Jev answers Claude's `AskUserQuestion` prompts and
  screens every non-read-only tool call; high-stakes questions and dangerous calls go
  to your phone over Telegram, and a keep-going nudge stops sessions parking on a
  question when other work could proceed.
- Telegram remote control: `/status`, `/stop`, replies that steer the session, and a
  reply with the session's final answer for every turn you start from the phone.
- `ownerName` option: how prompts and Telegram text name you (default "the owner").
- Secrets from `~/.claude/jev-autopilot/secrets.env` (mode 0600), with the process
  environment as the fallback.
- Secret redaction in everything the plugin logs, throws or sends.
- Pairing with a crypto-random 10-character code that expires after 10 minutes and
  burns after 3 wrong guesses; private chats only; `/autopilot unpair`. The bot token
  is checked with Telegram before a code is issued, and `/autopilot test` reports a
  failed send.
- `/autopilot status` says when the secrets file is ignored for its permissions; a
  later `chmod 600` takes effect without a restart.
- Phone approvals of held calls are scoped to the session, project and exact input
  that was held, and expire after `telegramWaitMinutes`.
- `tempRoots` option: scratch directories whose cleanup is never treated as destructive.
- Optional Firstmate integration, auto-detected only in a genuine Firstmate checkout
  (origin or upstream at `github.com/kunchenguid/firstmate`, or `firstmateRemotes`)
  whose scripts are git-tracked and unmodified.
- Every decision appended to `~/.claude/autopilot/decisions.jsonl` (`/autopilot log`).

[0.1.0]: https://github.com/hmcdaniel03/jev-autopilot/releases/tag/v0.1.0
