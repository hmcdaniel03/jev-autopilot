// The setup state machine and the text it prints, as pure logic.
import { expect, test } from 'claude-code/testing'

import {
  createFileCommand, displayPath, fixModeCommand, helpText, HOW_IT_WORKS, howItWorks, keyFormatOk, MIN_VERSION, nextStep, pasteCommand, pasteInstructions, pluginDirsExample,
  SECRETS_TEMPLATE, secretsFile, stepText, summaryLines, tokenFormatOk, versionLine, versionOk, windowsRestrict,
} from '../hooks/setup'
import type { SetupWorld } from '../hooks/setup'
import { parseEnvFile } from '../hooks/trust'

const HOME = '/home/sam'
const TOKEN = '123456789:AAFtokenAAFtokenAAFtokenAAFtokenAAF'
const KEY = 'ts-live-0123456789abcdef'

const world = (over: Partial<SetupWorld> = {}): SetupWorld => ({
  os: 'posix', home: HOME, version: '2.1.290', file: { exists: false }, ownerName: 'the owner', paired: false, pairPending: false, enabled: false, ...over,
})
const withFile = (values: Record<string, string>, mode = '600', over: Partial<SetupWorld> = {}) => world({ file: { exists: true, mode, values }, ...over })

// ---------------------------------------------------------------- the state machine

test('a missing file is created first, then the user is sent to add the bot token', () => {
  expect(nextStep(world())).toEqual({ kind: 'create-file' })
  // the template holds no KEY=VALUE line, so a fresh file has no secrets at all
  expect(parseEnvFile(SECRETS_TEMPLATE)).toEqual({})
  expect(nextStep(withFile(parseEnvFile(SECRETS_TEMPLATE)))).toEqual({ kind: 'add-secret', name: 'TELEGRAM_BOT_TOKEN' })
})

test('a file others can read stops the flow before any secret is read', () => {
  expect(nextStep(withFile({ TELEGRAM_BOT_TOKEN: TOKEN, TYPESAFE_API_KEY: KEY }, '644'))).toEqual({ kind: 'fix-mode', mode: '644' })
  // an unknown mode (Windows, no stat) is not a stop
  expect(nextStep(world({ file: { exists: true, values: { TELEGRAM_BOT_TOKEN: TOKEN } } })).kind).toBe('verify')
})

test('with the token present the network checks run; the Jev key is optional and format-checked', () => {
  expect(nextStep(withFile({ TELEGRAM_BOT_TOKEN: TOKEN }))).toEqual({ kind: 'verify', jevKey: 'missing' })
  expect(nextStep(withFile({ TELEGRAM_BOT_TOKEN: TOKEN, TYPESAFE_API_KEY: KEY }))).toEqual({ kind: 'verify', jevKey: 'present' })
  expect(nextStep(withFile({ TELEGRAM_BOT_TOKEN: TOKEN, TYPESAFE_API_KEY: 'short' }))).toEqual({ kind: 'verify', jevKey: 'malformed' })
})

test('a token Telegram rejects stops the flow; a good one goes on to the name, pairing and the switch', () => {
  const w = withFile({ TELEGRAM_BOT_TOKEN: TOKEN })
  expect(nextStep({ ...w, checks: { token: false } })).toEqual({ kind: 'bad-token' })
  expect(nextStep({ ...w, checks: { token: true } })).toEqual({ kind: 'name' })
  expect(nextStep({ ...w, checks: { token: true }, askName: false })).toEqual({ kind: 'pair' })
  expect(nextStep({ ...w, checks: { token: true }, ownerName: 'Sam' })).toEqual({ kind: 'pair' })
  expect(nextStep({ ...w, checks: { token: true }, ownerName: 'Sam', pairPending: true })).toEqual({ kind: 'pair-pending' })
  expect(nextStep({ ...w, checks: { token: true }, ownerName: 'Sam', paired: true })).toEqual({ kind: 'enable' })
  expect(nextStep({ ...w, checks: { token: true }, ownerName: 'Sam', paired: true, enabled: true })).toEqual({ kind: 'done' })
})

test('re-running resumes: a half-done world lands on the step that is still open', () => {
  // the file was created and filled by hand, nothing else happened yet
  expect(nextStep(withFile({ TELEGRAM_BOT_TOKEN: TOKEN })).kind).toBe('verify')
  // paired earlier, switched off since: only the switch is left
  expect(nextStep(withFile({ TELEGRAM_BOT_TOKEN: TOKEN }, '600', { ownerName: 'Sam', paired: true, checks: { token: true } }))).toEqual({ kind: 'enable' })
  // everything done: the run just reports
  const done = withFile({ TELEGRAM_BOT_TOKEN: TOKEN, TYPESAFE_API_KEY: KEY }, '600', { ownerName: 'Sam', paired: true, enabled: true, checks: { token: true, jev: true } })
  expect(nextStep(done)).toEqual({ kind: 'done' })
  expect(summaryLines(done).join('\n')).toContain('TYPESAFE_API_KEY: valid ✓')
  expect(summaryLines(done).join('\n')).toContain('Autopilot: on')
})

// ---------------------------------------------------------------- prerequisites

test('the Claude Code version is compared with the tested release', () => {
  expect(versionOk('2.1.290')).toBe(true)
  expect(versionOk(MIN_VERSION)).toBe(true)
  expect(versionOk('2.1.288')).toBe(false)
  expect(versionOk('2.0.999')).toBe(false)
  expect(versionOk('3.0.0-dev.20260920')).toBe(true)
  expect(versionOk(undefined)).toBe(undefined)
  expect(versionLine('2.1.100')).toContain(`older than ${MIN_VERSION}`)
  expect(versionLine('2.1.290')).toBe('Claude Code 2.1.290 ✓')
})

test('secret shapes: a bot token and a printable key', () => {
  expect(tokenFormatOk(TOKEN)).toBe(true)
  expect(tokenFormatOk('not a token')).toBe(false)
  expect(keyFormatOk(KEY)).toBe(true)
  expect(keyFormatOk('has a space in it')).toBe(false)
  expect(keyFormatOk('short')).toBe(false)
  expect(keyFormatOk(undefined)).toBe(false)
})

// ---------------------------------------------------------------- what it creates and prints

test('the file is created private from the first byte: one sh under umask 077, existing file left alone', () => {
  const cmd = createFileCommand('posix', HOME)!
  expect(cmd.argv[0]).toBe('sh')
  expect(cmd.argv[2]).toContain('umask 077')
  expect(cmd.argv[2]).toContain('if [ ! -e "$2" ]')
  expect(cmd.argv).toContain(`${HOME}/.claude/jev-autopilot`)
  expect(cmd.argv).toContain(secretsFile(HOME))
  expect(cmd.stdin).toBe(SECRETS_TEMPLATE)
  // Windows: the engine writes, icacls restricts
  expect(createFileCommand('windows', 'C:/Users/sam')).toBe(undefined)
  expect(windowsRestrict('C:/Users/sam')).toEqual(['icacls', 'C:\\Users\\sam\\.claude\\jev-autopilot\\secrets.env', '/inheritance:r', '/grant:r', '%USERNAME%:(R,W)'])
})

test('the paste commands read the value hidden and never show it: bash/zsh and PowerShell', () => {
  const sh = pasteCommand('posix', HOME, 'TELEGRAM_BOT_TOKEN')
  expect(sh).toContain('read -rs v')
  expect(sh).not.toContain('read -rsp') // -p is not what zsh's read takes
  expect(sh).toContain('umask 077')
  expect(sh).toContain("printf 'TELEGRAM_BOT_TOKEN=%s\\n' \"$v\" >> ~/.claude/jev-autopilot/secrets.env")
  expect(sh).toContain('unset v')
  const ps = pasteCommand('windows', 'C:/Users/sam', 'TYPESAFE_API_KEY')
  expect(ps).toContain('Read-Host')
  expect(ps).toContain('-AsSecureString')
  expect(ps).toContain('"$env:USERPROFILE\\.claude\\jev-autopilot\\secrets.env"')
  expect(ps).toContain('TYPESAFE_API_KEY=$v')
  expect(ps).toContain('Remove-Variable v, s')
})

test('the instructions name the file, forbid pasting into the chat, and spell paths per OS', () => {
  const posix = pasteInstructions('posix', HOME, 'TELEGRAM_BOT_TOKEN')
  expect(posix).toContain(`${HOME}/.claude/jev-autopilot/secrets.env`)
  expect(posix).toContain('Do not paste it into this chat')
  expect(posix).toContain('@BotFather')
  const win = pasteInstructions('windows', 'C:/Users/sam', 'TYPESAFE_API_KEY')
  expect(win).toContain('C:\\Users\\sam\\.claude\\jev-autopilot\\secrets.env')
  expect(win).toContain('(PowerShell)')
  expect(win).toContain('console.typesafe.ai')
  expect(fixModeCommand('posix', HOME)).toBe(`chmod 600 ${HOME}/.claude/jev-autopilot/secrets.env`)
  expect(fixModeCommand('windows', 'C:/Users/sam')).toContain('icacls "C:\\Users\\sam\\.claude\\jev-autopilot\\secrets.env" /inheritance:r')
  expect(displayPath('windows', 'C:/Users/sam/x')).toBe('C:\\Users\\sam\\x')
  expect(pluginDirsExample('posix', ['~/a', '~/b'])).toBe('~/a:~/b')
  expect(pluginDirsExample('windows', ['C:/a', 'C:/b'])).toBe('C:\\a;C:\\b')
})

test('each stopping step tells the user what to do and that re-running resumes', () => {
  const w = withFile({ TELEGRAM_BOT_TOKEN: TOKEN }, '644')
  expect(stepText({ kind: 'fix-mode', mode: '644' }, w)).toContain('chmod 600')
  expect(stepText({ kind: 'fix-mode', mode: '644' }, w)).toContain('/autopilot setup')
  expect(stepText({ kind: 'add-secret', name: 'TELEGRAM_BOT_TOKEN' }, w)).toContain('read -rs v')
  expect(stepText({ kind: 'bad-token' }, w, { tokenError: 'telegram getMe: Unauthorized' })).toContain('Unauthorized')
  expect(stepText({ kind: 'bad-token' }, w, {})).toContain('/revoke')
  expect(stepText({ kind: 'pair' }, w, { pairCode: 'ABCDE-FGHJK', botUser: 'sams_bot' })).toContain('Send **ABCDE-FGHJK** to @sams_bot in a **private** Telegram chat')
  expect(stepText({ kind: 'pair-pending' }, w, { pairCode: 'ABCDE-FGHJK' })).toContain('already pending: send **ABCDE-FGHJK**')
  expect(stepText({ kind: 'enable' }, w)).toContain('/autopilot on')
  expect(stepText({ kind: 'done' }, w)).toContain('Autopilot is on')
  expect(stepText({ kind: 'name' }, w)).toContain('/autopilot name')
})

test('the summary reports each prerequisite without printing a secret', () => {
  const w = withFile({ TELEGRAM_BOT_TOKEN: TOKEN, TYPESAFE_API_KEY: KEY }, '600', { checks: { token: true, jev: false } })
  const text = summaryLines(w, { botUser: 'sams_bot', jevStatus: 'HTTP 401' }).join('\n')
  expect(text).toContain('Claude Code 2.1.290 ✓')
  expect(text).toContain('mode 600 ✓')
  expect(text).toContain('TELEGRAM_BOT_TOKEN: valid ✓ (@sams_bot)')
  expect(text).toContain('TYPESAFE_API_KEY: rejected by TypeSafe ✗ (HTTP 401)')
  expect(text).toContain('Telegram: not paired')
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain(KEY)
  // TypeSafe could not be asked: the key is neither valid nor rejected
  const unknown = summaryLines({ ...w, checks: { token: true } }, { jevStatus: 'HTTP 529' }).join('\n')
  expect(unknown).toContain('TYPESAFE_API_KEY: present (not verified: HTTP 529)')
  const missing = summaryLines(withFile({ TELEGRAM_BOT_TOKEN: TOKEN })).join('\n')
  expect(missing).toContain('TYPESAFE_API_KEY: missing (optional')
  expect(summaryLines(world({ os: 'windows', home: 'C:/Users/sam', file: { exists: true, values: {} } })).join('\n')).toContain('permissions not checked on Windows')
})

// ---------------------------------------------------------------- how it works

test('the explainer says what on and off do, in short lines, without naming the owner', () => {
  const text = howItWorks()
  expect(HOW_IT_WORKS.length + 1).toBeLessThanOrEqual(12)
  for (const want of ['every Claude Code session on this machine', 'Proceed or Block', 'reply comes back', 'keep going', 'everything asks you in the terminal', 'permission mode', 'on when you leave', '/status and /stop'])
    expect(text).toContain(want)
  for (const c of ['/autopilot on', 'off', 'status', 'log', 'test', 'pair', 'unpair', 'name <name>', 'setup', 'help']) expect(text).toContain(`\`${c}\``)
  expect(text).not.toContain('the owner')
  expect(text).not.toContain('Hunter')
})

test('help is the explainer plus the full command list', () => {
  const text = helpText()
  for (const line of HOW_IT_WORKS) expect(text).toContain(line)
  expect(text).toContain('`/autopilot pair / unpair`')
  expect(text).toContain('/stop')
})

test('the last setup steps point to /autopilot help; the switch-on step explains autopilot unless the dialog already did', () => {
  const w = withFile({ TELEGRAM_BOT_TOKEN: TOKEN }, '600', { paired: true })
  const enable = stepText({ kind: 'enable' }, w)
  expect(enable).toContain('How autopilot works')
  expect(enable).toContain('/autopilot help')
  expect(enable).toContain('Run `/autopilot on`')
  const shown = stepText({ kind: 'enable' }, w, { explained: true })
  expect(shown).not.toContain('How autopilot works')
  expect(shown).toContain('/autopilot help')
  expect(stepText({ kind: 'done' }, { ...w, enabled: true })).toContain('/autopilot help')
})
