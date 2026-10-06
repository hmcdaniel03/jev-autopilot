# jev-autopilot

A Claude Code mod that keeps unattended sessions moving. When Claude asks a question,
[TypeSafe Jev](https://typesafe.ai) answers the routine ones and sends the rest to
your phone over Telegram. Every tool call that is not read-only is screened by Jev;
the dangerous ones are held until you tap **Proceed** or **Block**. A session that
stops on an open question while other work could proceed is nudged to keep going.
Every decision is logged.

jev-autopilot is an independent project. It is not affiliated with or endorsed by
TypeSafe AI or by Firstmate and its author, Kun Chen; "Jev", "TypeSafe" and
"Firstmate" belong to their owners and are used here only to say what this plugin
works with.

> **Warning: this mod acts without you.**
> With autopilot on, an automated model answers questions on your behalf and lets
> tool calls through that it rates safe, and whoever holds the paired Telegram chat
> can steer the session, approve held calls and stop turns. Run it only on machines
> and projects where you accept that, read the [threat model](#threat-model) before
> turning it on, and keep Claude Code's own permission mode as a second line of
> defence rather than running with permissions bypassed.

The full documentation is in the [wiki](https://github.com/hmcdaniel03/jev-autopilot/wiki):
how decisions are made, every command and option, the safety model, what leaves
the machine, the Firstmate integration and a troubleshooting FAQ. This README is
the short version.

## Quick start

```sh
claude plugin marketplace add hmcdaniel03/jev-autopilot
claude plugin install jev-autopilot@jev-autopilot
```

Then, inside Claude Code, run **`/autopilot setup`**. It walks you through
everything, one step at a time:

- checks the prerequisites and creates the secrets file, readable by you only;
- tells you exactly where to put the Telegram bot token and the TypeSafe key (in
  that file, never in the chat: an editor line, or a one-line terminal command that
  reads the value hidden), then checks them with Telegram and TypeSafe;
- asks your name, pairs your phone with a one-time code;
- explains how autopilot works and offers to switch it on.

Run it again after each step you do by hand; it resumes where it left off, and a
finished setup just reports itself. **`/autopilot help`** shows how autopilot works
and every command at any time. While autopilot is on, the line under the prompt
shows `jev-autopilot: autopilot ●`.

## Requirements

- Claude Code **2.1.289** or newer (the version this release was tested with). Mods
  use the Claude Code hooks module API, which can change between releases.
- A Telegram bot from [@BotFather](https://t.me/BotFather). One bot per machine: only
  one process can poll a bot's updates.
- A TypeSafe API key for Jev. TypeSafe is in **early access** with a waitlist
  (`console.typesafe.ai`); usage is pay-as-you-go and a heavy day costs cents.
  Without a key the plugin still relays Telegram, but nothing is answered or screened
  (see [When Jev is unreachable](#when-jev-is-unreachable)).

## Commands

In Claude Code:

| Command | What it does |
| --- | --- |
| `/autopilot setup` | Guided first-time setup; safe to re-run, resumes where it stopped |
| `/autopilot help` | How autopilot works, and these commands |
| `/autopilot on` / `off` | Switch autopilot for every session on this machine (`JEV_AUTOPILOT=1` in the environment also turns it on) |
| `/autopilot name <name>` | Set `ownerName`, how prompts and Telegram text refer to you |
| `/autopilot status` | Role, secrets, pairing, Firstmate detection, log path |
| `/autopilot pair` / `unpair` | Pair a private Telegram chat, or forget it |
| `/autopilot test` | Send a test message and listen for a reply for 3 minutes |
| `/autopilot log` | The last 15 decisions |

On Telegram, in the paired chat:

| Message | What it does |
| --- | --- |
| `/status` | Whether the session is working and what it last did |
| `/stop` | Abort the current turn |
| Tap a button | Answer a question or approve/block a held call |
| Reply to a prompt | Answer it in your own words |
| Any other text | Delivered to Claude as direction; its final reply comes back to you |

## Options

Set with `/plugin configure jev-autopilot@jev-autopilot` in Claude Code, or pipe a JSON
object to `claude plugin configure jev-autopilot@jev-autopilot --values-stdin`
(`claude plugin configure jev-autopilot@jev-autopilot` alone lists what is set).
`ownerName` can also be set with `/autopilot name <name>`.

| Option | Default | Meaning |
| --- | --- | --- |
| `ownerName` | `the owner` | How prompts and Telegram text refer to you |
| `minConfidence` | `0.7` | Below this Jev confidence an auto-answer is flagged for review |
| `stakesThreshold` | `0.5` | Jev's high-stakes score at or above which a question goes to your phone |
| `holdThreshold` | `0.65` | Jev's probability a tool call is dangerous at or above which it is held |
| `telegramWaitMinutes` | `30` | How long a **Proceed** tap stays valid for that exact call in the session that held it |
| `tempRoots` | `/tmp/`, `/private/tmp/`, `/var/folders/` | Scratch directories; deleting inside them is cleanup, not destruction. A root starting with `~/` also matches `$HOME` |
| `firstmateRemotes` | none | Extra remote URLs or absolute paths that count as a genuine Firstmate checkout |

## How decisions are made

- **Questions** (`AskUserQuestion`): Jev sees the last ten conversation messages and
  the options. If it rates the decision high-stakes, or a free-text answer is needed,
  the question goes to your phone with Jev's suggestion and Claude is told to park
  only that piece of work. Otherwise Jev's answer is returned; a low-confidence
  answer is flagged and Claude is told to implement it reversibly.
- **Tool calls**: read-only tools are never screened. For everything else Jev is
  asked whether the action is destructive or outward-facing (reaches other people,
  publishes, spends money). At or above `holdThreshold` the call is denied and sent
  to your phone; **Proceed** lets exactly that call past autopilot once, in that
  session and project, within `telegramWaitMinutes`. Claude Code's own permission
  mode still applies after that: in auto mode, for example, a force push you approved
  can still be denied, and Claude will tell you so. **Block** tells Claude not to run
  the call or work around it. Cleanup inside `tempRoots` is never held.
- **Keep going**: when a turn ends, Jev checks whether work remains that does not
  depend on an open question, and nudges Claude at most three times.
- **Log**: every decision is appended to `~/.claude/autopilot/decisions.jsonl`.

## When Jev is unreachable

Jev is an added safety layer, not the only one. If the TypeSafe key is missing or
the API is down:

- Questions are asked in the terminal as usual (and the plugin says so in a toast).
- Tool calls pass through to **Claude Code's own permission mode**, which still
  applies exactly as it would without the plugin: in default or auto mode Claude
  Code keeps asking or classifying as it normally does. Only if you run with
  permissions bypassed does nothing screen those calls, which is why the warning
  above asks you not to.
- With Firstmate, workers also stay under Firstmate's own supervision.

The plugin keeps its current behaviour deliberately: there is no rules-based
fallback that pretends to screen. `/autopilot on` warns when no key is set.

## Privacy: what leaves your machine

To **Telegram** (Telegram's servers and your phone), only while autopilot is on, a
pairing code is pending, or for three minutes after `/autopilot test`:

- `/autopilot setup` and `/autopilot pair` call `getMe` to check the bot token.
- Questions Claude asks, their options and Jev's suggestion.
- Held tool calls: the tool and up to 900 characters of the command or path.
- Firstmate captain calls: title, reason and up to 1,200 characters of detail, and
  notices when tasks land.
- The session's final reply for every turn you started from Telegram (up to four
  messages of 4,096 characters), `/status` answers and short receipts.

To **TypeSafe** (Jev), only while autopilot is on (and, from `/autopilot setup`, one
`GET /v1/models` call that checks the key and is not billed):

- For each question: the question, its options, your project folder name and path,
  and the last ten conversation messages (up to 6,000 characters).
- For each screened tool call: the tool, the command or file path (heredoc bodies
  stripped), your working directory and up to 600 characters of your last prompt.
- For each keep-going check: up to 1,500 characters of your last prompt and 3,000
  of Claude's final message.
- For each Firstmate captain call: its title, reason and up to 3,000 characters of
  detail.

Secrets this process holds and anything that looks like a token, key or password
are redacted from all of the above and from the log before they are written or
sent. Nothing else is collected; there is no telemetry. See TypeSafe's terms for how
they handle request data.

## Firstmate integration

[Firstmate](https://github.com/kunchenguid/firstmate) is an open-source engineering
lead that runs a fleet of Claude Code workers. This plugin works with it but is not
part of it, and is not affiliated with or endorsed by its author. In a Firstmate
checkout the plugin turns Firstmate's captain calls into Jev decisions or Telegram
prompts, answers them through Firstmate's own intake, reports landed tasks, and
treats Firstmate's worker steering and its pipeline's scratch directories as
internal. Workers launched by Firstmate (identified by `FM_TASK_ID`) are screened
but never talk to Telegram; they route decisions to Firstmate instead.

Detection is automatic but strict, because the plugin executes
`bin/fm-fleet-snapshot.sh` and `bin/fm-captain-hold.sh` from the detected folder on
a timer. A working directory is a Firstmate home only if all of these hold:

1. it contains `bin/fm-captain-hold.sh` and `AGENTS.md`;
2. it is the top level of a git repository;
3. its `origin` or `upstream` remote is `github.com/kunchenguid/firstmate` (https,
   ssh and `.git` spellings all count), or the remote or the folder is listed in
   `firstmateRemotes`;
4. the scripts it would run are tracked by git and have no uncommitted changes
   against the checked-out `HEAD`. How old that `HEAD` is does not matter: a
   checkout that has not pulled in months is still a Firstmate home. The check is
   repeated right before each run.

Outside such a folder there is no Firstmate behaviour at all. `/autopilot status`
says why a folder was not detected.

## Threat model

- **The paired chat is root.** Anyone who holds it can direct the session, approve
  held calls and stop turns, which is the point. Pair from a private chat you
  control, on a bot only this machine uses. Pairing itself is guarded by a
  10-character random code that expires in 10 minutes and burns after three wrong
  guesses; groups cannot pair; `/autopilot unpair` revokes.
- **Approvals are narrow.** A **Proceed** tap unlocks one exact call (same input) in
  the session and project that held it, for `telegramWaitMinutes`, once.
- **Secrets.** The bot token and API key are read from a mode-0600 file rather
  than the environment so a shell command cannot print them by accident, and they
  are redacted from everything the plugin writes. A model with shell access can
  still read any file you can, so the standing prompt also tells Claude never to
  read the plugin's credentials or store; treat that as a convention, not a wall.
  Rotate the bot token if you suspect exposure.
- **Code execution from the workspace.** The Firstmate integration is the only path
  that runs anything from the working directory, and it requires a genuine Firstmate
  checkout as described above, so a cloned repository that merely contains the same
  file names runs nothing.
- **Prompt injection.** Jev sees the command text; a model steered by hostile tool
  output could word a command to look routine. Keep Claude Code's permission mode
  on, keep `holdThreshold` conservative, and review the decisions log.
- **Jev down.** See [When Jev is unreachable](#when-jev-is-unreachable).

## Advanced and troubleshooting

- **Install from a clone** instead of the marketplace: list the folder in
  `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`
  (`%USERPROFILE%\.claude\settings.json` on Windows), separating paths with `:` on
  macOS/Linux and `;` on Windows, or start Claude Code with `--plugin-dir <folder>`.
  Loaded that way its id is `jev-autopilot@inline`: use that in place of
  `jev-autopilot@jev-autopilot` in the `configure` commands above.

  ```json
  "CLAUDE_CODE_PLUGIN_DIRS": "/home/sam/jev-autopilot:/home/sam/other-mod"
  "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\sam\\jev-autopilot;C:\\Users\\sam\\other-mod"
  ```

- **The secrets file** is `~/.claude/jev-autopilot/secrets.env` on macOS/Linux and
  `%USERPROFILE%\.claude\jev-autopilot\secrets.env` on Windows, under your home
  folder even if you set `CLAUDE_CONFIG_DIR`. One `KEY=VALUE` per line:
  `TELEGRAM_BOT_TOKEN`, `TYPESAFE_API_KEY`, and optionally `TELEGRAM_CHAT_ID` to pin
  the paired chat. It must be readable by you only (mode 600; restricted with
  `icacls` on Windows), or it is ignored with a warning. The same names in the
  process environment are the fallback, but every shell command Claude runs inherits
  that environment, so the file is safer.
- **Something looks wrong?** Run `/autopilot setup` again: it re-checks every step
  and says what to fix. `/autopilot status` shows what this session sees, including
  why a folder was not detected as Firstmate.

## Development

Contributions go through no-mistakes; see [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow, the checks it runs and a map of the code.

The wiki's sources are in `wiki/`; edit them with the code and publish with
`scripts/publish-wiki.sh` (see the wiki's
[Development and Contributing](https://github.com/hmcdaniel03/jev-autopilot/wiki/Development-and-Contributing) page).

## License

MIT, see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
