# Decision Log

Every decision the plugin takes or relays is appended to one local file:

| OS | Path |
| --- | --- |
| macOS / Linux | `~/.claude/autopilot/decisions.jsonl` |
| Windows | `%USERPROFILE%\.claude\autopilot\decisions.jsonl` |

One JSON object per line, append-only, never sent anywhere. Every line is redacted before it is written: the secrets the plugin holds and anything that looks like a token, key or password become `[redacted]`. `/autopilot status` prints the path; `/autopilot log` shows the last 15 entries.

## Common fields

| Field | Meaning |
| --- | --- |
| `at` | ISO 8601 timestamp (UTC). |
| `cwd` | The session's working directory. |
| `by` | Who decided: `jev`, `human-telegram`, `human-terminal` or `telegram-error`. |

## Record shapes

### Questions

| Fields | Meaning |
| --- | --- |
| `by: "jev"`, `questions`, `answers`, `confidence`, `stakes`, `review` | Jev answered. `questions` is a list of `{question, options}`; `answers` maps each question to the chosen label (comma-joined for multi-select); `review: true` marks a low-confidence answer (shown as `⚑` by `/autopilot log`). |
| `by: "jev"`, `questions`, `reason`, `stakes`, `outcome: "sent to Telegram, agent told to keep going"` | Escalated to the phone. `reason` is `high-stakes` or `needs a free-text answer`. |
| `by: "jev"`, `questions`, `reason`, `stakes`, `outcome: "routed to firstmate"` | Escalated in a worker session. |
| `by: "human-terminal"`, `questions`, `reason`, `stakes` | Escalated, but Telegram is not set up, so it was asked in the terminal. |

### Tool calls

| Fields | Meaning |
| --- | --- |
| `by: "jev"`, `tool`, `risk`, `pDanger`, `outcome: "held"` or `"allowed"` | Jev's verdict on a call it did not rate `safe`. `tool` is the summary (`Bash: <command cut to 400 chars>`, `Edit: <path>`, `WebFetch: <url>`, or `<tool>: <input JSON cut to 300 chars>`); `risk` is `destructive` or `outward`; `pDanger` the danger score. Calls rated `safe` are not logged. |
| `by: "jev"`, `tool`, `risk`, `pDanger`, `outcome: "blocked, routed to firstmate"` | A held call in a worker session. |
| `by: "human-telegram"`, `tool`, `outcome: "Proceed"` / `"Block"` / your text | Your verdict from the phone on a held call. |
| `by: "human-telegram"`, `tool`, `outcome: "let through after approval"` | The approved call was handed on to Claude Code's permission mode (which can still deny it). |
| `by: "human-telegram"`, `tool`, `outcome: "approval expired; screened again"` | The retry came after `telegramWaitMinutes`. |
| `by: "telegram-error"`, `tool`, `risk`, `pDanger`, `outcome: <failure>` | The hold could not be sent to the phone. |

### Keep-going checks

| Fields | Meaning |
| --- | --- |
| `by: "jev"`, `stall: true`, `done`, `proceedable`, `outcome: "nudged to keep going"` / `"let it stop"` | Jev's stall verdict at the end of a turn, with its probabilities. |
| `by: "jev"`, `stall: true`, `done`, `proceedable`, `outcome: "told <owner>: finished"` / `"told <owner>: waiting"` | An end-of-turn notice went to the phone. |
| `by: "jev"`, `stall: true`, `done: 1`, `proceedable: 0`, `outcome: "told <owner>: finished (N decisions still open)"` | The Firstmate fleet notice went to the phone. |

### Firstmate captain calls

| Fields | Meaning |
| --- | --- |
| `by: "jev"`, `fmTask`, `outcome: "sent to Telegram (<reason>)"`, `stakes`, `lean` | A captain call was escalated. |
| `by: "jev"` or `"human-telegram"`, `fmTask`, `answer`, `mode`, `outcome: "recorded"` / `"intake failed: …"` | An answer was passed to `fm-captain-hold.sh`. `mode` is `done` or `release`. |
| `by: "jev"`, `fmTask: "bin/…sh"`, `outcome: "not run: <reason>"` | A Firstmate script was skipped because it is no longer tracked and clean. |

## Examples

```json
{"at":"2026-10-05T14:03:11.412Z","cwd":"/home/sam/app","by":"jev","tool":"Bash: git push --force origin main","risk":"destructive","pDanger":0.9,"outcome":"held"}
{"at":"2026-10-05T14:05:40.008Z","cwd":"/home/sam/app","by":"human-telegram","tool":"Bash: git push --force origin main","outcome":"Proceed"}
{"at":"2026-10-05T14:05:52.771Z","cwd":"/home/sam/app","by":"human-telegram","tool":"Bash: git push --force origin main","outcome":"let through after approval"}
{"at":"2026-10-05T14:20:03.190Z","cwd":"/home/sam/app","by":"jev","questions":[{"question":"Which database should the service use?","options":["SQLite","Postgres"]}],"answers":{"Which database should the service use?":"SQLite"},"confidence":0.82,"stakes":0.12,"review":false}
{"at":"2026-10-05T14:41:19.655Z","cwd":"/home/sam/app","by":"jev","stall":true,"done":0.07,"proceedable":0.77,"outcome":"nudged to keep going"}
{"at":"2026-10-05T15:02:48.330Z","cwd":"/home/sam/firstmate","by":"jev","fmTask":"task-123","outcome":"sent to Telegram (high-stakes)","stakes":0.81,"lean":"approve"}
```

## `/autopilot log`

Renders the last 15 lines as `MM-DDTHH:MM [by]<⚑> <what>`:

- a stall check: `turn ended → <outcome> (done 0.07, more possible 0.77)`;
- a tool call: `<tool summary> → <outcome>`;
- a captain call: `firstmate <id> → <outcome>`;
- a question: `Q: <first 60 characters> → <answers, or the outcome or reason>`.

For anything more, read the file: `tail -f ~/.claude/autopilot/decisions.jsonl`, or `jq` over it. Worth watching: `allowed` entries with a `pDanger` just under `holdThreshold`, which tell you whether the threshold suits your work.
