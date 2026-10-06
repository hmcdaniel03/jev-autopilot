# Privacy

Exactly what leaves your machine, to whom, when, and with what limits. The plugin has no telemetry and talks to nothing but Telegram's Bot API and TypeSafe's API. Everything it sends and writes is redacted first: the bot token and TypeSafe key it holds are removed wherever they appear, and anything that looks like a bearer header, a Telegram bot token, a well-known API key prefix (`sk-`, `ghp_`, `gho_`, `github_pat_`, `xox…`) or a `token=`/`key=`/`secret=`/`password=`-style assignment is replaced with `[redacted]`.

## To Telegram

Reaches Telegram's servers and your phone. Sent only while autopilot is on, a pairing code is pending, or for three minutes after `/autopilot test`.

| What | Content and limits |
| --- | --- |
| Token check | `/autopilot setup` and `/autopilot pair` call `getMe`, which sends nothing but the token in the URL. |
| Pairing | `🔗 Paired with Claude Code.` to the chat that paired. Nothing to a chat that fails. |
| Questions Claude asked | The question, each option's label and description, the reason it was escalated, the project folder **name** (not the path), and Jev's suggested answer. |
| Held tool calls | The tool name and the command (cut to 400 characters) or the file path or URL, or up to 300 characters of the tool's input as JSON; the whole body is cut to 900 characters. Plus Jev's risk word and danger score. |
| Firstmate captain calls | The task title, up to 1,200 characters of the reason, up to 1,200 of the detail, the PR URL, the escalation reason and Jev's lean. Jev's own approvals: the title and scores. Landed notices: the task title and PR URL. The fleet's finished notice: up to eight titles of tasks still waiting on you. |
| End-of-turn notices | `Finished` or `Everything remaining is waiting on you`, with up to 900 characters of Claude's final message. |
| Replies to turns you started from the phone | Claude's whole final reply, converted to Telegram HTML, in up to four messages of 4,096 characters; the rest is cut with a note. |
| Switch-on notice | The project folder name. |
| `/status` answers | The project folder name, the switch, and the last tool summary (as above). |
| Receipts | Short fixed strings. |

The plugin never sends file contents, diffs, or conversation history to Telegram.

## To TypeSafe (Jev)

Sent only while autopilot is on, except the key check below.

| What | Content and limits |
| --- | --- |
| Key check | `/autopilot setup` makes one `GET /v1/models` call with the key. Not billed; nothing else is sent. |
| Each question | The question text and options, the project folder name **and path**, and the last ten conversation messages' text (user and assistant text blocks only, cut to the last 6,000 characters). |
| Each screened tool call | The tool and what it does: the shell command (heredoc bodies collapsed to a marker, scratch deletions rewritten, cut to 1,500 characters), or the file path with whether it is inside the project, or up to 600 characters of the tool input; the working directory; up to 600 characters of your last prompt. |
| Each keep-going check | Up to 1,500 characters of your last prompt and up to 3,000 characters of Claude's final message. |
| Each Firstmate captain call | The title, up to 1,500 characters of the reason, up to 3,000 of the detail, and the PR URL. |

See TypeSafe's terms for how they handle request data.

## To nobody

- The decisions log stays in `~/.claude/autopilot/decisions.jsonl`, written and read locally.
- The secrets file is read, never sent (the values are redacted even from error messages that might quote a URL containing the token).
- The plugin store (switch, pairing, inboxes, approvals) stays in Claude Code's local store.
- Nothing is sent when autopilot is off, except during a pending pairing or the three minutes after `/autopilot test`.
- Firstmate's snapshot JSON is read locally; only the fields above are forwarded.

## Who can see what

- Whoever holds the **paired Telegram chat** sees everything in the first table and can steer the session. See [[Safety Model and Permission Layering]].
- **Firstmate worker** sessions send nothing to Telegram at all; their escalations go to Firstmate's status files on the local machine.
- Jev's answers are logged locally with the question or command they judged, so the [[Decision Log]] contains the same text that was sent, redacted the same way.
