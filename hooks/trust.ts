// Trust boundaries, as pure logic: secret redaction, the secrets file, Telegram
// pairing, and deciding whether a working directory is a genuine Firstmate checkout
// whose scripts may run. No `$` here so it tests cleanly.

// ---------------------------------------------------------------- redaction

const REDACTED = '[redacted]'

// Secret-looking text: bearer headers, `token=`/`key=`-style assignments, Telegram bot
// tokens and well-known API key prefixes. Applied to everything logged, thrown or sent.
const PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, REDACTED],
  [/\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, REDACTED],
  // (case-sensitive so the "looks like a secret" lookahead can ask for an upper-case letter or digit)
  [/([A-Za-z0-9_.-]*(?:token|key|secret|password|passwd|Token|Key|Secret|Password|Passwd|TOKEN|KEY|SECRET|PASSWORD|PASSWD)["']?\s*[=:]\s*["']?)(?=[^\s"'&;,)]*[0-9A-Z_-])([^\s"'&;,)]{8,})/g, `$1${REDACTED}`],
]

// `known` are the secrets this process holds (bot token, API key): always removed,
// whatever they look like.
export function redact(text: string, known: readonly (string | undefined)[] = []) {
  let out = text
  for (const k of known) if (k && k.length >= 4) out = out.split(k).join(REDACTED)
  for (const [re, to] of PATTERNS) out = out.replace(re, to)
  return out
}

// ---------------------------------------------------------------- secrets file

export const SECRETS_FILE = '~/.claude/jev-autopilot/secrets.env'

// KEY=VALUE lines; `export`, comments, blank lines and surrounding quotes are allowed.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]!.trim()
    const q = v[0]
    if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]!] = v
  }
  return out
}

// Is a file mode (octal text from `stat`, e.g. "600" or "100600") private to its owner?
export function modeIsPrivate(mode: string) {
  const m = /([0-7]{3,4})\s*$/.exec(mode.trim())
  if (!m) return undefined
  return (parseInt(m[1]!, 8) & 0o077) === 0
}

// ---------------------------------------------------------------- pairing

export type PairCode = { code: string; until: number; attempts: number }

export const PAIR_TTL_MS = 10 * 60_000
export const PAIR_ATTEMPTS = 3
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

// A fresh crypto-random code (10 characters, 50 bits), shown as XXXXX-XXXXX.
export function newPairCode(now: number, random: (n: number) => Uint8Array = n => crypto.getRandomValues(new Uint8Array(n))): PairCode {
  const bytes = random(10)
  const code = [...bytes].map(b => PAIR_ALPHABET[b % PAIR_ALPHABET.length]!).join('')
  return { code, until: now + PAIR_TTL_MS, attempts: 0 }
}

export const showPairCode = (c: PairCode) => `${c.code.slice(0, 5)}-${c.code.slice(5)}`

const normCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

export type PairOutcome =
  | { result: 'paired' }
  | { result: 'wrong'; state: PairCode; left: number }
  | { result: 'burned' }
  | { result: 'expired' }

// One guess against the pending code: paired, wrong (with attempts left), burned
// after the last wrong guess, or expired. The caller stores `state` or clears it.
export function tryPair(state: PairCode | undefined, text: string, now: number): PairOutcome | undefined {
  if (!state) return undefined
  if (state.until <= now) return { result: 'expired' }
  if (normCode(text) === state.code) return { result: 'paired' }
  const attempts = state.attempts + 1
  if (attempts >= PAIR_ATTEMPTS) return { result: 'burned' }
  return { result: 'wrong', state: { ...state, attempts }, left: PAIR_ATTEMPTS - attempts }
}

// ---------------------------------------------------------------- firstmate trust

// The upstream project. Its scripts are what the plugin runs, so only a checkout of it
// (or one the user explicitly listed) counts as a Firstmate home.
export const FIRSTMATE_REPO = 'github.com/kunchenguid/firstmate'

// Scripts the plugin executes from a Firstmate home; each must be git-tracked and clean.
export const FIRSTMATE_SCRIPTS = ['bin/fm-captain-hold.sh', 'bin/fm-fleet-snapshot.sh'] as const

// `https://github.com/X/Y.git`, `git@github.com:X/Y`, `ssh://git@github.com/X/Y/` all
// become `github.com/x/y`.
export function normalizeRemote(url: string) {
  let u = url.trim().toLowerCase()
  u = u.replace(/^[a-z+]+:\/\//, '') // scheme
  u = u.replace(/^[^@/]+@/, '') // user@
  u = u.replace(/^([^/:]+):(?!\d)/, '$1/') // scp-like host:path
  u = u.replace(/^([^/]+):\d+\//, '$1/') // host:port
  u = u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  return u
}

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// What the detector needs from the world: file presence and git, nothing else.
export type FmProbe = {
  exists: (path: string) => Promise<boolean>
  git: (args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>
}

export type FmDetection = { home: true } | { home: false; reason: string }

// Is `cwd` a Firstmate checkout the plugin may run scripts from? All of:
//   - bin/fm-captain-hold.sh and AGENTS.md are present,
//   - cwd is the top level of a git repository,
//   - its `origin` or `upstream` remote points at FIRSTMATE_REPO, or cwd / the remote
//     is listed in `extra` (absolute paths or remote URLs the user configured), and
//   - the scripts to run are tracked and have no uncommitted changes against the
//     checked-out HEAD (how old that HEAD is does not matter).
export async function detectFirstmate(probe: FmProbe, cwd: string, extra: readonly string[] = []): Promise<FmDetection> {
  const no = (reason: string): FmDetection => ({ home: false, reason })
  for (const f of ['bin/fm-captain-hold.sh', 'AGENTS.md']) {
    if (!(await probe.exists(`${cwd}/${f}`))) return no(`${f} is missing`)
  }
  const cdup = await probe.git(['rev-parse', '--show-cdup'])
  if (cdup.exitCode !== 0) return no('not a git repository')
  if (cdup.stdout.trim() !== '') return no('not the top level of its git repository')

  const trustedPath = extra.some(e => (e.startsWith('/') || e.startsWith('~') || /^[A-Za-z]:[\\/]/.test(e)) && normPath(e) === normPath(cwd))
  if (!trustedPath) {
    const wanted = new Set([FIRSTMATE_REPO, ...extra.filter(e => !e.startsWith('/') && !e.startsWith('~') && !/^[A-Za-z]:[\\/]/.test(e)).map(normalizeRemote)])
    let matched = false
    for (const remote of ['origin', 'upstream']) {
      const r = await probe.git(['remote', 'get-url', remote])
      if (r.exitCode === 0 && wanted.has(normalizeRemote(r.stdout))) matched = true
    }
    if (!matched) return no(`neither origin nor upstream points at ${FIRSTMATE_REPO}`)
  }
  return scriptsClean(probe)
}

// The scripts the plugin runs are tracked and unmodified against HEAD. Checked again
// right before each run, so an edit made after detection still stops them.
export async function scriptsClean(probe: FmProbe, scripts: readonly string[] = FIRSTMATE_SCRIPTS): Promise<FmDetection> {
  const tracked = await probe.git(['ls-files', '--error-unmatch', '--', ...scripts])
  if (tracked.exitCode !== 0) return { home: false, reason: 'a Firstmate script is not tracked by git' }
  const status = await probe.git(['status', '--porcelain', '--', ...scripts])
  if (status.exitCode !== 0) return { home: false, reason: 'git status failed' }
  const dirty = status.stdout.split('\n').filter(l => l.trim()).map(l => l.slice(3).trim())
  if (dirty.length) return { home: false, reason: `uncommitted changes in ${dirty.join(', ')}` }
  return { home: true }
}
