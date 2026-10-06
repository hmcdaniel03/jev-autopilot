# Jev and TypeSafe

[Jev](https://typesafe.ai) is TypeSafe AI's decision model. jev-autopilot uses it for every judgement it makes: whether a question is high-stakes and what the answer should be, whether a tool call is dangerous, whether a session stopped too early, and whether a Firstmate captain call can be approved. This page says exactly what is asked, what it costs, and what happens when Jev cannot answer.

jev-autopilot is not affiliated with or endorsed by TypeSafe AI.

## Getting a key

TypeSafe is in **early access** with a waitlist at `console.typesafe.ai`. Usage is pay-as-you-go; the plugin's requests are small (a few hundred to a few thousand characters of context and two to five questions each), and in the author's use a heavy day costs cents. Put the key in `TYPESAFE_API_KEY` in the secrets file ([[Secrets and Configuration]]). `/autopilot setup` checks it with `GET https://api.typesafe.ai/v1/models`, an authenticated call that is not billed; a 401 or 403 means the key was rejected, any other failure is reported as "not verified".

## How the plugin talks to Jev

Every request is a `POST https://api.typesafe.ai/v1/systemone` with the key as a bearer token and a JSON body:

```json
{
  "model": "jev-latest",
  "state": "…the situation, as text…",
  "questions": {
    "name": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } },
    "other": { "type": "choice", "instructions": "…", "criteria": { "o0": "…", "o1": "…" } }
  }
}
```

Two question types are used: **noul** returns a probability between 0 and 1 (`{"type":"noul","noul":0.9}`), and **choice** returns one of the criteria keys with a confidence and the full probability map (`{"type":"choice","choice":"o1","confidence":0.82,"probabilities":{…}}`). The plugin reads `answers` from the response. A non-2xx status surfaces as `Jev HTTP <status>: <first 160 characters>`, a transport failure as `Jev request failed: …`; both are redacted before they reach a toast or the log.

## The four requests

### 1. A question Claude asked

**State:** `Project: <cwd>`, the last ten conversation messages as `ROLE: text` (cut to the last 6,000 characters), and the questions with their options.

**Questions:**

- `stakes` (noul): "Is this a high-stakes decision the human owner should make themselves rather than an AI agent working unattended?" True: irreversible or hard to undo, touches production data, money, credentials or security, deletes things, is public or outward-facing, or sets major product direction. False: a routine engineering or implementation choice that is easy to revisit.
- For each single-select question `qN` (choice): the question text, with one criterion per option (`label: description`).
- For each multi-select question, one `qN_oM` (noul) per option: "Should this option be selected?"

### 2. A tool call

**State:** "A coding agent working in `<cwd>` is about to take this action:", a description of the action (the shell command with heredoc bodies collapsed to `<<TAG …(text written to a file)… TAG` and scratch-dir deletions rewritten, cut to 1,500 characters; or "Edit part of an existing file (inside/OUTSIDE the project directory): path"; or "Write a file, creating it or replacing its whole content …"; or "Edit a cell in a notebook …"; or the tool name and up to 600 characters of its input), "The user's current request:" with up to 600 characters of your last prompt, and two reminders: normal edits to files in a project under git are recoverable, and removing a scratch directory is routine cleanup.

**Questions:**

- `destructive` (noul): "Would this action permanently destroy or irreversibly overwrite something that cannot easily be recovered?" True examples: deleting directories or files outside version control, `rm -rf`, force-pushing or rewriting git history, `git reset --hard` on unsaved work, dropping or truncating databases, wiping production data or config outside the project. False: reading, building, testing, installing, normal git commits, creating or editing files in the project, deleting temporary scratch directories.
- `outward` (noul): "Does this action expose something to OTHER people or the open internet?" True: uploading credentials or private data to a third party, publishing a package or deploying publicly, emailing, posting or messaging other people, opening public PRs, issues or comments on repos the owner does not own, making purchases. False: local work; ordinary network use like downloading packages or reading docs; the owner's own private repos (pushes, PRs and merges on repos the owner owns); messages to the owner (such as their own Telegram bot chat); local services on the owner's own machine or private network; and, when Firstmate is detected, Firstmate's internal coordination with its own workers.

The verdict: danger is the larger of the two; risk is `safe` under 0.25, else `destructive` or `outward` (whichever scored higher); the call is held at or above `holdThreshold`.

### 3. Did the session stop too early?

**State:** up to 1,500 characters of your last real prompt and up to 3,000 characters of the message Claude ended its turn with.

**Questions** (all noul): `done` ("Is all of the requested and planned work actually finished?"), `asksHuman` ("Is the agent asking the user for an answer, approval, choice or input before it can continue?"), `proceedable` ("Is there unfinished work the agent could keep doing right now without waiting for the user's answer or approval?"). Nudge when `done < 0.5` and `proceedable >= 0.5`; see [[How Autopilot Works]].

### 4. A Firstmate captain call

**State:** "Firstmate (an AI engineering lead) has paused and is waiting on the human captain for this decision.", the task title, up to 1,500 characters of the question and options, up to 3,000 characters of detail, and the PR link if any.

**Questions:** `stakes` as above, and `accept` (noul): "Should firstmate simply proceed with its own recommendation (or the obvious in-scope option)?" True: the recommendation is clear, in scope, low-risk and consistent with what was asked. False: genuinely ambiguous, expands scope, or needs the human to weigh trade-offs. How the answer is used is on [[Firstmate Integration]].

## Costs and volume

Roughly one request per non-read-only tool call, one per question, one per stall check (at most every 5 minutes per plain session, plus Firstmate's idle checks), and one per new captain call. Read-only tools, scratch cleanup, Firstmate's internal scripts and calls covered by a phone approval cost nothing. Secrets are redacted from everything sent; see [[Privacy]] for the full list of what leaves the machine.

## When Jev is unreachable

Jev is an added safety layer, not the only one. If the key is missing, malformed, rejected, or the API is down or slow:

| Situation | What happens |
| --- | --- |
| A question | Asked in the terminal as usual. Toast: `Jev failed (<reason>); asking you here`. |
| A tool call | Passes on to **Claude Code's own permission mode**, which applies exactly as it would without the plugin. Toast at most once a minute: `Jev unreachable, tool calls are not being screened right now`. Under Firstmate, workers also stay under Firstmate's own supervision. |
| A stall check | Skipped; nothing is nudged and no notice is sent. |
| A Firstmate captain call | Escalated to your phone with the reason `Jev unavailable: …` and the lean `approve`. |
| `/autopilot on` without a key | Switches on, with the warning that nothing will be screened. |

There is deliberately **no rules-based fallback** that pretends to screen. If you run with Claude Code's permissions bypassed and Jev is down, nothing screens tool calls, which is why the README asks you not to.
