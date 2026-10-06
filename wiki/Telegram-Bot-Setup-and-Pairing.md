# Telegram Bot Setup and Pairing

Telegram is the phone side of autopilot: where held calls and high-stakes questions arrive, and where you steer the session from. The paired chat is **root** (see [[Safety Model and Permission Layering]]), so set it up with care.

## Create the bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and follow its prompts.
2. Copy the token it gives you (it looks like `123456789:AAF…`) into `TELEGRAM_BOT_TOKEN` in the secrets file, never into the Claude Code chat. `/autopilot setup` prints the exact editor line and a one-line terminal command for your OS; see [[Secrets and Configuration]].
3. **One bot per machine.** The plugin reads updates with Telegram's long-polling `getUpdates`, and Telegram allows only one poller per bot. Two machines, or an unrelated program, polling the same bot will fight over the updates. Make a bot for each machine.

## Pair your phone

Pairing tells the plugin which chat is yours. Run `/autopilot pair` (or let `/autopilot setup` reach that step):

1. The command first calls Telegram's `getMe` with your token. If that fails (wrong token, no network to `api.telegram.org`), **no code is issued** and the reply says why. If it succeeds, the reply names the bot: `Send this code to @yourbot in a private Telegram chat within 10 minutes: XXXXX-XXXXX`.
2. The code is crypto-random, 10 characters from an alphabet without `0`, `O`, `1` or `I` (50 bits), shown as two groups of five. Case and punctuation do not matter when you type it back.
3. Send it to your bot from a **private** chat. Group chats cannot pair. Any message from a chat that is not the paired one is treated only as a pairing attempt, and only while a code is pending; strangers get no reply at all.
4. The code **expires after 10 minutes** and **burns after three wrong guesses**. Either way you run `/autopilot pair` again. A toast in the terminal reports each wrong guess (`wrong pairing code from @someone (2 attempts left)`), a burn, an expiry, and the success: `Telegram paired with @you`. The chat gets `🔗 Paired with Claude Code. Messages here now reach the session.`
5. Pairing while a chat is already paired replaces it; the `pair` reply says so.

`/autopilot unpair` forgets the chat and any pending code. `/autopilot test` sends a test message to the paired chat and keeps the plugin listening for a reply for three minutes, so you can check both directions before you leave.

### Pinning the chat

`TELEGRAM_CHAT_ID` in the secrets file (or the environment) names the chat directly and takes precedence over the paired one. It is useful for a machine you provision by script. After `/autopilot unpair` the reply reminds you that a pinned chat id still names a chat.

## The listener

Only one session per machine reads the bot's updates, because only one `getUpdates` poller is allowed. Sessions hold a **lease** in the shared plugin store: 15 seconds, renewed on every 3-second tick, taken over when it expires (the session died) and preferred to a Firstmate captain session when one exists. Every session still delivers its own inbox, so an answer reaches the session that asked even when another session is doing the polling.

The bot is polled only when there is a reason to: autopilot is on, a pairing code is pending, or it is within three minutes of `/autopilot test`. Otherwise the plugin does not touch Telegram at all. Each update's offset is committed only after it has been handled, so a crash mid-batch replays rather than loses a message.

Worker sessions (Firstmate crewmates) and Firstmate's headless supervisor never talk to Telegram.

## What you can send

In the paired chat:

| You send | What happens |
| --- | --- |
| A **button tap** on a question | The option becomes the answer; the buttons are removed from the message and Telegram shows "Got it". Claude gets it at its next step. |
| **Proceed** or **Block** on a held call | Approves that exact call once (for `telegramWaitMinutes`) or tells Claude not to run or work around it. See [[How Autopilot Works]]. |
| A **reply** to a prompt the plugin sent | Your words become the answer to that question or held call. On a Firstmate captain call, your words are recorded in Firstmate "in your own words". |
| A **reply** to any other bot message | Delivered to Claude as direction. |
| `/status` | Replies with the project name, whether autopilot is on, `Working. Last tool: …` or `Idle.`, and how many messages are queued. |
| `/stop` | Aborts the current turn (`🛑 Stopped the current turn. Send a message to give it new direction.`) or says `Nothing is running.` |
| Any other `/command` | `Commands: /status, /stop. Any other message goes straight to Claude; reply to a prompt to answer it.` |
| **Any other text** | Delivered to Claude as direction from you. The receipt says whether Claude is mid-turn (`Claude will see this at its next step.`) or idle (`Claude is idle, starting a turn with it.`). Claude's final reply for that turn comes back to you as a reply to your message. |

Receipts (`👀 Received`, `✅ Delivered — Claude is on it.`, `✅ Queued for Claude right after its current step.`, `✅ Claude has read this.`) tell you where your message is. The full catalogue of messages the bot sends is on [[Status Line and Notifications]].

## What the bot sends, and when

Only while autopilot is on, a pairing code is pending, or for three minutes after `/autopilot test`:

- questions Claude asked that Jev escalated, with buttons and Jev's suggestion;
- held tool calls, with Proceed/Block;
- Firstmate captain calls, Jev's approvals of them, "landed" notices and the fleet's finished notice (captain sessions only);
- `Finished` and `Everything remaining is waiting on you` notices at the end of a turn;
- `🟢 Autopilot on for every session on this machine (switched on from <project>)` when you switch on while paired;
- the session's final reply for every turn you started from the phone, `/status` answers and receipts.

Everything sent is redacted first: the secrets the plugin holds and anything that looks like a token, key or password are replaced with `[redacted]`. See [[Privacy]] for the exact content and limits.
