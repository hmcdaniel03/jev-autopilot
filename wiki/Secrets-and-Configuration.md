# Secrets and Configuration

Two kinds of settings: **secrets** (the bot token, the TypeSafe key, an optional chat id) in a file only you can read, and **options** (your name and the thresholds) in Claude Code's plugin configuration.

## The secrets file

| OS | Path |
| --- | --- |
| macOS / Linux | `~/.claude/jev-autopilot/secrets.env` |
| Windows | `%USERPROFILE%\.claude\jev-autopilot\secrets.env` |

The path is under your home folder (`HOME`, or `USERPROFILE` when that is set) even if you set `CLAUDE_CONFIG_DIR`. `/autopilot setup` creates it from a commented template, private to you from the first byte (`umask 077` on POSIX; on Windows the engine writes it and `icacls` strips inherited permissions and grants your user alone). An existing file is never overwritten.

### Format

One `KEY=VALUE` per line. A leading `export`, surrounding single or double quotes, blank lines and `#` comments are allowed; an unquoted value ends at ` #`.

```sh
# jev-autopilot secrets. Keep this file readable by you only (mode 600).
TELEGRAM_BOT_TOKEN=123456789:AAF...
TYPESAFE_API_KEY=...
# TELEGRAM_CHAT_ID=...   optional: pin the paired chat
```

| Name | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes, for anything to reach your phone | The token @BotFather gave you (`<bot id>:<35 characters>`). |
| `TYPESAFE_API_KEY` | No, but without it nothing is answered or screened | Your TypeSafe key from `console.typesafe.ai`. Leave it out until you have one; `/autopilot on` warns when it is missing. |
| `TELEGRAM_CHAT_ID` | No | Pins the chat the plugin talks to, overriding the paired one. |

### Permissions

On macOS and Linux the plugin reads the file's mode with `stat`. A file readable by the group or the world (anything other than `600`/`0600`-style modes) is **ignored**: its values are treated as missing, a toast says `ignoring ~/.claude/jev-autopilot/secrets.env (mode 644); run chmod 600 on it`, and `/autopilot status` shows `Secrets file: … (ignored: mode 644; run chmod 600 on it)`. The file is cached by modification time, but an ignored file is re-checked on every read, so `chmod 600` takes effect without a restart. Permissions are not checked on Windows; the `icacls` command from setup restricts the file to you.

### Environment fallback

The file is read first. The same names in the process environment are the fallback, and `JEV_AUTOPILOT=1` in the environment switches autopilot on for that process. The file is preferred because every shell command Claude runs inherits the process environment: a key in the `env` block of your settings is one `env` away from the transcript. `/autopilot status` says which source each secret came from (`set (file)` or `set (env)`).

### Never type a secret into the chat

A token pasted into the Claude Code chat or a slash command lands in the transcript. `/autopilot setup` and this wiki only ever give you an editor line or a terminal command that reads the value hidden. `/autopilot name` is the one setting that is safe to type, because a name is not a secret.

## Options

Set them with `/plugin configure jev-autopilot@jev-autopilot` inside Claude Code, or from a shell by piping a JSON object:

```sh
echo '{"ownerName":"Sam","holdThreshold":0.5}' | claude plugin configure jev-autopilot@jev-autopilot --values-stdin
claude plugin configure jev-autopilot@jev-autopilot      # lists what is set
```

(`jev-autopilot@inline` when the plugin was loaded from a folder.) `ownerName` can also be set with `/autopilot name <name>`. Options are read when the mod loads; the shell command's `Restart Claude Code to apply it` applies.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `ownerName` | string | `the owner` | How the standing prompt, the notes Claude sees and the Telegram text refer to you. Up to 40 characters when set with `/autopilot name`. |
| `minConfidence` | number | `0.7` | Below this Jev confidence an auto-answered question is flagged: Claude is told to implement the choice reversibly and note the assumption. For a Firstmate captain call, Jev's probability that approving is right must reach this, or the call goes to your phone. |
| `stakesThreshold` | number | `0.5` | Jev's high-stakes score at or above which a question (or a Firstmate captain call) goes to your phone instead of being answered. |
| `holdThreshold` | number | `0.65` | Jev's probability that a tool call is destructive or outward-facing at or above which the call is held for your approval. |
| `telegramWaitMinutes` | number | `30` | How long a **Proceed** tap stays valid for that exact call, in the session and project that held it. |
| `tempRoots` | list of strings | `/tmp/`, `/private/tmp/`, `/var/folders/` | Scratch directories: a shell command that only deletes inside them is cleanup, not destruction, and is never held. A root starting with `~/` also matches `$HOME/` and any absolute home directory. Given as a JSON array, or one string split on commas or newlines. Setting it **replaces** the default list. |
| `firstmateRemotes` | list of strings | none | Besides `github.com/kunchenguid/firstmate`: a fork's remote URL, or the absolute path of a checkout, that counts as a genuine Firstmate home. See [[Firstmate Integration]]. |

### How `tempRoots` is applied

A command is "only cleanup" when every top-level segment (split on `;`, `&`, `|` and newlines) is one of: an `rm` (also `/bin/rm`, `command rm`, `sudo rm`) whose every target is temporary; a `cd`; `true`, `:` or an `echo`; or a `NAME=$(mktemp …)` assignment. A target is temporary when it is `$NAME` or `$NAME/…` for a `NAME` assigned from `mktemp` in the same command, `$TMPDIR/<something>` (not `$TMPDIR` alone or a bare wildcard), or a path under a configured root with something below the root. `/tmp/`, `/tmp/*` and any path containing `..` are never temporary. When Firstmate is detected, `~/.no-mistakes/worktrees/` and `~/.no-mistakes/evidence/` are added to the roots.

When a command mixes cleanup with other work, the cleanup is still rewritten to `rm -rf <temporary scratch dir>` in what Jev sees, so it is judged for the rest of the command.

## Where things live

| Path | What | Written by |
| --- | --- | --- |
| `~/.claude/jev-autopilot/secrets.env` | Secrets | You (`/autopilot setup` creates the empty template) |
| `~/.claude/autopilot/decisions.jsonl` | The [[Decision Log]] | The plugin, append-only, redacted |
| Claude Code's plugin store for `jev-autopilot` | The switch, pairing, listener lease, pending prompts, approvals, inboxes, Firstmate bookkeeping | The plugin |
| Claude Code's plugin configuration | The options above | `/plugin configure`, `claude plugin configure`, `/autopilot name` |

`/autopilot status` prints the secrets file and log paths it is using.
