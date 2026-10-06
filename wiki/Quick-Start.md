# Quick Start

From nothing to a paired phone and autopilot on. The guided `/autopilot setup` command does the work; this page says what it does at each step so you know what to expect, and how to do any step by hand.

## Requirements

| What | Why |
| --- | --- |
| Claude Code **2.1.289** or newer | The version this release was tested with. Mods use the Claude Code hooks module API, which can change between releases; `/autopilot setup` warns when the running version is older. |
| A Telegram bot from [@BotFather](https://t.me/BotFather) | Your phone-side control. **One bot per machine**: only one process can poll a bot's updates. See [[Telegram Bot Setup and Pairing]]. |
| A TypeSafe API key for Jev | The decision model. TypeSafe is in early access with a waitlist at `console.typesafe.ai`; usage is pay-as-you-go. Optional until you have one: without it the plugin still relays Telegram, but nothing is answered or screened. See [[Jev and TypeSafe]]. |

## 1. Install

From the GitHub repository as a marketplace:

```sh
claude plugin marketplace add hmcdaniel03/jev-autopilot
claude plugin install jev-autopilot@jev-autopilot
claude plugin list    # jev-autopilot@jev-autopilot, Status: enabled
```

Or from a clone. Either list the folder in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json` on Windows; separate paths with `:` on macOS/Linux and `;` on Windows), or start Claude Code with `--plugin-dir /path/to/jev-autopilot`. Loaded that way the plugin's id is `jev-autopilot@inline`; use that wherever this wiki writes `jev-autopilot@jev-autopilot`.

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/home/sam/jev-autopilot:/home/sam/other-mod"
"CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\sam\\jev-autopilot;C:\\Users\\sam\\other-mod"
```

## 2. Run `/autopilot setup`

Inside Claude Code, run **`/autopilot setup`**. Every run starts by reading the world as it is (the secrets file, its permissions, the pairing state, the switch), so it resumes wherever the last run stopped, and a finished setup just reports itself. Re-run it after each step you do by hand.

The steps, in the order the state machine takes them:

| Step | What happens | What you do |
| --- | --- | --- |
| Prerequisites | Prints the Claude Code version against the tested one, and that the plugin loaded. | Nothing. Update Claude Code if it says the version is older and setup misbehaves. |
| Create the secrets file | Creates `~/.claude/jev-autopilot/secrets.env` (`%USERPROFILE%\.claude\jev-autopilot\secrets.env` on Windows) readable by you only, from a commented template. An existing file is left alone. | Nothing. |
| Fix the file mode | If the file is readable by the group or the world, the plugin ignores it. Setup prints the `chmod 600` (or `icacls`) command. | Run the command, re-run setup. |
| Add the bot token | Says where to put `TELEGRAM_BOT_TOKEN`: an editor line, or a one-line terminal command for your OS that reads the value hidden and appends it. **Never paste a secret into the chat or a slash command**; that lands in the transcript. | Add the token, re-run setup. |
| Verify | Checks the bot token with Telegram's `getMe` and, if `TYPESAFE_API_KEY` is present, the key with TypeSafe's non-billed `GET /v1/models`. | Nothing. A rejected token stops the flow with the paste instructions again. A missing key is reported as optional. |
| Your name | Asks what prompts and Telegram text should call you (the default is "the owner"). In a headless run it prints the `/autopilot name` hint instead. | Type a first name, or skip. A name is not a secret. |
| Pair | Issues a pairing code and names the bot to send it to. | Send the code to your bot in a **private** chat within 10 minutes. Three wrong guesses burn it. Re-run setup. |
| Enable | Offers to switch autopilot on for every session on this machine. | Say yes, or run `/autopilot on` later. |
| Done | Reports the whole state and points at `/autopilot status`, `/autopilot log` and `/autopilot off`. | |

## 3. Check and test

- `/autopilot status` shows the switch, your name, the session role, Firstmate detection, whether the Jev key and bot token were found (and from where), pairing, and the secrets file and log paths.
- `/autopilot test` sends a test message to the paired chat and listens for a reply for three minutes, so you can check two-way delivery before you leave.

## 4. Turn it on

`/autopilot on`, or answer yes at the end of setup. The switch is **machine-wide**: it applies to every Claude Code session on this machine, in every project, until `/autopilot off`. Sessions that are already open pick up the change within a few seconds and show `jev-autopilot: autopilot ●` under the prompt. Setting `JEV_AUTOPILOT=1` in the environment also turns it on for that process.

`/autopilot on` warns when no TypeSafe key is set, because then nothing is screened.

## Doing the steps by hand

Everything setup does can be done manually; the command notices what is already done.

**Secrets** (macOS/Linux):

```sh
mkdir -p ~/.claude/jev-autopilot
(umask 077; : > ~/.claude/jev-autopilot/secrets.env); chmod 600 ~/.claude/jev-autopilot/secrets.env
printf 'Telegram bot token: '; read -rs v; echo; printf 'TELEGRAM_BOT_TOKEN=%s\n' "$v" >> ~/.claude/jev-autopilot/secrets.env; unset v
printf 'TypeSafe API key: '; read -rs v; echo; printf 'TYPESAFE_API_KEY=%s\n' "$v" >> ~/.claude/jev-autopilot/secrets.env; unset v
```

**Secrets** (Windows, PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\jev-autopilot" | Out-Null
$f = "$env:USERPROFILE\.claude\jev-autopilot\secrets.env"
New-Item -ItemType File -Force $f | Out-Null
icacls $f /inheritance:r /grant:r "$env:USERNAME:(R,W)"
$s = Read-Host 'Telegram bot token' -AsSecureString; $v = [Net.NetworkCredential]::new('', $s).Password; Add-Content -Path $f -Value "TELEGRAM_BOT_TOKEN=$v"; Remove-Variable v, s
$s = Read-Host 'TypeSafe API key' -AsSecureString; $v = [Net.NetworkCredential]::new('', $s).Password; Add-Content -Path $f -Value "TYPESAFE_API_KEY=$v"; Remove-Variable v, s
```

**Name:** `/autopilot name Sam`, or `/plugin configure jev-autopilot@jev-autopilot`, or from a shell:

```sh
echo '{"ownerName":"Sam"}' | claude plugin configure jev-autopilot@jev-autopilot --values-stdin
```

**Pair:** `/autopilot pair`, then send the code from your phone. **Switch on:** `/autopilot on`.

The file format, the permission rules and every option are on [[Secrets and Configuration]]; every command and its exact reply is on [[Commands Reference]].
