// `/autopilot setup` as pure logic: what the first-time flow checks, in what order,
// what it creates, and the exact text it prints for each operating system. No `$`
// here, so every state and every printed command is unit-tested. `register.ts`
// reads the world, runs the network checks and applies the step this module picks.
//
// Nothing here ever takes a secret: the flow creates the file, tells the user what
// to paste where (an editor, or a one-line terminal command that reads the value
// hidden), and re-checks. A secret typed into the chat or a slash command would
// land in the transcript.

import { DEFAULT_OWNER } from './core'
import { modeIsPrivate, SECRETS_FILE } from './trust'

// The Claude Code release the plugin was tested with (README, Requirements).
export const MIN_VERSION = '2.1.289'

export const JEV_MODELS_URL = 'https://api.typesafe.ai/v1/models'

export type Os = 'posix' | 'windows'

export type SecretName = 'TELEGRAM_BOT_TOKEN' | 'TYPESAFE_API_KEY'

// What the flow knows without touching the network.
export type SetupWorld = {
  os: Os
  home: string // forward slashes, no trailing slash
  version?: string // the engine's, as `claude --version` prints it; undefined when unknown
  file: { exists: false } | { exists: true; mode?: string; values: Readonly<Record<string, string>> }
  ownerName: string
  paired: boolean
  pairPending: boolean
  enabled: boolean
  // Results of the network checks, once run: undefined until then. `jev` is
  // undefined while the key is missing or TypeSafe could not be asked.
  checks?: { token: boolean; jev?: boolean }
  // False once this run has offered to set the owner's name (asked or printed the hint).
  askName?: boolean
}

export type Step =
  | { kind: 'create-file' }
  | { kind: 'fix-mode'; mode: string }
  | { kind: 'add-secret'; name: 'TELEGRAM_BOT_TOKEN' }
  | { kind: 'verify'; jevKey: 'missing' | 'malformed' | 'present' }
  | { kind: 'bad-token' }
  | { kind: 'name' }
  | { kind: 'pair-pending' }
  | { kind: 'pair' }
  | { kind: 'enable' }
  | { kind: 'done' }

// ---------------------------------------------------------------- version

const semver = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

// Is `version` at least MIN_VERSION? undefined when the version is not a release spelling.
export function versionOk(version: string | undefined, min = MIN_VERSION) {
  const a = version && semver(version)
  const b = semver(min)
  if (!a || !b) return undefined
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return true
}

// ---------------------------------------------------------------- paths

export const secretsDir = (home: string) => `${home}/.claude/jev-autopilot`
export const secretsFile = (home: string) => `${secretsDir(home)}/secrets.env`

// The path as the user's shell spells it: backslashes on Windows.
export const displayPath = (os: Os, path: string) => (os === 'windows' ? path.replace(/\//g, '\\') : path)

// A `CLAUDE_CODE_PLUGIN_DIRS` value listing `dirs`, with the separator the OS wants.
export const pluginDirsExample = (os: Os, dirs: readonly string[]) => dirs.map(d => displayPath(os, d)).join(os === 'windows' ? ';' : ':')

// ---------------------------------------------------------------- the file

// Comments only: a KEY=VALUE line is added by the user (or the paste command), so
// a value is never a placeholder the plugin could mistake for a secret.
export const SECRETS_TEMPLATE = [
  '# jev-autopilot secrets. Keep this file readable by you only (mode 600).',
  '# One KEY=VALUE per line, quotes optional, # starts a comment. Add:',
  '#   TELEGRAM_BOT_TOKEN=...   the token @BotFather gave you (looks like 123456789:AAF...)',
  '#   TYPESAFE_API_KEY=...     your TypeSafe key from console.typesafe.ai (leave out until you have one)',
  '#   TELEGRAM_CHAT_ID=...     optional: pin the paired chat',
  '',
].join('\n')

// Creates the directory and the file, private to the owner from the first byte, and
// leaves an existing file alone. POSIX: one `sh` under umask 077. Windows: the engine
// writes the file (see `windowsRestrict` for the ACL).
export function createFileCommand(os: Os, home: string): { argv: readonly string[]; stdin: string } | undefined {
  if (os === 'windows') return undefined
  return {
    argv: ['sh', '-c', 'umask 077 && mkdir -p -- "$1" && if [ ! -e "$2" ]; then cat > "$2"; fi', 'sh', secretsDir(home), secretsFile(home)],
    stdin: SECRETS_TEMPLATE,
  }
}

// Windows: strip inherited ACLs and grant the current user alone.
export function windowsRestrict(home: string): readonly string[] {
  return ['icacls', displayPath('windows', secretsFile(home)), '/inheritance:r', '/grant:r', '%USERNAME%:(R,W)']
}

// What the user runs when the file has the wrong permissions.
export function fixModeCommand(os: Os, home: string) {
  const path = displayPath(os, secretsFile(home))
  return os === 'windows' ? `icacls "${path}" /inheritance:r /grant:r "$env:USERNAME:(R,W)"` : `chmod 600 ${path}`
}

// One line the user runs in their own terminal (never in this chat): reads the value
// hidden, appends KEY=VALUE to the file, and forgets the variable. The file is created
// under umask 077 if the paste runs before setup made it. Portable across bash and zsh
// (`read -s` is common to both; `-p` is not).
export function pasteCommand(os: Os, home: string, name: SecretName) {
  const label = name === 'TELEGRAM_BOT_TOKEN' ? 'Telegram bot token' : 'TypeSafe API key'
  if (os === 'windows') {
    const path = displayPath('windows', secretsFile(home)).replace(home.replace(/\//g, '\\'), '$env:USERPROFILE')
    return `$s = Read-Host '${label}' -AsSecureString; $v = [Net.NetworkCredential]::new('', $s).Password; ` +
      `Add-Content -Path "${path}" -Value "${name}=$v"; Remove-Variable v, s`
  }
  const path = secretsFile(home).replace(home, '~')
  return `printf '${label}: '; read -rs v; echo; (umask 077; mkdir -p ${secretsDir(home).replace(home, '~')}; printf '${name}=%s\\n' "$v" >> ${path}); unset v`
}

// ---------------------------------------------------------------- secrets

// A key the TypeSafe client would accept: printable ASCII, no spaces, long enough to
// be a key rather than a stray word. (Validity itself is checked against the API.)
export function keyFormatOk(key: string | undefined) {
  return typeof key === 'string' && key.length >= 16 && /^[\x21-\x7e]+$/.test(key)
}

// A Telegram bot token's shape: `<bot id>:<35 chars>`.
export const tokenFormatOk = (token: string | undefined) => typeof token === 'string' && /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)

// ---------------------------------------------------------------- the state machine

// The next thing the flow does, from the world as it stands. Re-running `setup` always
// starts here, so it resumes wherever the last run stopped.
export function nextStep(w: SetupWorld): Step {
  if (!w.file.exists) return { kind: 'create-file' }
  if (w.file.mode !== undefined && modeIsPrivate(w.file.mode) === false) return { kind: 'fix-mode', mode: w.file.mode }
  const token = w.file.values.TELEGRAM_BOT_TOKEN
  if (!token) return { kind: 'add-secret', name: 'TELEGRAM_BOT_TOKEN' }
  if (!w.checks) {
    const jev = w.file.values.TYPESAFE_API_KEY
    return { kind: 'verify', jevKey: !jev ? 'missing' : keyFormatOk(jev) ? 'present' : 'malformed' }
  }
  if (!w.checks.token) return { kind: 'bad-token' }
  if (w.askName !== false && (!w.ownerName.trim() || w.ownerName === DEFAULT_OWNER)) return { kind: 'name' }
  if (!w.paired) return w.pairPending ? { kind: 'pair-pending' } : { kind: 'pair' }
  if (!w.enabled) return { kind: 'enable' }
  return { kind: 'done' }
}

// ---------------------------------------------------------------- text

const B = (s: string) => `**${s}**`

// The prerequisites line, first in every run.
export function versionLine(version: string | undefined) {
  const ok = versionOk(version)
  if (ok === undefined) return `Claude Code ${version ?? 'version unknown'} (tested with ${MIN_VERSION}; could not compare)`
  return ok ? `Claude Code ${version} ✓` : `Claude Code ${version}: older than ${MIN_VERSION}, which this plugin was tested with; update Claude Code if setup misbehaves`
}

// Where to put a secret: the editor way and the terminal way, no secret in this chat.
export function pasteInstructions(os: Os, home: string, name: SecretName) {
  const path = displayPath(os, secretsFile(home))
  const from = name === 'TELEGRAM_BOT_TOKEN'
    ? 'the token @BotFather gave you (message @BotFather on Telegram, /newbot, and copy the token)'
    : 'your TypeSafe API key (console.typesafe.ai → Keys)'
  return [
    `Add ${B(name)} to ${path}: ${from}.`,
    `Do not paste it into this chat or a slash command (that lands in the transcript). Either:`,
    `  • open the file in an editor and add the line \`${name}=<value>\`, or`,
    `  • run this in your own terminal${os === 'windows' ? ' (PowerShell)' : ''}; it reads the value hidden and appends it:`,
    `    ${pasteCommand(os, home, name)}`,
  ].join('\n')
}

export const RERUN = 'Then run `/autopilot setup` again; it picks up where it left off.'

// The text for a step that stops the flow, or for `done`.
export type Extra = { botUser?: string; pairCode?: string; tokenError?: string; jevStatus?: string }

export function stepText(step: Step, w: SetupWorld, extra: Extra = {}): string {
  const path = displayPath(w.os, secretsFile(w.home))
  switch (step.kind) {
    case 'create-file':
      return `Created ${path} (readable by you only) from a commented template.`
    case 'fix-mode':
      return [
        `${path} has mode ${step.mode}, so the plugin ignores it (it must be readable by you only).`,
        `Run: ${fixModeCommand(w.os, w.home)}`,
        RERUN,
      ].join('\n')
    case 'add-secret':
      return [pasteInstructions(w.os, w.home, step.name), RERUN].join('\n')
    case 'bad-token':
      return [
        `Telegram rejected the bot token in ${path}${extra.tokenError ? ` (${extra.tokenError})` : ''}.`,
        `Check it against @BotFather (or /revoke there for a fresh one) and put the new value in the file:`,
        pasteInstructions(w.os, w.home, 'TELEGRAM_BOT_TOKEN'),
        RERUN,
      ].join('\n')
    case 'verify':
      return 'Checking the bot token with Telegram' + (step.jevKey === 'present' ? ' and the TypeSafe key with TypeSafe…' : '…')
    case 'name':
      return `Prompts and Telegram text call you "${DEFAULT_OWNER}". Run \`/autopilot name <your first name>\` to change that (a name is not a secret).`
    case 'pair-pending':
      return `A pairing code is already pending${extra.pairCode ? `: send ${B(extra.pairCode)} to ${extra.botUser ? `@${extra.botUser}` : 'your bot'} in a private Telegram chat` : ''}. ${RERUN}`
    case 'pair':
      return `Send ${B(extra.pairCode ?? '')} to ${extra.botUser ? `@${extra.botUser}` : 'your bot'} in a ${B('private')} Telegram chat within 10 minutes (three wrong guesses burn it). ${RERUN}`
    case 'enable':
      return 'Everything is in place. Run `/autopilot on` to switch autopilot on for every session on this machine.'
    case 'done':
      return 'Autopilot is on. `/autopilot status` shows the state, `/autopilot log` the decisions, `/autopilot off` switches it off.'
  }
}

function jevLine(key: string | undefined, checks: SetupWorld['checks'], status: string | undefined) {
  if (!key) return 'missing (optional until you have one; without it nothing is answered or screened)'
  if (!keyFormatOk(key)) return 'present but not key-shaped (printable ASCII, no spaces, 16+ characters); check it against console.typesafe.ai'
  if (checks?.jev === true) return 'valid ✓'
  if (checks?.jev === false) return `rejected by TypeSafe ✗${status ? ` (${status})` : ''}; check it against console.typesafe.ai`
  return checks && status ? `present (not verified: ${status})` : 'present'
}

// The lines a finished (or halted) run reports above the step's own text.
export function summaryLines(w: SetupWorld, extra: Extra = {}) {
  const lines = [versionLine(w.version), `Plugin loaded ✓`]
  if (w.file.exists) {
    const mode = w.file.mode === undefined
      ? w.os === 'windows' ? 'permissions not checked on Windows' : 'mode unknown'
      : modeIsPrivate(w.file.mode) ? `mode ${w.file.mode} ✓` : `mode ${w.file.mode} ✗`
    lines.push(`Secrets file ${displayPath(w.os, secretsFile(w.home))} (${mode})`)
    const token = w.file.values.TELEGRAM_BOT_TOKEN
    lines.push(`TELEGRAM_BOT_TOKEN: ${!token ? 'missing' : w.checks ? (w.checks.token ? `valid ✓${extra.botUser ? ` (@${extra.botUser})` : ''}` : 'rejected by Telegram ✗') : tokenFormatOk(token) ? 'present' : 'present (unusual shape)'}`)
    const jev = w.file.values.TYPESAFE_API_KEY
    lines.push(`TYPESAFE_API_KEY: ${jevLine(jev, w.checks, extra.jevStatus)}`)
  } else {
    lines.push(`Secrets file ${displayPath(w.os, secretsFile(w.home))}: missing`)
  }
  lines.push(`Owner name: ${w.ownerName}${w.ownerName === DEFAULT_OWNER ? ' (default)' : ''}`)
  lines.push(`Telegram: ${w.paired ? 'paired ✓' : w.pairPending ? 'pairing code pending' : 'not paired'}`)
  lines.push(`Autopilot: ${w.enabled ? 'on' : 'off'}`)
  return lines
}

export { SECRETS_FILE }
