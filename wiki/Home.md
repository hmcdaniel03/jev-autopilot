# jev-autopilot

**jev-autopilot** is a [Claude Code](https://docs.claude.com/en/docs/claude-code) mod (a hooks-module plugin) that keeps unattended sessions moving. While autopilot is on:

- When Claude asks a question, [TypeSafe Jev](https://typesafe.ai) answers the routine ones and sends the high-stakes ones to your phone over Telegram, with Jev's suggestion attached. Claude parks only the work that depends on the answer and keeps going with the rest.
- Every tool call that is not read-only is screened by Jev. Calls it rates dangerous (destructive, or outward-facing) are held until you tap **Proceed** or **Block** on your phone.
- When a turn ends on an open question while other work could proceed, Jev notices and nudges Claude to keep going.
- You can steer the session from the paired Telegram chat: send directions, answer prompts in your own words, ask `/status`, or `/stop` the current turn.
- Every decision is appended to a local log you can read with `/autopilot log`.

This wiki documents version **0.1.0** (see [[Changelog]]). The repository's README is the short entry point; the pages here go into the detail.

## Who it is for

People who run Claude Code sessions they are not watching: overnight runs, long autonomous loops, or a fleet of workers supervised by [Firstmate](https://github.com/kunchenguid/firstmate). If you sit at the terminal and answer every prompt yourself, you do not need this plugin.

## Independence

jev-autopilot is an independent project. It is not affiliated with or endorsed by TypeSafe AI, or by Firstmate and its author, Kun Chen. "Jev", "TypeSafe" and "Firstmate" belong to their owners and are used here only to say what this plugin works with.

## Read this before turning it on

> **This mod acts without you.** With autopilot on, an automated model answers questions on your behalf and lets tool calls through that it rates safe, and whoever holds the paired Telegram chat can steer the session, approve held calls and stop turns. Run it only on machines and projects where you accept that, read [[Safety Model and Permission Layering]] first, and keep Claude Code's own permission mode as a second line of defence rather than running with permissions bypassed.

## Pages

| Page | What it covers |
| --- | --- |
| [[Quick Start]] | Install, `/autopilot setup`, first pairing, switching on |
| [[How Autopilot Works]] | The switch, the standing prompt, and the decision flows for questions, tool calls and keep-going nudges, with diagrams |
| [[Telegram Bot Setup and Pairing]] | Creating the bot, pairing, the listener, and what you can send from the phone |
| [[Secrets and Configuration]] | The secrets file on each OS, environment fallbacks, and every option with its default |
| [[Commands Reference]] | Every `/autopilot` subcommand and every Telegram chat command, with their replies |
| [[Jev and TypeSafe]] | What Jev is, exactly what is asked of it, what it costs, and what happens when it is unreachable |
| [[Safety Model and Permission Layering]] | The layers between Claude and a dangerous action, how approvals are scoped, and the threat model |
| [[Privacy]] | Exactly what leaves the machine, to whom, and what never does |
| [[Firstmate Integration]] | Detection rules, session roles, captain calls, landed notices and internal coordination |
| [[Status Line and Notifications]] | The badge under the prompt, toasts, in-context notices and every Telegram message |
| [[Decision Log]] | Where the log is, every record shape, and how `/autopilot log` renders it |
| [[Troubleshooting and FAQ]] | Problems seen in real installs and live runs, and what they mean |
| [[Development and Contributing]] | Repository layout, tests, CI, the public export and publishing this wiki |
| [[Changelog]] | Where releases and unreleased changes are recorded |

## License

MIT. Security reports: see `SECURITY.md` in the repository, summarised under [[Safety Model and Permission Layering]].
