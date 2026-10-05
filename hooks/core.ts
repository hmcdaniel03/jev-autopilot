// Pure logic for jev-autopilot: building Jev requests, turning answers into
// decisions, and formatting/parsing Telegram traffic. No `$` here so it tests cleanly.

export type Option = { label: string; description?: string }
export type Question = { question: string; header: string; options: Option[]; multiSelect: boolean }

export type Config = { minConfidence: number; stakesThreshold: number; holdThreshold: number }

// Defaults when the plugin options leave a threshold unset (mirrors .claude-plugin/plugin.json).
export const DEFAULTS: Config = { minConfidence: 0.7, stakesThreshold: 0.5, holdThreshold: 0.65 }

// How the owner is named in prompts and Telegram text when `ownerName` is unset.
export const DEFAULT_OWNER = 'the owner'

type NoulAnswer = { type: 'noul'; noul: number }
type ChoiceAnswer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export type JevAnswers = Record<string, NoulAnswer | ChoiceAnswer>

const optionText = (o: Option) => (o.description ? `${o.label}: ${o.description}` : o.label)
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

// ---------------------------------------------------------------- questions

export type Decision =
  | { kind: 'auto'; answers: Record<string, string>; confidence: number; stakes: number; review: boolean }
  | { kind: 'escalate'; reason: string; stakes: number; suggested: Record<string, string> }

const STAKES_QUESTION = {
  type: 'noul',
  instructions:
    'Is this a high-stakes decision the human owner should make themselves rather than an AI agent working unattended?',
  criteria: {
    true: 'Irreversible or hard to undo, touches production data, money, credentials or security, deletes things, is public or outward-facing, or sets major product direction',
    false: 'A routine engineering or implementation choice that is easy to revisit or reverse later',
  },
}

export function buildQuestionRequest(questions: readonly Question[], context: string) {
  const qs: Record<string, unknown> = { stakes: STAKES_QUESTION }
  questions.forEach((q, i) => {
    if (q.options.length === 0) return
    if (q.multiSelect) {
      q.options.forEach((o, j) => {
        qs[`q${i}_o${j}`] = {
          type: 'noul',
          instructions: `${q.question}\nShould this option be selected? ${optionText(o)}`,
          criteria: { true: 'Select this option', false: 'Leave this option out' },
        }
      })
    } else {
      qs[`q${i}`] = {
        type: 'choice',
        instructions: q.question,
        criteria: Object.fromEntries(q.options.map((o, j) => [`o${j}`, optionText(o)])),
      }
    }
  })
  return { model: 'jev-latest', state: context, questions: qs }
}

export function decideQuestions(questions: readonly Question[], jev: JevAnswers, cfg: Config): Decision {
  const stakes = (jev.stakes as NoulAnswer | undefined)?.noul ?? 1
  const answers: Record<string, string> = {}
  let confidence = 1
  let missing = false

  questions.forEach((q, i) => {
    if (q.options.length === 0) return void (missing = true)
    if (q.multiSelect) {
      const picked: string[] = []
      q.options.forEach((o, j) => {
        const p = (jev[`q${i}_o${j}`] as NoulAnswer | undefined)?.noul
        if (p === undefined) return void (missing = true)
        if (p >= 0.5) picked.push(o.label)
        confidence = Math.min(confidence, Math.abs(2 * p - 1))
      })
      answers[q.question] = picked.join(', ')
    } else {
      const a = jev[`q${i}`] as ChoiceAnswer | undefined
      const j = a ? Number(a.choice.slice(1)) : NaN
      if (!a || !q.options[j]) return void (missing = true)
      answers[q.question] = q.options[j].label
      confidence = Math.min(confidence, a.confidence)
    }
  })

  if (stakes >= cfg.stakesThreshold) return { kind: 'escalate', reason: 'high-stakes', stakes, suggested: answers }
  if (missing) return { kind: 'escalate', reason: 'needs a free-text answer', stakes, suggested: answers }
  return { kind: 'auto', answers, confidence, stakes, review: confidence < cfg.minConfidence }
}

// ---------------------------------------------------------------- tool calls

export function toolSummary(tool: string, input: Record<string, unknown>) {
  if (typeof input.command === 'string') return `${tool}: ${clip(input.command, 400)}`
  if (typeof input.file_path === 'string') return `${tool}: ${input.file_path}`
  if (typeof input.url === 'string') return `${tool}: ${input.url}`
  return `${tool}: ${clip(JSON.stringify(input), 300)}`
}

// Tools that only read or look things up: never screened.
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskList', 'TaskGet',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Skill',
])
export const isReadOnlyTool = (tool: string) => READ_ONLY_TOOLS.has(tool)

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// What the call DOES, without the content it writes: code being written is full
// of words like "delete" or "secret" that say nothing about the action itself.
export function describeAction(tool: string, input: Record<string, unknown>, cwd: string, tempRoots?: readonly string[]) {
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
  const where = (f: string) => (norm(f).startsWith(norm(cwd) + '/') ? 'inside the project directory' : 'OUTSIDE the project directory')
  if (typeof input.command === 'string') {
    const cmd = input.command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, (_m, tag: string) => `<<${tag} …(text written to a file)… ${tag}`)
    return `Run this shell command: ${clip(tempCleanup(cmd, tempRoots).command, 1500)}`
  }
  if (tool === 'Edit' && path) return `Edit part of an existing file (${where(path)}): ${path}`
  if (tool === 'Write' && path) return `Write a file, creating it or replacing its whole content (${where(path)}): ${path}`
  if (tool === 'NotebookEdit' && path) return `Edit a cell in a notebook (${where(path)}): ${path}`
  return `Call tool "${tool}" with: ${clip(JSON.stringify(input), 600)}`
}

// What is NOT outward-facing: the owner's own machine, repos and chat. Integrations add
// their own internal coordination (see FIRSTMATE_INTERNAL) only when they are detected.
const NOT_OUTWARD = [
  'local work',
  'ordinary network use like downloading packages or reading docs',
  "the owner's own private repos (pushes, PRs and merges on repos the owner owns)",
  "messages to the owner (e.g. the owner's own Telegram bot chat)",
  "local services on the owner's own machine or private network",
]

// Firstmate steering its own workers is internal, never outward.
export const FIRSTMATE_INTERNAL =
  "firstmate's internal coordination with its own workers (bin/fm-send.sh and other bin/fm-*.sh scripts, tmux steering of its workers, no-mistakes runs)"

export type ToolRequestOptions = {
  // Extra things that count as internal rather than outward, appended to Jev's criteria.
  internal?: readonly string[]
  // Scratch roots recognised by `tempCleanup` (see TEMP_ROOTS).
  tempRoots?: readonly string[]
}

export function buildToolRequest(tool: string, input: Record<string, unknown>, task: string, cwd: string, opts: ToolRequestOptions = {}) {
  const state = [
    `A coding agent working in ${cwd} is about to take this action:`,
    describeAction(tool, input, cwd, opts.tempRoots),
    `(The user's current request: ${clip(task, 600) || 'none given'})`,
    'Normal edits to files in a project under git are recoverable and are not destructive.',
    'Removing a temporary scratch directory the agent or its tools created (shown as <temporary scratch dir>) is routine cleanup, not destructive.',
  ].join('\n')
  const notOutward = [...NOT_OUTWARD, ...(opts.internal ?? [])].join('; ')
  return {
    model: 'jev-latest',
    state,
    questions: {
      destructive: {
        type: 'noul',
        instructions: 'Would this action permanently destroy or irreversibly overwrite something that cannot easily be recovered?',
        criteria: {
          true: 'Yes: e.g. deleting directories or files outside version control, rm -rf, force-pushing or rewriting git history, git reset --hard on unsaved work, dropping or truncating databases, wiping or overwriting production data or config outside the project',
          false: 'No: reading, building, testing, installing, normal git commits, creating/editing files in the project (recoverable), or deleting temporary scratch directories',
        },
      },
      outward: {
        type: 'noul',
        instructions: 'Does this action expose something to OTHER people or the open internet: sending secrets or private data to third parties, publishing or deploying publicly, messaging other people, posting on repos the owner does not own, or spending money?',
        criteria: {
          true: 'Yes: uploading credentials or private data to a third party, publishing a package or deploying publicly, emailing, posting or messaging other people, opening public PRs, issues or comments on repos the owner does not own, making purchases',
          false: `No: ${notOutward}`,
        },
      },
    },
  }
}

export type Verdict = { risk: 'safe' | 'destructive' | 'outward'; pDanger: number; hold: boolean }

export function judgeTool(jev: JevAnswers, cfg: Config): Verdict {
  const d = (jev.destructive as NoulAnswer | undefined)?.noul ?? 0
  const o = (jev.outward as NoulAnswer | undefined)?.noul ?? 0
  const pDanger = Math.max(d, o)
  const risk = pDanger < 0.25 ? 'safe' : d >= o ? 'destructive' : 'outward'
  return { risk, pDanger, hold: pDanger >= cfg.holdThreshold }
}

// ---------------------------------------------------------------- context

type Msg = { role: string; content: readonly { type: string; text?: string }[] | string }

const textOf = (m: Msg) =>
  (typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n')).trim()

export function lastUserText(messages: readonly Msg[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const t = m.role === 'user' ? textOf(m) : ''
    if (t && !t.startsWith('<')) return t
  }
  return ''
}

export function conversationContext(messages: readonly Msg[], questions: readonly Question[], cwd: string, maxChars = 6000) {
  const lines = messages.slice(-10).map(m => [m.role, textOf(m)] as const).filter(([, t]) => t)
  let convo = lines.map(([r, t]) => `${r.toUpperCase()}: ${t}`).join('\n\n')
  if (convo.length > maxChars) convo = '…' + convo.slice(-maxChars)
  const asked = questions.map(q => `${q.question}\n${q.options.map(o => `- ${optionText(o)}`).join('\n')}`).join('\n\n')
  return `Project: ${cwd}\n\nRecent conversation:\n${convo}\n\nThe agent is asking:\n${asked}`
}

// ---------------------------------------------------------------- telegram

export const esc = (s: string) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)

export function buttonsMessage(title: string, body: string, labels: readonly string[], reqId: string, slot: number) {
  return {
    text: `${title}\n\n${body}\n\nTap a button, or reply to this message with directions.`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: labels.map((l, j) => [{ text: clip(l, 60), callback_data: `${reqId}:${slot}:${j}` }]),
    },
  }
}

export function questionMessage(q: Question, slot: number, reqId: string, reason: string, project: string, suggested?: string) {
  const opts = q.options.map((o, j) => `${j + 1}. <b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ''}`)
  const body = [esc(q.question), '', ...opts, suggested ? `\nJev leans: <i>${esc(suggested)}</i>` : ''].join('\n')
  return buttonsMessage(`🤖 <b>Decision needed</b> (${esc(reason)}) · <code>${esc(project)}</code>`, body, q.options.map(o => o.label), reqId, slot)
}

export function holdMessage(summary: string, v: Verdict, project: string, reqId: string) {
  const body = `<pre>${esc(clip(summary, 900))}</pre>\nJev: <b>${v.risk}</b> (danger ${v.pDanger.toFixed(2)})`
  return buttonsMessage(`⚠️ <b>Tool call on hold</b> · <code>${esc(project)}</code>`, body, ['✅ Proceed', '❌ Block'], reqId, 0)
}

export type TgChat = { id: number; type?: string; first_name?: string; username?: string; title?: string }

export type TgUpdate = {
  update_id: number
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: TgChat } }
  message?: { message_id: number; text?: string; chat: TgChat; reply_to_message?: { message_id: number } }
}

export type Inbound =
  | { kind: 'button'; reqId: string; slot: number; option: number; callbackId: string; messageId?: number }
  | { kind: 'reply'; replyTo: number; text: string; messageId: number }
  | { kind: 'text'; text: string; messageId: number }
  | { kind: 'command'; command: string; args: string; messageId: number }
  | { kind: 'pairing'; chatId: string; text: string; private: boolean; who: string }

// Classifies one update. Anything not from the paired chat is only useful as a
// pairing attempt (and only from a private chat); everything else from strangers is dropped.
export function classify(u: TgUpdate, chatId: string | undefined): Inbound | undefined {
  const cb = u.callback_query
  if (cb?.data && chatId && String(cb.message?.chat.id) === chatId) {
    const [reqId = '', slot, option] = cb.data.split(':')
    return { kind: 'button', reqId, slot: Number(slot), option: Number(option), callbackId: cb.id, messageId: cb.message?.message_id }
  }
  const m = u.message
  if (!m?.text) return undefined
  if (!chatId || String(m.chat.id) !== chatId) {
    const who = m.chat.username ? `@${m.chat.username}` : m.chat.first_name ?? m.chat.title ?? String(m.chat.id)
    return { kind: 'pairing', chatId: String(m.chat.id), text: m.text.trim(), private: m.chat.type === 'private', who }
  }
  if (m.reply_to_message) return { kind: 'reply', replyTo: m.reply_to_message.message_id, text: m.text, messageId: m.message_id }
  const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(m.text.trim())
  if (cmd) return { kind: 'command', command: cmd[1]!.toLowerCase(), args: cmd[2] ?? '', messageId: m.message_id }
  return { kind: 'text', text: m.text, messageId: m.message_id }
}

// `held` marks a verdict on a held tool call: a notice, not a message that wants an answer.
export type InboxItem = { messageId: number; text: string; at: number; note?: string; held?: boolean }

export const tgReplyNote = (owner = DEFAULT_OWNER) =>
  `Your final reply this turn is sent back to ${owner} on Telegram: keep it short and phone-readable, and say what you did or are about to do.`

// The Telegram message a turn's reply answers: the latest one the owner wrote in person.
export function replyTarget(items: readonly InboxItem[]) {
  return items.filter(i => !i.held).at(-1)?.messageId
}

export function inboxPrompt(items: readonly InboxItem[], owner = DEFAULT_OWNER) {
  const body = items.map(i => (i.note ? `(${i.note}) ${i.text}` : i.text)).join('\n---\n')
  const note = replyTarget(items) === undefined ? '' : `\n${tgReplyNote(owner)}`
  return `Message${items.length > 1 ? 's' : ''} from ${owner} via Telegram (${owner} is away from the terminal; treat this as direction from them):${note}\n${body}`
}

// ---------------------------------------------------------------- replies to telegram

const TG_LIMIT = 4096
const TRUNCATED = '\n\n… (cut short; the full reply is in the terminal)'

// One markdown line's inline marks as Telegram HTML; code spans are escaped and left alone.
function inlineHtml(s: string) {
  return s.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`
    return esc(part)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?![*\w])/g, '$1<i>$2</i>')
  }).join('')
}

function lineHtml(line: string) {
  const heading = /^#{1,6}\s+(.*)$/.exec(line)
  if (heading) return `<b>${inlineHtml(heading[1]!)}</b>`
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
  if (bullet) return `${bullet[1]}• ${inlineHtml(bullet[2]!)}`
  return inlineHtml(line)
}

// Cuts raw text into pieces whose escaped, wrapped form fits `limit`, on line breaks where it can.
function splitPlain(text: string, limit: number, wrap: (html: string) => string) {
  const out: string[] = []
  let cur = ''
  const fits = (s: string) => wrap(esc(s)).length <= limit
  for (const line of text.split('\n')) {
    const next = cur ? `${cur}\n${line}` : line
    if (fits(next)) { cur = next; continue }
    if (cur) out.push(wrap(esc(cur)))
    cur = ''
    let rest = line
    while (!fits(rest)) {
      let n = limit - wrap('').length
      while (n > 1 && !fits(rest.slice(0, n))) n = Math.floor(n * 0.9)
      out.push(wrap(esc(rest.slice(0, n))))
      rest = rest.slice(n)
    }
    cur = rest
  }
  if (cur) out.push(wrap(esc(cur)))
  return out
}

// The words of a Telegram HTML message, for resending it without parse mode.
export const plainText = (html: string) =>
  html.replace(/<[^>]+>/g, '').replace(/&(lt|gt|quot|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e]!)

// A session's markdown reply as Telegram HTML messages, each within Telegram's length
// limit; past `maxMessages` the rest is cut with a note pointing at the terminal.
export function telegramReply(markdown: string, limit = TG_LIMIT, maxMessages = 4): string[] {
  const budget = limit - TRUNCATED.length
  const pre = (html: string) => `<pre>${html}</pre>`
  const pieces: string[] = []
  const lines = markdown.trim().split('\n')
  let para: string[] = []
  const flush = () => {
    const text = para.join('\n').trim()
    para = []
    if (!text) return
    const html = text.split('\n').map(lineHtml).join('\n')
    pieces.push(...(html.length <= budget ? [html] : splitPlain(text, budget, h => h)))
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!)
      if (code.length) pieces.push(...splitPlain(code.join('\n'), budget, pre))
    } else if (!line.trim()) flush()
    else para.push(line)
  }
  flush()

  const messages: string[] = []
  for (const p of pieces) {
    const last = messages.at(-1)
    if (last !== undefined && last.length + 2 + p.length <= budget) messages[messages.length - 1] = `${last}\n\n${p}`
    else messages.push(p)
  }
  if (messages.length <= maxMessages) return messages
  const kept = messages.slice(0, maxMessages)
  kept[maxMessages - 1] += TRUNCATED
  return kept
}

// ---------------------------------------------------------------- firstmate

// Which part of a Firstmate fleet this session is: the captain-facing primary,
// a crewmate (ship/scout pane), Firstmate's headless supervision host, or none.
export type Role = 'captain' | 'worker' | 'supervisor' | 'solo'

export function roleOf(env: { taskId?: string; supervisionActor?: string }, isFirstmateHome: boolean): Role {
  if (env.supervisionActor) return 'supervisor'
  if (env.taskId) return 'worker'
  return isFirstmateHome ? 'captain' : 'solo'
}

export type FmHold = { id: string; title: string; reason: string; body: string; prUrl?: string; key: string }

type SnapshotRecord = {
  id?: string | null
  title?: string | null
  hold_kind?: string | null
  hold_reason?: string | null
  captain_actionable?: boolean
  pr_url?: string | null
  body_lines?: string[]
  body_excerpt?: string | null
}

// A tiny stable hash so a task re-held with a new reason counts as a new call.
const hash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// Open captain calls from `bin/fm-fleet-snapshot.sh --json`.
export function fmHoldsFrom(snapshot: { backlog?: { records?: SnapshotRecord[] } }): FmHold[] {
  return (snapshot.backlog?.records ?? [])
    .filter(r => r.hold_kind === 'captain' && r.captain_actionable === true && r.id)
    .map(r => {
      const reason = r.hold_reason ?? ''
      return {
        id: r.id!,
        title: r.title ?? r.id!,
        reason,
        body: (r.body_lines ?? []).join('\n') || (r.body_excerpt ?? ''),
        prUrl: r.pr_url ?? undefined,
        key: `${r.id}:${hash(reason)}`,
      }
    })
}

// Calls Jev is never allowed to take for the owner, whatever it scores.
const ALWAYS_HUMAN = /\b(delet|drop|destroy|wipe|irreversib|secur|credential|secret|token|password|prod(uction)?\b|force[- ]?push|billing|payment|money|legal|licen[cs]e|public(ly)?|announce|customer data)/i

export function buildFmHoldRequest(h: FmHold) {
  const state = [
    'Firstmate (an AI engineering lead) has paused and is waiting on the human captain for this decision.',
    `Title: ${h.title}`,
    `Question / options: ${clip(h.reason, 1500)}`,
    h.body ? `Details:\n${clip(h.body, 3000)}` : '',
    h.prUrl ? `Pull request: ${h.prUrl}` : '',
  ].filter(Boolean).join('\n')
  return {
    model: 'jev-latest',
    state,
    questions: {
      stakes: STAKES_QUESTION,
      accept: {
        type: 'noul',
        instructions: "Should firstmate simply proceed with its own recommendation (or the obvious in-scope option)?",
        criteria: {
          true: 'The recommendation is clear, in scope, low-risk and consistent with what was asked for',
          false: 'The choice is genuinely ambiguous, expands scope, or needs the human to weigh trade-offs',
        },
      },
    },
  }
}

export type FmDecision =
  | { kind: 'auto'; confidence: number; stakes: number }
  | { kind: 'escalate'; reason: string; stakes: number; lean: 'approve' | 'decline' }

export function decideFmHold(h: FmHold, jev: JevAnswers, cfg: Config): FmDecision {
  const stakes = (jev.stakes as NoulAnswer | undefined)?.noul ?? 1
  // Confidence is Jev's own probability that approving is right, held to minConfidence as-is.
  const accept = (jev.accept as NoulAnswer | undefined)?.noul ?? 0
  const confidence = accept
  const lean = accept >= 0.5 ? 'approve' : 'decline'
  if (ALWAYS_HUMAN.test(`${h.title}\n${h.reason}\n${h.body}`)) return { kind: 'escalate', reason: 'sensitive', stakes, lean }
  if (stakes >= cfg.stakesThreshold) return { kind: 'escalate', reason: 'high-stakes', stakes, lean }
  if (accept < 0.5) return { kind: 'escalate', reason: 'Jev would not approve it', stakes, lean }
  if (confidence < cfg.minConfidence) return { kind: 'escalate', reason: 'Jev unsure', stakes, lean }
  return { kind: 'auto', confidence, stakes }
}

export const FM_LABELS = ['✅ Approve recommendation', '❌ Decline'] as const

export function fmButtonAnswer(option: number) {
  return option === 0
    ? 'Approved: proceed with your recommendation.'
    : 'Declined: do not proceed with this. Hold off and propose an alternative.'
}

export function fmHoldMessage(h: FmHold, reason: string, lean: string, project: string, reqId: string) {
  const body = [
    `<b>${esc(h.title)}</b>`,
    '',
    esc(clip(h.reason, 1200)),
    h.body ? `\n<i>${esc(clip(h.body, 1200))}</i>` : '',
    h.prUrl ? `\nPR: ${esc(h.prUrl)}` : '',
    `\nJev leans: <i>${lean}</i>`,
  ].join('\n')
  return buttonsMessage(`⚓ <b>Firstmate needs the captain</b> (${esc(reason)}) · <code>${esc(project)}</code>`, body, [...FM_LABELS], reqId, 0)
}

// One line for `fm-captain-hold.sh answers` stdin: id, answer, label, mode.
export function fmAnswerLine(id: string, answer: string, label: string, mode: 'done' | 'release') {
  const flat = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim()
  return `${flat(id)}\t${flat(answer)}\t${flat(label)}\t${mode}\n`
}

// ---------------------------------------------------------------- keep going

// Standing instructions while autopilot is on: a pending decision parks one
// piece of work, never the whole session.
export function autopilotPrompt(role: Role, owner = DEFAULT_OWNER) {
  const common = [
    `AUTOPILOT IS ON: ${owner} is away from the terminal and wants work to keep moving unattended.`,
    `- Never end your turn just to wait for ${owner} while any other planned, requested or backlog work can proceed.`,
    `- When something needs ${owner}'s decision, ask it with the AskUserQuestion tool (it reaches ${owner}'s phone, or an automated decision model answers it) and then immediately continue with other work: other features, UI, bug fixes, tests, docs, cleanup from the plan or backlog.`,
    '- Park only the work that truly depends on the open decision. Answers arrive later as messages; pick that work back up then.',
    `- Stop only when everything remaining is blocked on ${owner}'s answers or genuinely done; then end with a short summary of what is waiting on ${owner}.`,
    `- Never contact ${owner} directly (Telegram, email, chat apps) and never read the jev-autopilot plugin's credentials, settings or stored data: the jev-autopilot plugin relays questions, approvals and updates for you.`,
  ]
  if (role === 'captain') {
    common.push(
      '- As firstmate: hold captain calls as usual, but keep dispatching and supervising every other task in the backlog while they wait. A held call parks its own task, not the fleet.',
    )
  }
  if (role === 'worker') {
    return `AUTOPILOT IS ON. As a crewmate, never wait idle on a decision: report it to firstmate as needs-decision and keep working on any part of your brief that does not depend on it. Never contact ${owner} directly or read the jev-autopilot plugin's credentials or stored data.`
  }
  return common.join('\n')
}

// The one-line notice a session gets when autopilot's state differs from what it last
// saw (`seen` undefined: nothing seen yet, so only an ON state is worth a line).
export function stateNotice(seen: boolean | undefined, enabled: boolean, owner = DEFAULT_OWNER) {
  if (seen === enabled || (seen === undefined && !enabled)) return undefined
  if (!enabled) return `jev-autopilot: autopilot is now OFF for every session on this machine - ${owner} is back at the terminal.`
  return `jev-autopilot: autopilot is ${seen === undefined ? '' : 'now '}ON for every session on this machine - ${owner} is away; decide what you can and ask only true decisions.`
}

// Did the turn end waiting on the owner while other work could still proceed?
export function buildStallRequest(finalMessage: string, request: string) {
  return {
    model: 'jev-latest',
    state: `The user's request to the coding agent:\n${clip(request, 1500) || '(unknown)'}\n\nThe agent ended its turn with this message:\n${clip(finalMessage, 3000)}`,
    questions: {
      done: {
        type: 'noul',
        instructions: 'Is all of the requested and planned work actually finished?',
        criteria: { true: 'Everything asked for is complete', false: 'Some requested or planned work is not finished yet' },
      },
      asksHuman: {
        type: 'noul',
        instructions: 'Is the agent asking the user for an answer, approval, choice or input before it can continue?',
        criteria: {
          true: 'Yes: it ends with a question or request directed at the user, or says it is waiting on them',
          false: 'No: it is a status update, a report, or a summary that asks the user for nothing',
        },
      },
      proceedable: {
        type: 'noul',
        instructions: 'Is there unfinished work the agent could keep doing right now without waiting for the user’s answer or approval?',
        criteria: {
          true: 'Yes: other tasks, features, fixes or steps remain that do not depend on the pending question',
          false: 'No: everything left depends on the user, or nothing is left',
        },
      },
    },
  }
}

export function decideStall(jev: JevAnswers) {
  const done = (jev.done as NoulAnswer | undefined)?.noul ?? 1
  const proceedable = (jev.proceedable as NoulAnswer | undefined)?.noul ?? 0
  const asksHuman = (jev.asksHuman as NoulAnswer | undefined)?.noul ?? 0
  return {
    nudge: done < 0.5 && proceedable >= 0.5,
    done,
    proceedable,
    asksHuman,
    // What to tell the owner when not nudging: only a clear finish, or a real question for them.
    notice: done >= 0.7 ? ('finished' as const) : asksHuman >= 0.5 && proceedable < 0.5 ? ('waiting' as const) : undefined,
  }
}

export const NUDGE_PREFIX = 'Autopilot keep-going:'

export function nudgeText(owner = DEFAULT_OWNER) {
  return `${NUDGE_PREFIX} ${owner} is away, so don't wait on ${owner}. Make sure anything that needs ${owner}'s decision has been asked with AskUserQuestion, park only the work that depends on it, and continue with the remaining work (other features, UI, bug fixes, tests from the plan or backlog). Stop only when everything left is blocked on ${owner}'s answers, then summarize what is waiting.`
}

// A stable key for one exact tool call, so an approved call can run once, in the
// session and project it was held in and nowhere else. The free-text description is
// left out: a retried call may word it differently.
export function toolKey(tool: string, input: Record<string, unknown>, scope: { sid: string; cwd: string }) {
  const { description: _d, timeout: _t, run_in_background: _b, ...rest } = input
  return `${scope.sid}:${hash(norm(scope.cwd))}:${tool}:${hash(JSON.stringify(rest))}`
}

// A phone approval: stored under `allow:<key>` and good until `until` (telegramWaitMinutes).
export type Approval = { until: number }

export const approvalValid = (a: unknown, now: number): a is Approval =>
  typeof a === 'object' && a !== null && typeof (a as Approval).until === 'number' && (a as Approval).until > now

// ---------------------------------------------------------------- progress notices

export type FmLanded = { id: string; title: string; verb: string; prUrl?: string }

type DoneRecord = {
  id?: string | null
  title?: string | null
  state?: string | null
  structured?: boolean
  pr_url?: string | null
  completion?: { verb?: string | null } | null
}

// Tasks Firstmate has moved to Done (merged, reported or done).
export function fmLandedFrom(snapshot: { backlog?: { records?: DoneRecord[] } }): FmLanded[] {
  return (snapshot.backlog?.records ?? [])
    .filter(r => r.structured && r.state === 'done' && r.id)
    .map(r => ({ id: r.id!, title: r.title ?? r.id!, verb: r.completion?.verb ?? 'done', prUrl: r.pr_url ?? undefined }))
}

export function landedMessage(l: FmLanded, project: string) {
  const verb = l.verb === 'merged' ? 'merged' : l.verb === 'reported' ? 'reported' : 'done'
  return `✅ <b>Landed</b> (${verb}) · <code>${esc(project)}</code>\n${esc(l.title)}${l.prUrl ? `\n${esc(l.prUrl)}` : ''}`
}

export function finishedMessage(kind: 'finished' | 'waiting', project: string, finalMessage: string) {
  const head = kind === 'finished'
    ? `🏁 <b>Finished</b> · <code>${esc(project)}</code>`
    : `⏸ <b>Everything remaining is waiting on you</b> · <code>${esc(project)}</code>`
  return `${head}\n\n${esc(clip(finalMessage.trim(), 900))}`
}

// ---------------------------------------------------------------- fleet state

// Firstmate's chat mentions every project in the fleet, paused ones included, so
// "is anything waiting on the owner" is read from its structured backlog instead.
type FleetRecord = {
  title?: string | null
  id?: string | null
  structured?: boolean
  current_role?: string | null
  hold_kind?: string | null
  captain_actionable?: boolean
}

export type FleetState = { running: string[]; waitingOnYou: string[] }

export function fmFleetState(snapshot: { backlog?: { records?: FleetRecord[] } }): FleetState {
  const rows = (snapshot.backlog?.records ?? []).filter(r => r.structured)
  const name = (r: FleetRecord) => r.title ?? r.id ?? '?'
  return {
    running: rows.filter(r => r.current_role === 'worker' || r.current_role === 'program').map(name),
    waitingOnYou: rows.filter(r => r.hold_kind === 'captain' && r.captain_actionable === true).map(name),
  }
}

// One notice per run: when the last running task lands. Open decisions (including
// paused projects') are listed, not announced on their own: each one already
// reached the owner as its own Telegram prompt when it was raised.
export function fleetNotice(prevRunning: number | undefined, s: FleetState): 'finished' | undefined {
  return prevRunning !== undefined && prevRunning > 0 && s.running.length === 0 ? 'finished' : undefined
}

export function fleetMessage(project: string, s: FleetState) {
  const open = s.waitingOnYou.slice(0, 8).map(t => `• ${esc(t)}`).join('\n')
  return `🏁 <b>Finished</b> · <code>${esc(project)}</code>\nAll running work has landed.` +
    (open ? `\n\nStill waiting on you:\n${open}` : '\nNothing is waiting on you.')
}

// ---------------------------------------------------------------- temp cleanup

// Throwaway places a tool's own scratch space lives: deleting inside them is cleanup.
// A root starting with `~/` also matches `$HOME/` and any absolute home directory.
export const TEMP_ROOTS: readonly string[] = ['/tmp/', '/private/tmp/', '/var/folders/']

// Scratch roots of Firstmate's no-mistakes pipeline, added only when Firstmate is detected.
export const FIRSTMATE_TEMP_ROOTS: readonly string[] = ['~/.no-mistakes/worktrees/', '~/.no-mistakes/evidence/']

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One root as a regex anchored at the start of a path.
function rootPattern(root: string) {
  const r = root.endsWith('/') ? root : `${root}/`
  if (r.startsWith('~/')) return new RegExp(`^(?:~|\\$\\{?HOME\\}?|/.+?)/${escapeRe(r.slice(2))}`)
  return new RegExp(`^${escapeRe(r)}`)
}

const patterns = new Map<string, RegExp>()
const rootRe = (root: string) => {
  let re = patterns.get(root)
  if (!re) patterns.set(root, (re = rootPattern(root)))
  return re
}

// Splits a shell command into top-level segments, keeping the separators.
const SEGMENT = /([^;&|\n]+)([;&|\n]+|$)/g

function unquote(s: string) {
  return s.replace(/^['"]|['"]$/g, '')
}

// Is one rm target clearly a temporary path? `vars` are names assigned from mktemp.
function isTempTarget(raw: string, vars: ReadonlySet<string>, roots: readonly string[]) {
  const t = unquote(raw)
  if (!t || t.includes('..')) return false
  const v = /^\$\{?(\w+)\}?(\/.*)?$/.exec(t)
  if (v) {
    if (vars.has(v[1]!)) return true
    if (v[1] === 'TMPDIR') return !!v[2] && /\/[^/*\s]+/.test(v[2])
  }
  const root = roots.find(r => rootRe(r).test(t))
  if (!root) return false
  // something below the root, and not just a wildcard: never /tmp/ or /tmp/*
  const below = t.replace(rootRe(root), '')
  return below.length > 0 && !/^\*+\/?$/.test(below)
}

// An rm segment whose every target is temporary.
function isTempRm(segment: string, vars: ReadonlySet<string>, roots: readonly string[]) {
  const words = segment.trim().split(/\s+/)
  let i = 0
  if (words[i] === 'command' || words[i] === 'sudo') i++
  if (words[i] !== 'rm' && words[i] !== '/bin/rm') return false
  const targets = words.slice(i + 1).filter(w => !w.startsWith('-'))
  return targets.length > 0 && targets.every(t => isTempTarget(t, vars, roots))
}

// Rewrites temp-dir cleanup inside a command so screening sees it for what it is.
// `onlyCleanup` is true when nothing else of consequence remains.
export function tempCleanup(command: string, roots: readonly string[] = TEMP_ROOTS) {
  const vars = new Set([...command.matchAll(/(\w+)=\$\(\s*mktemp\b/g)].map(m => m[1]!))
  let cleaned = 0
  const rewritten = command.replace(SEGMENT, (all, seg: string, sep: string) => {
    if (!isTempRm(seg, vars, roots)) return all
    cleaned++
    return ` rm -rf <temporary scratch dir>${sep}`
  })
  const rest = rewritten
    .replace(SEGMENT, (all, seg: string) => (/^\s*(rm -rf <temporary scratch dir>|cd\s+\S+|true|:|echo\b.*|[A-Za-z_]\w*=\$\(\s*mktemp\b[^)]*\))\s*$/.test(seg) ? '' : all))
    .replace(/[;&|\n\s]/g, '')
  return { command: rewritten, cleaned, onlyCleanup: cleaned > 0 && rest === '' }
}

// ---------------------------------------------------------------- firstmate internal

// Firstmate's own coordination scripts: steering its workers is internal, never outward.
const FM_INTERNAL_SCRIPTS = new Set(['fm-send.sh', 'fm-wake-drain.sh'])

// Is `word` (possibly quoted) one of the internal scripts in `home`'s bin/?
function isFmScript(word: string, home: string) {
  const w = unquote(word)
  const m = /^(?:(.*)\/)?bin\/(fm-[\w-]+\.sh)$/.exec(w)
  if (!m || !FM_INTERNAL_SCRIPTS.has(m[2]!)) return false
  const dir = m[1]
  return dir === undefined || dir === '.' || norm(dir) === norm(home)
}

// True when a shell command does nothing but run firstmate's internal scripts from
// its home. Fails closed: anything that could expand or run something else is screened.
export function fmInternal(command: string, home: string) {
  if (!home || command.includes('\u0000')) return false
  // Quoted text with no expansion is inert: set it aside so separators inside it don't count.
  const quoted: string[] = []
  const bare = command.replace(/'[^']*'|"[^"$`\\]*"/g, q => `\u0000${quoted.push(q) - 1}\u0000`)
  if (/['"]/.test(bare)) return false
  const segments = bare.split(/&&|;|\n/).map(s => s.trim()).filter(Boolean)
  if (!segments.length) return false
  return segments.every(seg => {
    const [word = '', ...args] = seg.split(/\s+/)
    const script = word.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => quoted[Number(n)]!)
    return isFmScript(script, home) && args.every(a => /^(?:[\w./@%+=:,-]|\u0000\d+\u0000)*$/.test(a))
  })
}
