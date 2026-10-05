import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import {
  buildFmHoldRequest, buildQuestionRequest, DEFAULTS, DEFAULT_OWNER, buildToolRequest, classify, conversationContext, decideFmHold,
  decideQuestions, esc, fmAnswerLine, fmButtonAnswer, fmHoldMessage, fmHoldsFrom, FM_LABELS, holdMessage,
  inboxPrompt, isReadOnlyTool, judgeTool, lastUserText, questionMessage, roleOf, toolSummary,
  autopilotPrompt, buildStallRequest, decideStall, nudgeText, NUDGE_PREFIX, toolKey, approvalValid,
  finishedMessage, fmLandedFrom, landedMessage, fleetMessage, fleetNotice, fmFleetState, fmInternal, tempCleanup, stateNotice,
  plainText, replyTarget, telegramReply, tgReplyNote, TEMP_ROOTS, FIRSTMATE_TEMP_ROOTS, FIRSTMATE_INTERNAL,
} from './core'
import type { FmHold, InboxItem, JevAnswers, Question, Role, TgUpdate } from './core'
import {
  detectFirstmate, modeIsPrivate, newPairCode, parseEnvFile, redact, scriptsClean, showPairCode, tryPair, SECRETS_FILE, PAIR_ATTEMPTS,
} from './trust'
import type { FmProbe, PairCode } from './trust'

type $ = EngineInterface

const WORKER_ESCALATE =
  'You are a Firstmate crewmate: report it to firstmate by appending a needs-decision line to your task status file, ' +
  'as your brief describes (needs-decision [at=<epoch>]: <what you want to do, why, and the options>), then wait for its answer.'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const TG = 'https://api.telegram.org/bot'

// A prompt we sent and are (or were) waiting on: one slot per question/button row.
// `fm` marks a Firstmate captain call, answered through Firstmate's own intake.
type Pending = {
  slots: { question: string; labels: string[] }[]
  answers: Record<number, string>
  fm?: { id: string; mode: 'done' | 'release' }
  // Set on a held tool call: the key that lets that exact call run once approved.
  tool?: string
  // The session that asked, so the answer is delivered there and not to the listener.
  sid?: string
}

let cfg = {
  minConfidence: 0.5,
  stakesThreshold: 0.5,
  holdThreshold: 0.65,
  waitMs: 30 * 60_000,
  ownerName: DEFAULT_OWNER,
  tempRoots: TEMP_ROOTS as readonly string[],
  firstmateRemotes: [] as readonly string[],
}

// Module state: rebuilt on reload, which only drops in-flight waits.
const pending = new Map<string, Pending>()
const sentMsg = new Map<number, { reqId: string; slot: number }>()
let waiting = 0
let ticking = false
let turnId: string | undefined
let lastTool = ''
let submittedAt = 0
let ticks = 0
let role: Role | undefined
let fmReason = '' // why the cwd is not a Firstmate home, for /autopilot status
let toolCalls = 0 // main-loop tool calls in the current turn
let nudges = 0 // keep-going nudges since the owner last typed a prompt
let lastStallCheck = 0
let lastAnswer = '' // final message of the last main-loop turn
let lastCompleteAt = 0
let lastTurnEnded: string | undefined
let checkedTurn: string | undefined // last turn already checked for a stall
let sid: string | undefined // this session's id
let lastWaitingNoticeAt = 0
let fleetRunning: number | undefined // running Firstmate tasks at the last snapshot; undefined until first read
let lastEndNotice = '' // last finished/waiting notice sent, to avoid repeats
// Telegram replies: inbox prompts submitted but not yet started, and the message the
// current turn answers (0: from Telegram, but which message is unknown after a reload).
const tgPrompts: { text: string; replyTo: number }[] = []
let replyTo: number | undefined
let relayed = '' // the last answer already sent back to Telegram

const owner = () => cfg.ownerName

// ------------------------------------------------------------ secrets

// Secrets come from a file only the owner can read (SECRETS_FILE), then from the
// process environment. The file is re-read when its modification time changes.
let secretsCache: { mtimeMs: number; values: Record<string, string>; ignoredMode?: string } | undefined
let secretsWarned = ''

async function homeDir($: $) {
  return ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.').replace(/\\/g, '/')
}
async function secretsPath($: $) {
  return SECRETS_FILE.replace('~', await homeDir($))
}

// The file's mode as octal text, from `stat` (BSD then GNU spelling); undefined where neither works.
async function fileMode($: $, path: string) {
  for (const argv of [['stat', '-f', '%Lp', path], ['stat', '-c', '%a', path]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 5_000 })
      if (r.exitCode === 0 && /^[0-7]{3,4}\s*$/.test(r.stdout)) return r.stdout.trim()
    } catch {}
  }
  return undefined
}

async function fileSecrets($: $): Promise<Record<string, string>> {
  const path = await secretsPath($)
  let mtimeMs: number
  try {
    const st = await $.fs.stat(path)
    if (st.kind !== 'file') throw new Error('not a file')
    mtimeMs = st.mtimeMs
  } catch {
    secretsCache = undefined
    return {}
  }
  // An ignored file is checked again each time: `chmod 600` does not change its mtime.
  if (secretsCache?.mtimeMs === mtimeMs && !secretsCache.ignoredMode) return secretsCache.values
  let values: Record<string, string> = {}
  let ignoredMode: string | undefined
  const mode = await fileMode($, path)
  if (mode !== undefined && modeIsPrivate(mode) === false) {
    ignoredMode = mode
    const key = `${mode}:${mtimeMs}`
    if (secretsWarned !== key) {
      secretsWarned = key
      $.ui.toast(`autopilot: ignoring ${SECRETS_FILE} (mode ${mode}); run chmod 600 on it`)
    }
  } else {
    try { values = parseEnvFile(await $.fs.read(path)) } catch {}
  }
  secretsCache = { mtimeMs, values, ignoredMode }
  return values
}

type SecretName = 'TELEGRAM_BOT_TOKEN' | 'TYPESAFE_API_KEY' | 'TELEGRAM_CHAT_ID'

// (`$.env.get` wants a literal name, so the variables a module reads can be listed.)
function envSecret($: $, name: SecretName) {
  switch (name) {
    case 'TELEGRAM_BOT_TOKEN': return $.env.get('TELEGRAM_BOT_TOKEN')
    case 'TYPESAFE_API_KEY': return $.env.get('TYPESAFE_API_KEY')
    case 'TELEGRAM_CHAT_ID': return $.env.get('TELEGRAM_CHAT_ID')
  }
}
async function secret($: $, name: SecretName) {
  return (await fileSecrets($))[name] ?? (await envSecret($, name))
}
async function secretSource($: $, name: SecretName) {
  if ((await fileSecrets($))[name]) return 'file'
  return (await envSecret($, name)) ? 'env' : undefined
}
async function knownSecrets($: $) {
  return [await secret($, 'TELEGRAM_BOT_TOKEN'), await secret($, 'TYPESAFE_API_KEY')]
}

// ------------------------------------------------------------ firstmate

// git and file presence in the session's working directory, for the detector.
function probe($: $, cwd: string): FmProbe {
  return {
    exists: async path => {
      try {
        await $.fs.stat(path)
        return true
      } catch {
        return false
      }
    },
    git: async args => {
      try {
        const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 })
        return { exitCode: r.exitCode, stdout: r.stdout }
      } catch (err) {
        return { exitCode: 1, stdout: String(err) }
      }
    },
  }
}

// Decided once per load. A Firstmate home is a genuine Firstmate checkout (its remote,
// tracked and unmodified scripts), never just a folder holding the right file names.
async function getRole($: $) {
  if (role) return role
  const cwd = await $.session.cwd()
  let isHome = false
  try {
    const d = await detectFirstmate(probe($, cwd), cwd, cfg.firstmateRemotes)
    isHome = d.home
    fmReason = d.home ? '' : d.reason
  } catch (err) {
    fmReason = String(err).slice(0, 120)
  }
  // Firstmate exports FM_TASK_ID and FM_TASK_INBOX into every crewmate it launches.
  const taskId = (await $.env.get('FM_TASK_ID')) ?? (await $.env.get('FM_TASK_INBOX'))
  role = roleOf({ taskId, supervisionActor: await $.env.get('FM_SUPERVISION_ACTOR') }, isHome)
  return role
}

// Any Firstmate role: Firstmate's own scratch roots and internal coordination then count.
async function fmProfile($: $) {
  const fm = (await getRole($)) !== 'solo'
  return {
    internal: fm ? [FIRSTMATE_INTERNAL] : [],
    tempRoots: fm ? [...cfg.tempRoots, ...FIRSTMATE_TEMP_ROOTS] : cfg.tempRoots,
  }
}

// The path of a Firstmate script to run, checked again right now to be tracked and
// unmodified; undefined (and a note in the log) when it no longer is.
let scriptWarnedAt = 0
async function fmScript($: $, name: 'bin/fm-captain-hold.sh' | 'bin/fm-fleet-snapshot.sh') {
  const cwd = await $.session.cwd()
  const d = await scriptsClean(probe($, cwd))
  if (d.home) return `${cwd}/${name}`
  if (Date.now() - scriptWarnedAt > 10 * 60_000) {
    scriptWarnedAt = Date.now()
    $.ui.toast(`autopilot: not running Firstmate scripts (${d.reason})`)
    await log($, { by: 'jev', fmTask: name, outcome: `not run: ${d.reason}` })
  }
  return undefined
}

// Records an answer through Firstmate's single captain-answer intake, then wakes it.
async function resolveFm($: $, id: string, mode: 'done' | 'release', answer: string, source: 'jev' | 'telegram', label: string) {
  const cwd = await $.session.cwd()
  const script = await fmScript($, 'bin/fm-captain-hold.sh')
  if (!script) return false
  const r = await $.process.run([script, 'answers', '--any-origin', '--source', source], {
    cwd,
    stdin: fmAnswerLine(id, answer, label, mode),
  })
  const ok = r.exitCode === 0
  await log($, { by: source === 'jev' ? 'jev' : 'human-telegram', fmTask: id, answer, mode, outcome: ok ? 'recorded' : `intake failed: ${r.stderr.slice(0, 200)}` })
  if (!ok) {
    await say($, `⚠️ Could not record the answer for <code>${esc(id)}</code> in Firstmate: ${esc(r.stderr.slice(0, 300))}`)
    return false
  }
  const who = source === 'jev'
    ? `Jev (automated decision model) decided this under ${owner()}'s standing autopilot delegation; it is not ${owner()}'s own words`
    : `${owner()} answered this in person via Telegram`
  void $.prompt.submit({ text: `Captain call ${id} has been answered and recorded (${who}): "${answer}". Run your wake drain and continue.` })
  return true
}

// Tells the owner each time Firstmate moves a task to Done. The first read only records
// what is already done, so turning autopilot on doesn't replay the whole history.
async function notifyLanded($: $, snapshot: unknown) {
  const landed = fmLandedFrom(snapshot as never)
  const baselined = (await $.store.get('landedBaseline')) === true
  for (const l of landed) {
    if (await $.store.get(`landed:${l.id}`)) continue
    await $.store.set(`landed:${l.id}`, true)
    if (baselined) await say($, landedMessage(l, await project($)))
  }
  if (!baselined) await $.store.set('landedBaseline', true)
}

// Firstmate's finished notice, from its backlog rather than its chat (which covers the
// whole fleet, paused projects included). The first read after a load only records state.
async function notifyFleet($: $, snapshot: unknown) {
  const state = fmFleetState(snapshot as never)
  const kind = fleetNotice(fleetRunning, state)
  fleetRunning = state.running.length
  if (!kind) return
  await say($, fleetMessage(await project($), state))
  await log($, { by: 'jev', stall: true, done: 1, proceedable: 0, outcome: `told ${owner()}: finished (${state.waitingOnYou.length} decisions still open)` })
}

// One Telegram notice per distinct end state, so a quiet session doesn't repeat itself.
async function notifyEnd($: $, kind: 'finished' | 'waiting', finalMessage: string) {
  const key = `${kind}:${finalMessage.trim().slice(0, 200)}`
  if (key === lastEndNotice || finalMessage === relayed) return // the owner already has these words
  // "Waiting on you" at most every 20 minutes; a finish always gets through.
  if (kind === 'waiting' && Date.now() - lastWaitingNoticeAt < 20 * 60_000) return
  if (kind === 'waiting') lastWaitingNoticeAt = Date.now()
  lastEndNotice = key
  await say($, finishedMessage(kind, await project($), finalMessage))
  await log($, { by: 'jev', stall: true, done: kind === 'finished' ? 1 : 0, proceedable: 0, outcome: `told ${owner()}: ${kind}` })
}

// Checks Firstmate's open captain calls: Jev takes the clear low-stakes ones, the rest go to the phone.
async function checkFmHolds($: $) {
  const cwd = await $.session.cwd()
  const script = await fmScript($, 'bin/fm-fleet-snapshot.sh')
  if (!script) return
  const r = await $.process.run([script, '--json'], { cwd, timeoutMs: 20_000 })
  if (r.exitCode !== 0) return
  let holds: FmHold[]
  let snapshot
  try {
    snapshot = JSON.parse(r.stdout)
    holds = fmHoldsFrom(snapshot)
  } catch { return }
  await notifyLanded($, snapshot).catch(() => {})
  await notifyFleet($, snapshot).catch(() => {})

  for (const h of holds) {
    if (await $.store.get(`fm:${h.key}`)) continue
    await $.store.set(`fm:${h.key}`, 'seen')
    const mode = h.prUrl ? 'release' : 'done'

    let decision
    try {
      decision = decideFmHold(h, await jev($, buildFmHoldRequest(h)), cfg)
    } catch (err) {
      decision = { kind: 'escalate' as const, reason: `Jev unavailable: ${redact(String(err)).slice(0, 60)}`, stakes: 1, lean: 'approve' as const }
    }

    if (decision.kind === 'auto') {
      const answer = fmButtonAnswer(0)
      const label = `Decided by Jev under ${owner()}'s standing autopilot delegation (stakes ${decision.stakes.toFixed(2)}, confidence ${decision.confidence.toFixed(2)}) - not ${owner()}'s own words`
      if (await resolveFm($, h.id, mode, answer, 'jev', label)) {
        await say($, `🤖 Jev approved firstmate's call <b>${esc(h.title)}</b> (stakes ${decision.stakes.toFixed(2)}, conf ${decision.confidence.toFixed(2)}).`)
      }
      continue
    }

    const reqId = newReqId()
    const pend: Pending = { slots: [{ question: h.title, labels: [...FM_LABELS] }], answers: {}, fm: { id: h.id, mode } }
    await $.store.set(`prompt:${reqId}`, pend)
    const sent = await tg($, 'sendMessage', { chat_id: await tgChat($), ...fmHoldMessage(h, decision.reason, decision.lean, await project($), reqId) })
    await $.store.set(`msg:${sent.message_id}`, { reqId, slot: 0 })
    await log($, { by: 'jev', fmTask: h.id, outcome: `sent to Telegram (${decision.reason})`, stakes: decision.stakes, lean: decision.lean })
  }
}

// ------------------------------------------------------------ basics

const newReqId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

async function isEnabled($: $) {
  return (await $.env.get('JEV_AUTOPILOT')) === '1' || (await $.store.get('enabled')) === true
}
const STATUS_BY_ROLE: Record<Role, string | undefined> = {
  captain: 'autopilot ● firstmate',
  worker: 'autopilot ● worker (screening only)',
  supervisor: undefined, // Firstmate's headless host: autopilot stays out of it
  solo: 'autopilot ●',
}
let shownStatus: string | null = null // what this load last drew; null = never drawn
let offlineToastAt = 0
async function showStatus($: $) {
  const text = (await isEnabled($)) ? STATUS_BY_ROLE[await getRole($)] : undefined
  shownStatus = text ?? ''
  return $.ui.status(text)
}
// Redraws only on change: picks up a reload and a toggle made in another session.
async function refreshStatus($: $) {
  const text = (await isEnabled($)) ? STATUS_BY_ROLE[await getRole($)] : undefined
  if ((text ?? '') !== shownStatus) await showStatus($)
}
// Tells each session once when autopilot is switched, from any session or path: compares
// the state with what this session last saw (kept in the store, so a reload doesn't repeat it).
async function stateChange($: $) {
  if ((await getRole($)) === 'supervisor') return
  const key = `seen:${await mySid($)}`
  const seen = (await $.store.get(key)) as boolean | undefined
  const enabled = await isEnabled($)
  if (seen === enabled) return
  await $.store.set(key, enabled)
  return stateNotice(seen, enabled, owner())
}
async function project($: $) {
  return (await $.session.cwd()).split(/[\\/]/).pop() ?? ''
}

async function logPath($: $) {
  return `${await homeDir($)}/.claude/autopilot/decisions.jsonl`
}
// Every line is redacted: the secrets this process holds, and anything secret-shaped.
async function log($: $, entry: Record<string, unknown>) {
  const path = await logPath($)
  let prior = ''
  try { prior = await $.fs.read(path) } catch {}
  const line = JSON.stringify({ at: new Date().toISOString(), cwd: await $.session.cwd(), ...entry })
  await $.fs.write(path, prior + redact(line, await knownSecrets($)) + '\n')
}

async function jev($: $, body: unknown): Promise<JevAnswers> {
  const key = await secret($, 'TYPESAFE_API_KEY')
  if (!key) throw new Error('TYPESAFE_API_KEY is not set')
  let r
  try {
    r = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`Jev request failed: ${redact(String(err), [key])}`)
  }
  if (!r.ok) throw new Error(`Jev HTTP ${r.status}: ${redact(r.text.slice(0, 160), [key])}`)
  return JSON.parse(r.text).answers
}

// ------------------------------------------------------------ telegram

function tgToken($: $) {
  return secret($, 'TELEGRAM_BOT_TOKEN')
}
async function tgChat($: $) {
  return (await secret($, 'TELEGRAM_CHAT_ID')) ?? ((await $.store.get('tgChatId')) as string | undefined)
}

// The token rides in the URL, so no error from this call may carry the URL out; and
// whatever text goes to Telegram is redacted first.
async function tg($: $, method: string, body: Record<string, unknown>) {
  const token = await tgToken($)
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
  const known = await knownSecrets($)
  if (typeof body.text === 'string') body = { ...body, text: redact(body.text, known) }
  let r
  try {
    r = await $.http.fetch(`${TG}${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`telegram ${method}: ${redact(String(err), known)}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = {}
  try { json = JSON.parse(r.text || '{}') } catch {}
  if (!json.ok) throw new Error(`telegram ${method}: ${redact(String(json.description ?? r.status), known)}`)
  return json.result
}
async function say($: $, text: string, extra: Record<string, unknown> = {}) {
  const chat_id = await tgChat($)
  if (chat_id) return tg($, 'sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra }).catch(() => undefined)
}

// Each session has its own inbox, so an answer reaches the session that asked.
async function mySid($: $) {
  return (sid ??= await $.session.id())
}
async function getInbox($: $, owner?: string) {
  return ((await $.store.get(`inbox:${owner ?? (await mySid($))}`)) as InboxItem[] | undefined) ?? []
}
async function setInbox($: $, items: InboxItem[], owner?: string) {
  return $.store.set(`inbox:${owner ?? (await mySid($))}`, items)
}
async function addInbox($: $, item: InboxItem, owner?: string) {
  return setInbox($, [...(await getInbox($, owner)), item], owner)
}

// Exactly one session reads Telegram (one getUpdates listener per bot), preferring
// Firstmate's chat. The lease is renewed every tick and expires if that session dies.
async function holdListener($: $, r: Role) {
  const me = await mySid($)
  const cur = (await $.store.get('listener')) as { sid: string; role: Role; until: number } | undefined
  const free = !cur || cur.until < Date.now() || cur.sid === me || (r === 'captain' && cur.role !== 'captain')
  if (free) await $.store.set('listener', { sid: me, role: r, until: Date.now() + 15_000 })
  return free
}
async function isListener($: $) {
  const cur = (await $.store.get('listener')) as { sid: string; until: number } | undefined
  return !!cur && cur.until >= Date.now() && cur.sid === (await mySid($))
}

// Marks inbox items read on the phone side so the owner knows they landed.
async function receipt($: $, items: readonly InboxItem[], how: string) {
  for (const i of items) await say($, `✅ ${how}`, { reply_to_message_id: i.messageId })
}

// The pending pairing code, if it has not expired (an expired one is dropped).
async function pairPending($: $) {
  const state = (await $.store.get('pairCode')) as PairCode | undefined
  if (!state) return undefined
  if (state.until <= Date.now()) {
    await $.store.delete('pairCode')
    $.ui.toast('autopilot: the pairing code expired; run /autopilot pair again')
    return undefined
  }
  return state
}

// One getUpdates call; each update's offset is committed only after it is handled.
async function pump($: $, timeout: number) {
  const offset = Number((await $.store.get('tgOffset')) ?? 0)
  const updates: TgUpdate[] = await tg($, 'getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] })
  for (const u of updates) {
    await handle($, u).catch(() => {})
    await $.store.set('tgOffset', u.update_id + 1)
  }
}

async function handle($: $, u: TgUpdate) {
  const chatId = await tgChat($)
  const m = classify(u, chatId)
  if (!m) return

  if (m.kind === 'pairing') {
    // Only a private chat can pair, and only while a code is pending; strangers get no reply.
    if (!m.private) return
    const out = tryPair(await pairPending($), m.text, Date.now())
    if (!out) return
    if (out.result === 'paired') {
      await $.store.set('tgChatId', m.chatId)
      await $.store.delete('pairCode')
      await tg($, 'sendMessage', { chat_id: m.chatId, text: '🔗 Paired with Claude Code. Messages here now reach the session.' })
      $.ui.toast(`autopilot: Telegram paired with ${m.who}`)
    } else if (out.result === 'wrong') {
      await $.store.set('pairCode', out.state)
      $.ui.toast(`autopilot: wrong pairing code from ${m.who} (${out.left} attempt${out.left === 1 ? '' : 's'} left)`)
    } else {
      await $.store.delete('pairCode')
      $.ui.toast(`autopilot: pairing code ${out.result === 'burned' ? `burned after ${PAIR_ATTEMPTS} wrong guesses` : 'expired'}; run /autopilot pair again`)
    }
    return
  }

  if (m.kind === 'button') {
    const p = pending.get(m.reqId)
    const stored = (await $.store.get(`prompt:${m.reqId}`)) as Pending | undefined
    const label = (p ?? stored)?.slots[m.slot]?.labels[m.option]
    await tg($, 'answerCallbackQuery', { callback_query_id: m.callbackId, text: 'Got it' }).catch(() => {})
    if (m.messageId) await tg($, 'editMessageReplyMarkup', { chat_id: chatId, message_id: m.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {})
    if (!label) return
    if (!p && stored?.fm) {
      const answer = fmButtonAnswer(m.option)
      if (await resolveFm($, stored.fm.id, stored.fm.mode, answer, 'telegram', `${owner()} via Telegram: ${label}`)) {
        await say($, `✅ Recorded for firstmate: ${esc(answer)}`, { reply_to_message_id: m.messageId })
      }
      return
    }
    if (p) p.answers[m.slot] = label
    else await answerLater($, stored, m.slot, label, m.messageId ?? 0)
    return
  }

  if (m.kind === 'reply') {
    const ref = sentMsg.get(m.replyTo) ?? ((await $.store.get(`msg:${m.replyTo}`)) as { reqId: string; slot: number } | undefined)
    const p = ref && pending.get(ref.reqId)
    if (ref && p) {
      p.answers[ref.slot] = m.text
      return
    }
    const stored = ref && ((await $.store.get(`prompt:${ref.reqId}`)) as Pending | undefined)
    if (stored?.fm) {
      if (await resolveFm($, stored.fm.id, stored.fm.mode, m.text, 'telegram', `${owner()} via Telegram (in ${owner()}'s own words)`)) {
        await say($, '✅ Recorded for firstmate in your words.', { reply_to_message_id: m.messageId })
      }
      return
    }
    if (stored) return answerLater($, stored, ref!.slot, m.text, m.messageId)
    await addInbox($, { messageId: m.messageId, text: m.text, at: Date.now() })
    await say($, '👀 Received — Claude will see this at its next step.', { reply_to_message_id: m.messageId })
    return
  }

  if (m.kind === 'command') return phoneCommand($, m.command, m.messageId)

  await addInbox($, { messageId: m.messageId, text: m.text, at: Date.now() })
  await say($, `👀 Received — ${turnId ? 'Claude will see this at its next step.' : 'Claude is idle, starting a turn with it.'}`, { reply_to_message_id: m.messageId })
}

async function phoneCommand($: $, command: string, messageId: number) {
  const reply = (text: string) => say($, text, { reply_to_message_id: messageId })
  if (command === 'status') {
    const inbox = await getInbox($)
    return reply([
      `<b>${esc(await project($))}</b> · autopilot ${(await isEnabled($)) ? 'on' : 'off'}`,
      turnId ? `Working. Last tool: <code>${esc(lastTool || '—')}</code>` : 'Idle.',
      inbox.length ? `${inbox.length} message(s) queued for Claude.` : '',
    ].filter(Boolean).join('\n'))
  }
  if (command === 'stop') {
    if (!turnId) return reply('Nothing is running.')
    await $.turn.abort({ turnId }).catch(() => {})
    return reply('🛑 Stopped the current turn. Send a message to give it new direction.')
  }
  return reply('Commands: /status, /stop. Any other message goes straight to Claude; reply to a prompt to answer it.')
}

// Sends a prompt to the phone and returns at once: autopilot never waits on the owner.
// The answer arrives later through `answerLater`, delivered like any Telegram message.
async function askLater($: $, reqId: string, pend: Pending, messages: Record<string, unknown>[]) {
  await $.store.set(`prompt:${reqId}`, pend)
  const chat_id = await tgChat($)
  for (const [slot, msg] of messages.entries()) {
    const sent = await tg($, 'sendMessage', { chat_id, ...msg })
    sentMsg.set(sent.message_id, { reqId, slot })
    await $.store.set(`msg:${sent.message_id}`, { reqId, slot })
  }
}

// Turns a button tap or reply on an earlier prompt into a message for Claude.
async function answerLater($: $, stored: Pending | undefined, slot: number, text: string, messageId: number) {
  const q = stored?.slots[slot]?.question
  if (stored?.tool) {
    let msg = `Direction on the held call (${q}): ${text}`
    if (text === 'Proceed') {
      // Good only in the session and project that held the call, and only for telegramWaitMinutes.
      await $.store.set(`allow:${stored.tool}`, { until: Date.now() + cfg.waitMs })
      msg = `APPROVED: you may now run exactly this held call (same command/input): ${q}`
    } else if (text === 'Block') {
      msg = `BLOCKED: do not run this held call or work around it: ${q}`
    }
    await addInbox($, { messageId, text: msg, at: Date.now(), note: `${owner()} reviewed a held tool call`, held: true }, stored.sid)
    await log($, { by: 'human-telegram', tool: q, outcome: text })
  } else {
    await addInbox($, { messageId, text, at: Date.now(), note: q ? `${owner()}'s answer to your earlier question "${q}"` : undefined }, stored?.sid)
  }
  await say($, `👀 Got it — Claude will see this at its next step.`, { reply_to_message_id: messageId })
}

// Background: short polls every few seconds, and delivery of queued messages.
async function tick($: $) {
  if (ticking || waiting > 0) return
  ticking = true
  try {
    await refreshStatus($)
    const r = await getRole($)
    if (r === 'supervisor') return

    // Every session delivers its own inbox: answers to calls and questions it raised.
    await deliverIdle($)
    if (r === 'worker') return // crewmates report to firstmate, never to Telegram

    // Listen while autopilot is on, while a pairing code is pending, or for a few minutes
    // after /autopilot test; otherwise the bot is not polled at all.
    const listening = Number((await $.store.get('listenUntil')) ?? 0) > Date.now()
    const active = (await isEnabled($)) || (await pairPending($)) !== undefined || listening
    if (!active || !(await tgToken($))) return
    if (!(await holdListener($, r))) return
    await pump($, 0).catch(() => {})
    if (r === 'captain' && (await isEnabled($)) && ticks++ % 5 === 0) await checkFmHolds($).catch(() => {})
    // Firstmate has gone quiet for 2 minutes since its last turn: check that turn once for a stall.
    if (r === 'captain' && !turnId && lastTurnEnded && checkedTurn !== lastTurnEnded && Date.now() - lastCompleteAt > 2 * 60_000) {
      checkedTurn = lastTurnEnded
      await keepGoing($, lastAnswer).catch(() => {})
    }
  } finally {
    ticking = false
  }
}

// Mid-turn delivery happens on the next tool call; fall back to a queued prompt
// when idle, or when the turn has gone a minute without a tool call.
async function deliverIdle($: $) {
  const inbox = await getInbox($)
  if (!inbox.length) return
  const stale = Date.now() - inbox[0]!.at > 60_000
  if ((!turnId || stale) && Date.now() - submittedAt > 10_000) {
    submittedAt = Date.now()
    await setInbox($, [])
    const text = inboxPrompt(inbox, owner())
    const target = replyTarget(inbox)
    if (target !== undefined) tgPrompts.push({ text, replyTo: target })
    void $.prompt.submit({ text })
    await receipt($, inbox, turnId ? 'Queued for Claude right after its current step.' : 'Delivered — Claude is on it.')
  }
}

// Which Telegram message, if any, a starting turn answers: one of our inbox prompts.
function startReply(text: string) {
  const i = tgPrompts.findIndex(p => text.includes(p.text))
  if (i >= 0) return tgPrompts.splice(i, 1)[0]!.replyTo
  return text.includes(tgReplyNote(owner())) ? 0 : undefined
}

// Sends a Telegram-started turn's final answer back to that chat, once, as a reply.
async function relayReply($: $, answer: string) {
  const target = replyTo
  replyTo = undefined
  if (target === undefined || !answer.trim()) return
  const who = await getRole($)
  if (who === 'worker' || who === 'supervisor') return
  const chat_id = await tgChat($)
  if (!chat_id) return
  relayed = answer
  const extra = target ? { reply_to_message_id: target, allow_sending_without_reply: true } : {}
  for (const text of telegramReply(answer)) {
    // Should Telegram refuse the HTML, the same words still get through as plain text.
    await tg($, 'sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra })
      .catch(() => tg($, 'sendMessage', { chat_id, text: plainText(text), ...extra }))
  }
}

// When a turn ends, Jev checks whether the agent stopped while other work could proceed,
// and if so pushes it on. Capped, and it backs off once a nudge produces no work.
async function keepGoing($: $, finalMessage: string) {
  if (!(await isEnabled($)) || !(await isListener($))) return
  const who = await getRole($)
  if (who === 'worker' || who === 'supervisor') return
  // Firstmate idles while its crew works; that isn't a stall.
  if (who === 'captain' && (fleetRunning ?? 0) > 0) return
  // Nudged and still idle: stop nudging. Not proof it's waiting on the owner (it may be
  // waiting on tests or CI), so no notice here; only Jev's asksHuman check sends one.
  if (nudges > 0 && toolCalls === 0) return void (nudges = 3)
  if (nudges >= 3) return // until the owner types a prompt in person
  lastStallCheck = Date.now()

  const messages = (await $.session.messages({ as: 'api' })) as { role: string; content: unknown }[]
  const realPrompts = messages.filter(m => !JSON.stringify(m.content).includes(NUDGE_PREFIX))
  const d = decideStall(await jev($, buildStallRequest(finalMessage, lastUserText(realPrompts as never))))
  await log($, { by: 'jev', stall: true, done: d.done, proceedable: d.proceedable, outcome: d.nudge ? 'nudged to keep going' : 'let it stop' })
  if (!d.nudge) {
    nudges = 0
    // Firstmate's notices come from its backlog (notifyFleet); its chat covers the whole fleet.
    return d.notice && who !== 'captain' ? notifyEnd($, d.notice, finalMessage) : undefined
  }
  nudges++
  $.ui.toast('autopilot: work remains, nudging Claude to keep going')
  void $.prompt.submit({ text: nudgeText(owner()) })
}

// A switch made mid-turn (another window, the env) reaches the model on its next tool result.
async function noteState($: $, e: { agentId?: string }, r: ToolCallResult) {
  if (e.agentId || r.deny !== undefined) return r
  const note = await stateChange($).catch(() => undefined)
  return note ? { ...r, context: [...(r.context ?? []), note] } : r
}

// Attaches queued Telegram messages to a main-loop tool result so Claude reads them mid-turn.
async function deliver($: $, e: { agentId?: string }, r: ToolCallResult) {
  r = await noteState($, e, r)
  if (e.agentId || r.deny !== undefined) return r
  const inbox = await getInbox($)
  if (!inbox.length) return r
  await setInbox($, [])
  replyTo = replyTarget(inbox) ?? replyTo
  await receipt($, inbox, 'Claude has read this.')
  return { ...r, context: [...(r.context ?? []), inboxPrompt(inbox, owner())] }
}

const stringList = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(/[,\n]/).map(s => s.trim()).filter(Boolean) : undefined

export const register: Register = (on, options) => {
  cfg = {
    minConfidence: Number(options.minConfidence ?? DEFAULTS.minConfidence),
    stakesThreshold: Number(options.stakesThreshold ?? DEFAULTS.stakesThreshold),
    holdThreshold: Number(options.holdThreshold ?? DEFAULTS.holdThreshold),
    waitMs: Number(options.telegramWaitMinutes ?? 30) * 60_000,
    ownerName: String(options.ownerName ?? '').trim() || DEFAULT_OWNER,
    tempRoots: stringList(options.tempRoots) ?? TEMP_ROOTS,
    firstmateRemotes: stringList(options.firstmateRemotes) ?? [],
  }

  // ------------------------------------------------------------ session & commands

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'autopilot', description: 'Jev autopilot: on | off | status | pair | unpair | test | log' })
    $.clock.every(3000, () => void tick($))
    await showStatus($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    toolCalls = 0
    replyTo = startReply(e.text)
    return next(e)
  })
  // Only a prompt the owner typed in person resets the nudge budget, never a plugin's or a wake.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      nudges = 0
      lastStallCheck = 0
    }
    const note = await stateChange($).catch(() => undefined)
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    turnId = undefined
    const r = await next(e)
    if (e.isAborted) {
      replyTo = undefined
      return r
    }
    await relayReply($, e.answer).catch(() => {})
    lastAnswer = e.answer
    lastCompleteAt = Date.now()
    lastTurnEnded = e.turnId
    // Plain sessions: check right at turn end, at most every 5 minutes. Firstmate
    // ends a short turn on every crew update, so it is checked on idleness instead (tick).
    if ((await getRole($)) === 'solo' && (await isListener($)) && Date.now() - lastStallCheck >= 5 * 60_000) {
      await keepGoing($, e.answer).catch(() => {})
    }
    return r
  })

  on('command.run', { command: 'autopilot' }, async ($, e) => {
    const sub = e.args.trim().split(/\s+/)[0] || 'status'
    const hasJev = Boolean(await secret($, 'TYPESAFE_API_KEY'))
    const hasTg = Boolean(await tgToken($))
    const chat = await tgChat($)

    if (sub === 'on' || sub === 'off') {
      await $.store.set('enabled', sub === 'on')
      await stateChange($) // this session reads it in the command's output
      await showStatus($)
      if (sub === 'on' && chat) await say($, `🟢 Autopilot on for every session on this machine (switched on from <b>${esc(await project($))}</b>).`)
      return { text: `Autopilot ${sub} for every session on this machine.${sub === 'on' && !hasJev ? ' Warning: TYPESAFE_API_KEY is not set, so nothing will be screened.' : ''}` }
    }
    if (sub === 'pair') {
      if (!hasTg) return { text: `Set TELEGRAM_BOT_TOKEN first (create a bot with @BotFather; put the token in ${SECRETS_FILE}).` }
      // A mistyped token would otherwise fail silently in the background poll.
      let bot
      try {
        bot = await tg($, 'getMe', {})
      } catch (err) {
        return { text: `Could not confirm the bot token with Telegram, so no code was issued (${(err as Error).message.slice(0, 240)}). Check TELEGRAM_BOT_TOKEN against @BotFather, and that this machine can reach api.telegram.org.` }
      }
      const code = newPairCode(Date.now())
      await $.store.set('pairCode', code)
      return {
        text: `Send this code to ${bot?.username ? `@${bot.username}` : 'your bot'} in a private Telegram chat within 10 minutes: ${showPairCode(code)}\n` +
          `(${PAIR_ATTEMPTS} wrong guesses burn it.${chat ? ' Pairing again replaces the current chat.' : ''})`,
      }
    }
    if (sub === 'unpair') {
      await $.store.delete('tgChatId')
      await $.store.delete('pairCode')
      const env = await secret($, 'TELEGRAM_CHAT_ID')
      return { text: env ? `Unpaired the stored chat; TELEGRAM_CHAT_ID (${await secretSource($, 'TELEGRAM_CHAT_ID')}) still names chat ${env}.` : 'Unpaired. Run /autopilot pair to pair a chat again.' }
    }
    if (sub === 'test') {
      if (!chat) return { text: 'Not paired yet: run /autopilot pair.' }
      try {
        await tg($, 'sendMessage', { chat_id: chat, text: `👋 jev-autopilot test from <b>${esc(await project($))}</b>. Reply within 3 minutes to check two-way delivery.`, parse_mode: 'HTML' })
      } catch (err) {
        return { text: `Test message not sent (${(err as Error).message.slice(0, 240)}).` }
      }
      await $.store.set('listenUntil', Date.now() + 3 * 60_000)
      return { text: 'Test message sent to Telegram.' }
    }
    if (sub === 'log') {
      let lines: string[] = []
      try { lines = (await $.fs.read(await logPath($))).trim().split('\n').filter(Boolean) } catch {}
      const rows = lines.slice(-15).flatMap(l => {
        let d
        try { d = JSON.parse(l) } catch { return [] }
        const what = d.stall
          ? `turn ended → ${d.outcome} (done ${Number(d.done).toFixed(2)}, more possible ${Number(d.proceedable).toFixed(2)})`
          : d.tool ? `${d.tool} → ${d.outcome}`
          : d.fmTask ? `firstmate ${d.fmTask} → ${d.outcome}`
          : `Q: ${d.questions?.[0]?.question?.slice(0, 60)} → ${JSON.stringify(d.answers ?? d.outcome ?? d.reason)}`
        return [`${String(d.at ?? '').slice(5, 16)} [${d.by}]${d.review ? ' ⚑' : ''} ${what}`]
      })
      return { text: rows.length ? rows.join('\n') : 'No decisions logged yet.' }
    }
    const r = await getRole($)
    return {
      text: [
        `Autopilot: ${(await isEnabled($)) ? 'ON' : 'off'}`,
        `Owner: ${owner()}`,
        `Session role: ${r} (FM_TASK_ID ${(await $.env.get('FM_TASK_ID')) ?? 'unset'}, FM_TASK_INBOX ${(await $.env.get('FM_TASK_INBOX')) ? 'set' : 'unset'}, FM_SUPERVISION_ACTOR ${(await $.env.get('FM_SUPERVISION_ACTOR')) ?? 'unset'}, cwd ${await $.session.cwd()})`,
        `Firstmate: ${r === 'captain' ? 'detected (genuine checkout, scripts tracked and unmodified)' : `not detected${fmReason ? ` (${fmReason})` : ''}`}`,
        `Jev key: ${hasJev ? `set (${await secretSource($, 'TYPESAFE_API_KEY')})` : 'missing (TYPESAFE_API_KEY)'}`,
        `Telegram: ${hasTg ? `token set (${await secretSource($, 'TELEGRAM_BOT_TOKEN')}), ${chat ? 'paired' : 'not paired (/autopilot pair)'}` : 'missing (TELEGRAM_BOT_TOKEN)'}`,
        `Secrets file: ${await secretsPath($)}${secretsCache?.ignoredMode ? ` (ignored: mode ${secretsCache.ignoredMode}; run chmod 600 on it)` : ''}`,
        `Log: ${await logPath($)}`,
      ].join('\n'),
    }
  })

  // ------------------------------------------------------------ questions

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!(await isEnabled($)) || (await getRole($)) === 'supervisor') return next(e)
    const questions = e.questions as readonly Question[]
    const asked = questions.map(q => ({ question: q.question, options: q.options.map(o => o.label) }))

    let decision
    try {
      const messages = await $.session.messages({ as: 'api' })
      const body = buildQuestionRequest(questions, conversationContext(messages as never, questions, await $.session.cwd()))
      decision = decideQuestions(questions, await jev($, body), cfg)
    } catch (err) {
      $.ui.toast(`autopilot: ${redact(String(err)).slice(0, 90)}; asking you here`)
      return next(e)
    }

    if (decision.kind === 'auto') {
      await log($, { by: 'jev', questions: asked, answers: decision.answers, confidence: decision.confidence, stakes: decision.stakes, review: decision.review })
      $.ui.toast(`autopilot: Jev answered (conf ${decision.confidence.toFixed(2)}${decision.review ? ', flagged' : ''})`)
      const note = decision.review
        ? `${owner()} is away; Jev (an automated decision model) answered with LOW confidence. Implement this choice in the most reversible way, note the assumption on the ticket, and keep going.`
        : `${owner()} is away; Jev (an automated decision model) answered this on ${owner()}'s behalf. Keep going.`
      return { result: { questions: e.questions, answers: decision.answers }, context: [note] }
    }

    // Crewmates never address the captain: hand the call up to firstmate instead.
    if ((await getRole($)) === 'worker') {
      await log($, { by: 'jev', questions: asked, reason: decision.reason, stakes: decision.stakes, outcome: 'routed to firstmate' })
      return { deny: `This needs a decision above you (${decision.reason}). ${WORKER_ESCALATE}` }
    }

    if (!(await tgChat($)) || !(await tgToken($))) {
      await log($, { by: 'human-terminal', questions: asked, reason: decision.reason, stakes: decision.stakes })
      return next(e)
    }

    const reqId = newReqId()
    const proj = await project($)
    try {
      await askLater(
        $, reqId,
        { slots: questions.map(q => ({ question: q.question, labels: q.options.map(o => o.label) })), answers: {}, sid: await mySid($) },
        questions.map((q, i) => questionMessage(q, i, reqId, decision.reason, proj, decision.suggested[q.question])),
      )
    } catch (err) {
      $.ui.toast(`autopilot: Telegram failed (${redact(String(err)).slice(0, 80)}); asking here`)
      return next(e)
    }

    await log($, { by: 'jev', questions: asked, reason: decision.reason, stakes: decision.stakes, outcome: 'sent to Telegram, agent told to keep going' })
    return {
      deny: `Sent to ${owner()}'s phone (${decision.reason}); the answer will arrive later as a message. Do NOT wait for it and do NOT decide it yourself. ` +
        'Note the open question, park only the work that depends on it, and keep going with everything else that can proceed. ' +
        'When the answer arrives, pick that work back up.',
    }
  })

  // ------------------------------------------------------------ every other tool call

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') return next(e)
    if (!(await isEnabled($))) return noteState($, e, await next(e))
    if ((await getRole($)) === 'supervisor') return next(e)
    if (isReadOnlyTool(e.tool)) return deliver($, e, await next(e))
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e as typeof e & Record<string, unknown>
    const summary = redact(toolSummary(tool, input), await knownSecrets($))
    lastTool = summary
    if (!e.agentId) toolCalls++
    const profile = await fmProfile($)
    const cwd = await $.session.cwd()

    // Removing temp scratch dirs (mktemp dirs, a pipeline's worktrees) is routine cleanup.
    if (typeof input.command === 'string' && tempCleanup(input.command, profile.tempRoots).onlyCleanup) {
      return deliver($, e, await next(e))
    }

    // Firstmate steering its own workers through its scripts is internal coordination.
    if (typeof input.command === 'string' && (await getRole($)) === 'captain' && fmInternal(input.command, cwd)) {
      return deliver($, e, await next(e))
    }

    // A call the owner approved from the phone runs once, unscreened: same session, same
    // project, same input, and within telegramWaitMinutes of the tap.
    const key = toolKey(tool, input, { sid: await mySid($), cwd })
    const allow = await $.store.get(`allow:${key}`)
    if (allow !== undefined) {
      await $.store.delete(`allow:${key}`)
      if (approvalValid(allow, Date.now())) {
        await log($, { by: 'human-telegram', tool: summary, outcome: 'ran after approval' })
        return deliver($, e, await next(e))
      }
      await log($, { by: 'human-telegram', tool: summary, outcome: 'approval expired; screened again' })
    }

    let verdict
    try {
      const messages = await $.session.messages({ as: 'api' })
      verdict = judgeTool(await jev($, buildToolRequest(tool, input, lastUserText(messages as never), cwd, profile)), cfg)
    } catch {
      // Jev is an extra layer: without it the call goes on to Claude Code's own
      // permission mode (and, under Firstmate, to Firstmate's own supervision).
      if (Date.now() - offlineToastAt > 60_000) {
        offlineToastAt = Date.now()
        $.ui.toast('autopilot: Jev unreachable, tool calls are not being screened right now')
      }
      return deliver($, e, await next(e))
    }

    if (verdict.risk !== 'safe') await log($, { by: 'jev', tool: summary, risk: verdict.risk, pDanger: verdict.pDanger, outcome: verdict.hold ? 'held' : 'allowed' })
    if (!verdict.hold) return deliver($, e, await next(e))

    if ((await getRole($)) === 'worker') {
      await log($, { by: 'jev', tool: summary, risk: verdict.risk, pDanger: verdict.pDanger, outcome: 'blocked, routed to firstmate' })
      return { deny: `Autopilot (Jev) blocked this call as ${verdict.risk} (p=${verdict.pDanger.toFixed(2)}). Do not retry it or work around it. ${WORKER_ESCALATE}` }
    }

    if (!(await tgChat($)) || !(await tgToken($))) {
      return { deny: `jev-autopilot held this call (Jev rated it ${verdict.risk}, danger ${verdict.pDanger.toFixed(2)}) and Telegram is not set up to ask ${owner()}. Do not retry it; explain what you wanted to do in your summary.` }
    }

    const reqId = newReqId()
    try {
      await askLater(
        $, reqId,
        { slots: [{ question: summary, labels: ['Proceed', 'Block'] }], answers: {}, tool: key, sid: await mySid($) },
        [holdMessage(summary, verdict, await project($), reqId)],
      )
    } catch (err) {
      const failure = redact(String(err), await knownSecrets($)).slice(0, 300)
      await log($, { by: 'telegram-error', tool: summary, risk: verdict.risk, pDanger: verdict.pDanger, outcome: failure })
      $.ui.toast(`autopilot: Telegram failed while holding a call (${failure.slice(0, 80)})`)
      return { deny: `jev-autopilot held this call (Jev rated it ${verdict.risk}, danger ${verdict.pDanger.toFixed(2)}) and could not reach ${owner()} on Telegram (${failure}). Do not retry it; park this step, keep going with other work, and mention it in your summary.` }
    }
    return {
      deny: `Held for ${owner()}'s approval by phone (Jev rated it ${verdict.risk}, ${verdict.pDanger.toFixed(2)}). Do NOT wait and do not work around it: ` +
        `park this step and keep going with other work. If ${owner()} approves, a message will tell you and you can then run exactly the same call; if ${owner()} blocks it, you will be told.`,
    }
  })

  // ------------------------------------------------------------ keep going

  // Standing autopilot instructions, so a pending decision parks one piece of work, not the session.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(await isEnabled($))) return r
    const who = await getRole($)
    if (who === 'supervisor') return r
    return { sections: [...r.sections, { id: 'jev-autopilot', text: autopilotPrompt(who, owner()), scope: 'session' as const }] }
  })
}
