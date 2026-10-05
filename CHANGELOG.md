# Changelog

All notable changes to jev-autopilot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

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
