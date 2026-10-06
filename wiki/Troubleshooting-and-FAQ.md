# Troubleshooting and FAQ

Problems seen while installing the plugin as a new user and while running it live against Telegram and Jev, generalised, plus the questions they raised. Start with `/autopilot status`: it reports the switch, the role, Firstmate detection, where each secret came from, pairing, and the file paths.

## Install and configuration

**`claude plugin configure jev-autopilot` says `No installed plugin has the id "jev-autopilot"`.**
Use the full id: `jev-autopilot@jev-autopilot` for a marketplace install, `jev-autopilot@inline` for a `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` install (`claude plugin list` shows it). The bare command only lists what is set; to set values from a shell, pipe JSON to `--values-stdin`, or use `/plugin configure …` inside Claude Code.

**I turned autopilot on in one project and another project shows it on too.**
That is how it works: the switch is machine-wide, for every session and every project, until `/autopilot off`. The plugin store is one file per plugin, not per project. Do not leave it on if some session on the machine should stay interactive.

**`/autopilot status` shows `Telegram: missing (TELEGRAM_BOT_TOKEN)` although the file has it.**
Check the `Secrets file:` line. If it ends in `(ignored: mode 644; run chmod 600 on it)`, the file is readable by others and the plugin ignores it entirely. Run `chmod 600` on it; it takes effect on the next read without a restart. Also check the line is `KEY=VALUE` with no spaces around a stray character, and that you did not put the token in the wrong home: the path is under `HOME` (`USERPROFILE` on Windows) even when `CLAUDE_CONFIG_DIR` is set.

**I set the key in the `env` block of settings and it works, but is it safe?**
It works as a fallback, but every shell command Claude runs inherits that environment, so one `env` is enough to put the key in the transcript. Prefer the file.

**`/autopilot setup` printed the name hint instead of asking me.**
It asks with Claude Code's own dialog, which a headless `claude -p` run cannot show. Run `/autopilot name <name>` instead.

**`/autopilot setup` says the TypeSafe key is `present (not verified: …)`.**
The key check reached neither a success nor a 401/403 (network, proxy, a 5xx). The key may still be fine; the status text says what happened. Re-run later or carry on; `/autopilot on` works without a verified key.

## Telegram

**`/autopilot pair` issued no code.**
It checks the token with Telegram first and says why it failed: a mistyped or revoked token (check it against @BotFather, or `/revoke` there for a fresh one), or this machine cannot reach `api.telegram.org` (a proxy or firewall). Older versions issued a code anyway and then failed silently in the background poll.

**`/autopilot test` says `Test message not sent (…)`.**
The reason is in the parentheses: a bad token, no network, or a wrong chat id (`TELEGRAM_CHAT_ID` pinned to a chat the bot cannot message). Pair again or fix the pin.

**The pairing code expired or burned.**
Codes last 10 minutes and three wrong guesses. Run `/autopilot pair` again. Case and punctuation do not matter, but the alphabet has no `0`, `O`, `1` or `I`, so a confusable character is simply wrong.

**My bot does not answer from a group.**
Groups cannot pair, and only the paired chat is listened to. Pair from a private chat.

**Two machines share one bot and messages go missing.**
Telegram allows one `getUpdates` poller per bot; two pollers steal each other's updates. Create one bot per machine.

**I sent `/status` or `/stop` and nothing visible happened.**
Both are answered in the chat as replies to your message. `/stop` answers `Nothing is running.` when the session is idle, which is most of the time: Claude Code backgrounds long commands by itself, so turns rarely stay "running" long. It cannot stop a backgrounded command.

**My message was received but Claude only saw it later.**
Mid-turn messages are attached to the next main-loop tool result; if the turn goes a minute without one, or when Claude is idle, the message is submitted as a prompt instead (at most once every 10 seconds). The receipts (`Received`, `Queued`, `Delivered`, `Claude has read this`) say where it is.

**Nothing arrives on Telegram at all.**
The bot is only polled, and only sends, while autopilot is on, a pairing code is pending, or for three minutes after `/autopilot test`. In a Firstmate worker session nothing ever goes to Telegram by design.

## Jev and screening

**I approved a call on my phone and Claude still could not run it.**
A **Proceed** takes the call past autopilot only. Claude Code's own permission mode still applies, and in auto mode its classifier can deny a destructive git command after your approval (and sometimes before the hold ever reaches your phone). The log says `let through after approval`, not that it ran, and Claude tells you in its summary. If you want the call to run, run it yourself or switch Claude Code to a mode that allows it.

**A call I had approved earlier ran again without a prompt.**
An approval is good for one identical call (same session, project, tool and input) within `telegramWaitMinutes`. If the first retry had not consumed it, a later identical command inside the window runs on it. Lower `telegramWaitMinutes` if that is too generous.

**Jev rated a harmless `git status` as `destructive` at 0.61.**
Live Jev can score read-like shell commands close to the threshold. Anything below `holdThreshold` (0.65) is allowed, so nothing was held, but watch the `allowed` entries in the log; if your work keeps landing near the line, raise `holdThreshold` a little, or lower it if you want more holds.

**A toast says `Jev unreachable, tool calls are not being screened right now`.**
The key is missing or rejected, or the API is down. Calls go on to Claude Code's permission mode, which still applies as without the plugin; there is no fake screening. Fix the key (`/autopilot setup` verifies it) or wait. The toast repeats at most once a minute.

**Will Claude be nudged to keep going after its sign-in is revoked?**
No. A turn that ends on an API error (sign-in revoked, outage) is not checked for a stall, since a nudge would fail the same way.

**Claude keeps getting nudged.**
At most three nudges since you last typed a prompt yourself, and a nudge whose turn did no tool calls ends the nudging early. Typing a prompt resets the budget.

## UI

**The status line shows `⚠ jev-autopilot: autopilot ●`. Is something wrong?**
No. Claude Code draws every plugin status line with that `⚠` marker; the plugin cannot change it.

**Why do toasts start with `jev-autopilot:`?**
Claude Code names the plugin on every toast; the plugin's own text follows without a second prefix.

**No badge or toasts in a headless run.**
`claude -p` draws neither. The slash commands still work and print their replies.

## Firstmate

**`Firstmate: not detected (…)` in a Firstmate checkout.**
The reason in parentheses is one of the detection rules on [[Firstmate Integration]]: a missing `bin/fm-captain-hold.sh` or `AGENTS.md`, not the top level of the repository, a remote that is not `github.com/kunchenguid/firstmate` (list a fork or the absolute path in `firstmateRemotes`), or a script with uncommitted changes. Detection is decided when the mod loads; restart the session after fixing it.

**A toast says `not running Firstmate scripts (uncommitted changes in …)`.**
The scripts are re-checked right before every run. Commit or revert the change.

## Development

**`tsc` fails with missing types.**
The type check needs `.claude-plugin/types/`, which Claude Code generates when it loads the mod. Run `claude --plugin-dir . -p '/autopilot status'` once; it works signed out.

**`claude plugin validate --strict` reports a variable "assigned to elsewhere".**
A local variable named like a function that receives `$` (for example `let jev` next to `async function jev($)`) trips the validator. Rename the local.

See [[Development and Contributing]] for the full check list.
