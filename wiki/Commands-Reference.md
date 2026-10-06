# Commands Reference

Two surfaces: the `/autopilot` slash command inside Claude Code, and messages in the paired Telegram chat. Plugin slash commands run locally, so every `/autopilot` subcommand also works headless (`claude -p '/autopilot status'`) and without a sign-in.

## `/autopilot` in Claude Code

`/autopilot` with no subcommand, or an unknown one, is `status`.

### `/autopilot setup`

The guided first-time flow. Reads the current state and performs or explains the next step: create the secrets file, fix its mode, add the bot token, verify the token and key, set your name, pair, enable. Safe to re-run at any time; it resumes where it stopped, and a finished setup reports itself. The steps are listed on [[Quick Start]].

### `/autopilot on` / `/autopilot off`

Switches autopilot for **every session on this machine**. Reply: `Autopilot on for every session on this machine.` (with ` Warning: TYPESAFE_API_KEY is not set, so nothing will be screened.` when there is no key) or `Autopilot off for every session on this machine.` Switching on while paired also sends `🟢 Autopilot on …` to the chat. Other open sessions pick up the change within a few seconds.

### `/autopilot name <name>`

Sets the `ownerName` option (up to 40 characters) and uses it from now on. Reply: `Owner name set to "Sam".` If saving to the plugin configuration fails, the name is still used for this session and the reply says to run `/plugin configure`. With no name it prints the current name and the usage, with a reminder never to put a token there.

### `/autopilot status`

Prints:

```
Autopilot: ON
Owner: Sam
Session role: solo (FM_TASK_ID unset, FM_TASK_INBOX unset, FM_SUPERVISION_ACTOR unset, cwd /home/sam/app)
Firstmate: not detected (bin/fm-captain-hold.sh is missing)
Jev key: set (file)
Telegram: token set (file), paired
Secrets file: /home/sam/.claude/jev-autopilot/secrets.env
Log: /home/sam/.claude/autopilot/decisions.jsonl
```

- `Session role` is `solo`, `captain`, `worker` or `supervisor` (see [[Firstmate Integration]]).
- `Firstmate` is `detected (genuine checkout, scripts tracked and unmodified)` or `not detected (<reason>)`.
- `Jev key` and `Telegram` say `set (file)`, `set (env)` or `missing (<NAME>)`; `Telegram` adds `paired` or `not paired (/autopilot pair)`.
- `Secrets file` adds `(ignored: mode 644; run chmod 600 on it)` when the file's permissions are too open.

### `/autopilot pair`

Checks the bot token with Telegram's `getMe` first. If that fails: `Could not confirm the bot token with Telegram, so no code was issued (…). Check TELEGRAM_BOT_TOKEN against @BotFather, and that this machine can reach api.telegram.org.` Otherwise: `Send this code to @yourbot in a private Telegram chat within 10 minutes: XXXXX-XXXXX` and `(3 wrong guesses burn it. Pairing again replaces the current chat.)`. Without a token: `Set TELEGRAM_BOT_TOKEN first (create a bot with @BotFather; put the token in ~/.claude/jev-autopilot/secrets.env).`

### `/autopilot unpair`

Forgets the paired chat and any pending code. Reply: `Unpaired. Run /autopilot pair to pair a chat again.`, or, when `TELEGRAM_CHAT_ID` is set, `Unpaired the stored chat; TELEGRAM_CHAT_ID (file) still names chat <id>.`

### `/autopilot test`

Sends `👋 jev-autopilot test from <project>. Reply within 3 minutes to check two-way delivery.` to the paired chat and keeps polling for three minutes even with autopilot off. Reply: `Test message sent to Telegram.` or `Test message not sent (<reason>).` Not paired: `Not paired yet: run /autopilot pair.`

### `/autopilot log`

The last 15 entries of the [[Decision Log]], one per line:

```
10-05T14:03 [jev] Bash: git push --force origin main → held
10-05T14:05 [human-telegram] Bash: git push --force origin main → Proceed
10-05T14:05 [human-telegram] Bash: git push --force origin main → let through after approval
10-05T14:20 [jev] ⚑ Q: Which database should the service use? → {"Which database should the service use?":"SQLite"}
10-05T14:41 [jev] turn ended → nudged to keep going (done 0.07, more possible 0.77)
10-05T15:02 [jev] firstmate task-123 → sent to Telegram (high-stakes)
```

`⚑` marks a low-confidence auto-answer. With no log yet: `No decisions logged yet.`

## Telegram chat commands

In the paired chat only. Messages from any other chat are ignored, except as a pairing attempt from a private chat while a code is pending.

| Message | Reply |
| --- | --- |
| `/status` | `<project> · autopilot on` / `off`, then `Working. Last tool: <summary>` or `Idle.`, then `N message(s) queued for Claude.` when any are waiting. |
| `/stop` | `🛑 Stopped the current turn. Send a message to give it new direction.` or `Nothing is running.` |
| Any other `/command` | `Commands: /status, /stop. Any other message goes straight to Claude; reply to a prompt to answer it.` |
| Tap a button | `Got it` (Telegram's callback toast); the buttons disappear. On a question or held call: `👀 Got it — Claude will see this at its next step.` On a Firstmate captain call: `✅ Recorded for firstmate: <answer>`. |
| Reply to a prompt | Same as a tap, with your text as the answer. On a captain call: `✅ Recorded for firstmate in your words.` |
| Reply to any other message, or plain text | `👀 Received — Claude will see this at its next step.` or `👀 Received — Claude is idle, starting a turn with it.`, then a delivery receipt, then Claude's final reply for that turn. |

Note that Claude Code tends to background long-running commands on its own, so a turn is rarely "running" for long; `/stop` mostly matters during a long model response.

## Environment variables the plugin reads

| Variable | Effect |
| --- | --- |
| `JEV_AUTOPILOT=1` | Autopilot on for this process, regardless of the stored switch. |
| `TELEGRAM_BOT_TOKEN`, `TYPESAFE_API_KEY`, `TELEGRAM_CHAT_ID` | Fallbacks when the secrets file does not set them. |
| `FM_TASK_ID`, `FM_TASK_INBOX`, `FM_SUPERVISION_ACTOR` | Set by Firstmate; decide the session role. |
| `HOME`, `USERPROFILE`, `OS` | Where the secrets file and log live, and whether this is Windows. |
