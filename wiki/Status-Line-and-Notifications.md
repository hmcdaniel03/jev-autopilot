# Status Line and Notifications

How the plugin shows itself: the badge under the prompt, toasts, the notes Claude sees in context, and every message the Telegram bot can send.

## The status line

While autopilot is on, the line under the prompt shows the plugin's badge. Claude Code draws it with the plugin's name and a `⚠` marker of its own (the API has no option to change that):

```
⚠ jev-autopilot: autopilot ●
```

| Role | Badge |
| --- | --- |
| solo | `autopilot ●` |
| captain | `autopilot ● firstmate` |
| worker | `autopilot ● worker (screening only)` |
| supervisor | none |

The badge is redrawn by the 3-second background tick whenever the state differs from what this session last drew, so switching autopilot on from another window (or a headless `claude -p '/autopilot on'`) makes an open session draw it within a few seconds, and `/autopilot off` anywhere clears it everywhere. A headless `-p` run does not draw a status line or toasts at all.

## Toasts

Short notices at the bottom right, prefixed `jev-autopilot:` by Claude Code:

| Toast | When |
| --- | --- |
| `ignoring ~/.claude/jev-autopilot/secrets.env (mode 644); run chmod 600 on it` | The secrets file is readable by others; once per mode and modification time. |
| `Telegram paired with @you` | Pairing succeeded. |
| `wrong pairing code from @someone (2 attempts left)` | A wrong guess from a private chat. |
| `pairing code burned after 3 wrong guesses; run /autopilot pair again` | Three wrong guesses. |
| `pairing code expired; run /autopilot pair again`, `the pairing code expired; run /autopilot pair again` | A guess after expiry, or the tick noticing an expired code. |
| `Jev answered (conf 0.82)` / `Jev answered (conf 0.55, flagged)` | A question was auto-answered. |
| `Jev failed (<reason>); asking you here` | Jev could not answer a question; it is asked in the terminal. |
| `Telegram failed (<reason>); asking here` | A question could not be sent to the phone; asked in the terminal. |
| `Jev unreachable, tool calls are not being screened right now` | Screening failed; at most once a minute. |
| `Telegram failed while holding a call (<reason>)` | A held call could not be sent to the phone; Claude is told to park it. |
| `work remains, nudging Claude to keep going` | A keep-going nudge was submitted. |
| `not running Firstmate scripts (<reason>)` | A Firstmate script is no longer tracked and clean; at most every 10 minutes. |

Every reason is redacted before it is shown.

## Notices Claude sees

Text the plugin adds to Claude's context, besides the standing prompt described on [[How Autopilot Works]]:

- **State change**, once per session, on the next prompt or tool result: `jev-autopilot: autopilot is now ON for every session on this machine - the owner is away; decide what you can and ask only true decisions.` or `… is now OFF for every session on this machine - the owner is back at the terminal.` (A session that has never seen the state only gets the ON line.)
- **An auto-answered question**: `the owner is away; Jev (an automated decision model) answered this on the owner's behalf. Keep going.` or, when flagged, `… answered with LOW confidence. Implement this choice in the most reversible way, note the assumption on the ticket, and keep going.`
- **An escalated question** (as the tool's denial): `Sent to the owner's phone (high-stakes); the answer will arrive later as a message. Do NOT wait for it and do NOT decide it yourself. Note the open question, park only the work that depends on it, and keep going with everything else that can proceed. When the answer arrives, pick that work back up.`
- **A held call** (as the tool's denial): `Held for the owner's approval by phone (Jev rated it destructive, 0.90). Do NOT wait and do not work around it: park this step and keep going with other work. If the owner approves, a message will tell you and you can then run exactly the same call; if the owner blocks it, you will be told.` Variants say Telegram is not set up, or that it could not be reached, and to explain the step in the summary.
- **A message from the phone**: `Message from the owner via Telegram (the owner is away from the terminal; treat this as direction from them):` followed by the text, with a note such as `(the owner's answer to your earlier question "…")` or `(the owner reviewed a held tool call) APPROVED: you may now run exactly this held call (same command/input): …` / `BLOCKED: do not run this held call or work around it: …`. When the message is yours in person, it adds: `Your final reply this turn is sent back to the owner on Telegram: keep it short and phone-readable, and say what you did or are about to do.`
- **A keep-going nudge** (as a new prompt): `Autopilot keep-going: the owner is away, so don't wait on the owner. Make sure anything that needs the owner's decision has been asked with AskUserQuestion, park only the work that depends on it, and continue with the remaining work (…). Stop only when everything left is blocked on the owner's answers, then summarize what is waiting.`
- **A recorded captain call** (captain sessions, as a new prompt): `Captain call <id> has been answered and recorded (…): "<answer>". Run your wake drain and continue.`

"the owner" is replaced by your `ownerName`.

## Telegram messages

Everything the bot can send to the paired chat. `<project>` is the working directory's folder name.

| Message | Meaning |
| --- | --- |
| `🔗 Paired with Claude Code. Messages here now reach the session.` | Pairing succeeded. |
| `👋 jev-autopilot test from <project>. Reply within 3 minutes to check two-way delivery.` | `/autopilot test`. |
| `🟢 Autopilot on for every session on this machine (switched on from <project>).` | `/autopilot on` while paired. |
| `🤖 Decision needed (<reason>) · <project>` + the question, numbered options, `Jev leans: …`, one button per option | A question Jev escalated. Reason: `high-stakes` or `needs a free-text answer`. |
| `⚠️ Tool call on hold · <project>` + the call in a code block, `Jev: destructive (danger 0.90)`, buttons **✅ Proceed** / **❌ Block** | A held tool call. |
| `⚓ Firstmate needs the captain (<reason>) · <project>` + title, reason, detail, PR, `Jev leans: …`, buttons **✅ Approve recommendation** / **❌ Decline** | An escalated captain call. Reason: `sensitive`, `high-stakes`, `Jev would not approve it`, `Jev unsure` or `Jev unavailable: …`. |
| `🤖 Jev approved firstmate's call <title> (stakes 0.12, conf 0.88).` | Jev approved a captain call. |
| `✅ Recorded for firstmate: <answer>` / `✅ Recorded for firstmate in your words.` | Your tap or reply was recorded. |
| `⚠️ Could not record the answer for <id> in Firstmate: …` | Firstmate's intake failed. |
| `✅ Landed (merged|reported|done) · <project>` + title and PR | Firstmate moved a task to Done. |
| `🏁 Finished · <project>` + `All running work has landed.` + `Still waiting on you:` list or `Nothing is waiting on you.` | The fleet's last running task landed. |
| `🏁 Finished · <project>` + Claude's final message | A plain session finished (Jev's `done >= 0.7`). |
| `⏸ Everything remaining is waiting on you · <project>` + Claude's final message | A plain session stopped on a real question for you; at most every 20 minutes. |
| `👀 Received — Claude will see this at its next step.` / `… Claude is idle, starting a turn with it.` / `👀 Got it — …` | Your message was queued. |
| `✅ Delivered — Claude is on it.` / `✅ Queued for Claude right after its current step.` / `✅ Claude has read this.` | Your message reached Claude (as a reply to it). |
| Claude's final reply, as a reply to your message | The turn you started from the phone ended. Up to four messages; the last ends with `… (cut short; the full reply is in the terminal)` when more was cut. |
| `<project> · autopilot on|off` + `Working. Last tool: …` or `Idle.` + `N message(s) queued for Claude.` | `/status`. |
| `🛑 Stopped the current turn. Send a message to give it new direction.` / `Nothing is running.` | `/stop`. |
| `Commands: /status, /stop. Any other message goes straight to Claude; reply to a prompt to answer it.` | Any other `/command`. |

Each prompt with buttons ends with `Tap a button, or reply to this message with directions.` Button labels are cut to 60 characters.
