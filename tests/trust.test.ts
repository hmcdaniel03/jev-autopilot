import { expect, test } from 'claude-code/testing'

import {
  detectFirstmate, modeIsPrivate, newPairCode, normalizeRemote, parseEnvFile, redact, scriptsClean, showPairCode, tryPair,
  FIRSTMATE_SCRIPTS, PAIR_ATTEMPTS, PAIR_TTL_MS,
} from '../hooks/trust'
import type { FmProbe, PairCode } from '../hooks/trust'

// ---------------------------------------------------------------- redaction

test('secrets are redacted from logged, thrown and forwarded text', () => {
  const token = '123456789:FAKEtokenFAKEtokenFAKEtokenFAKEtok' // shaped like a bot token, obviously not one
  expect(redact(`fetch failed: https://api.telegram.org/bot${token}/sendMessage`)).toBe('fetch failed: https://api.telegram.org/bot[redacted]/sendMessage')
  expect(redact('curl -H "Authorization: Bearer sk_live_abcDEF123456" https://x')).toBe('curl -H "Authorization: Bearer [redacted]" https://x')
  expect(redact('curl "https://x/?token=AbC123456789&x=1"')).toBe('curl "https://x/?token=[redacted]&x=1"')
  expect(redact('export TYPESAFE_API_KEY=ts_Live0123456789')).toBe('export TYPESAFE_API_KEY=[redacted]')
  expect(redact('api_key: "ABCDEFGH12"')).toBe('api_key: "[redacted]"')
  expect(redact('password=Hunter2!x')).toBe('password=[redacted]')
  expect(redact('ghp_FAKEtokenFAKEtokenFAKEtoken')).toBe('[redacted]')
  // a secret this process holds is removed whatever it looks like
  expect(redact('oops: plainsecretvalue here', ['plainsecretvalue'])).toBe('oops: [redacted] here')
  expect(redact('short', ['abc', undefined])).toBe('short')
  // ordinary prose survives
  for (const s of ['Jev key: missing (TYPESAFE_API_KEY)', 'the key: set', 'git push origin main', 'rm -rf build', 'Telegram: token set (file), paired']) {
    expect(redact(s)).toBe(s)
  }
})

// ---------------------------------------------------------------- secrets file

test('the secrets file is parsed like an env file and must be private', () => {
  expect(parseEnvFile('# bot\nTELEGRAM_BOT_TOKEN=123:abc\nexport TYPESAFE_API_KEY="ts key"\n\nTELEGRAM_CHAT_ID=\'42\'  \nbad line\nX=y # note\n'))
    .toEqual({ TELEGRAM_BOT_TOKEN: '123:abc', TYPESAFE_API_KEY: 'ts key', TELEGRAM_CHAT_ID: '42', X: 'y' })
  expect(modeIsPrivate('600')).toBe(true)
  expect(modeIsPrivate('400\n')).toBe(true)
  expect(modeIsPrivate('100600')).toBe(true)
  expect(modeIsPrivate('644')).toBe(false)
  expect(modeIsPrivate('660')).toBe(false)
  expect(modeIsPrivate('-rw-------')).toBeUndefined()
})

// ---------------------------------------------------------------- pairing

test('pairing codes are random, long, short-lived and burn after a few wrong guesses', () => {
  const fixed = (n: number) => new Uint8Array(n).map((_, i) => i * 37)
  const code = newPairCode(1000, fixed)
  expect(code.code).toHaveLength(10)
  expect(code.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)
  expect(code.until).toBe(1000 + PAIR_TTL_MS)
  expect(showPairCode(code)).toBe(`${code.code.slice(0, 5)}-${code.code.slice(5)}`)
  expect(newPairCode(0).code).not.toBe(newPairCode(0).code) // real randomness
  expect(newPairCode(0).code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)

  const now = 2000
  expect(tryPair(undefined, code.code, now)).toBeUndefined()
  expect(tryPair(code, code.code, now)).toEqual({ result: 'paired' })
  expect(tryPair(code, showPairCode(code).toLowerCase(), now)).toEqual({ result: 'paired' }) // dashes and case are forgiven
  expect(tryPair(code, code.code, code.until)).toEqual({ result: 'expired' })

  let state: PairCode = code
  for (let i = 1; i < PAIR_ATTEMPTS; i++) {
    const out = tryPair(state, 'nope', now)
    expect(out).toMatchObject({ result: 'wrong', left: PAIR_ATTEMPTS - i })
    state = (out as { state: PairCode }).state
    expect(state.attempts).toBe(i)
  }
  expect(tryPair(state, 'nope', now)).toEqual({ result: 'burned' })
  expect(tryPair(state, code.code, now)).toEqual({ result: 'paired' }) // the right code still works before the burn
})

// ---------------------------------------------------------------- firstmate

test('remote URLs normalise across https, ssh, scp, .git and case', () => {
  for (const u of [
    'https://github.com/kunchenguid/firstmate',
    'https://github.com/kunchenguid/firstmate.git',
    'https://github.com/KunChenGuid/FirstMate.git/',
    'git@github.com:kunchenguid/firstmate.git',
    'ssh://git@github.com/kunchenguid/firstmate',
    'ssh://git@github.com:22/kunchenguid/firstmate.git',
    'git://github.com/kunchenguid/firstmate',
  ]) expect(normalizeRemote(u)).toBe('github.com/kunchenguid/firstmate')
  expect(normalizeRemote('https://github.com/someone/firstmate')).toBe('github.com/someone/firstmate')
  expect(normalizeRemote('/Users/sam/firstmate')).toBe('/users/sam/firstmate')
})

type Repo = {
  files?: string[]
  git?: boolean
  cdup?: string
  origin?: string
  upstream?: string
  untracked?: string[]
  dirty?: string[]
  head?: string
}

// A fake checkout: only the git calls the detector may make are answered; anything
// else (a fetch, a comparison with upstream) throws, so the test proves it never happens.
function repo(r: Repo): FmProbe {
  const files = new Set((r.files ?? ['bin/fm-captain-hold.sh', 'AGENTS.md', ...FIRSTMATE_SCRIPTS]).map(f => `/home/fm/${f}`))
  const git: FmProbe['git'] = async args => {
    if (r.git === false) return { exitCode: 128, stdout: '' }
    const [cmd, ...rest] = args
    if (cmd === 'rev-parse' && rest[0] === '--show-cdup') return { exitCode: 0, stdout: `${r.cdup ?? ''}\n` }
    if (cmd === 'remote' && rest[0] === 'get-url') {
      const url = rest[1] === 'origin' ? r.origin : rest[1] === 'upstream' ? r.upstream : undefined
      return url ? { exitCode: 0, stdout: `${url}\n` } : { exitCode: 2, stdout: '' }
    }
    if (cmd === 'ls-files') {
      const paths = rest.slice(rest.indexOf('--') + 1)
      return paths.some(p => (r.untracked ?? []).includes(p)) ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: paths.join('\n') }
    }
    if (cmd === 'status' && rest[0] === '--porcelain') {
      const paths = rest.slice(rest.indexOf('--') + 1)
      return { exitCode: 0, stdout: paths.filter(p => (r.dirty ?? []).includes(p)).map(p => ` M ${p}\n`).join('') }
    }
    throw new Error(`unexpected git call: git ${args.join(' ')}`)
  }
  return { exists: async p => files.has(p), git }
}

const detect = (r: Repo, extra?: string[]) => detectFirstmate(repo(r), '/home/fm', extra)

test('a genuine Firstmate checkout is detected, however old its HEAD is', async () => {
  expect(await detect({ origin: 'https://github.com/kunchenguid/firstmate' })).toEqual({ home: true })
  expect(await detect({ origin: 'https://github.com/kunchenguid/firstmate.git' })).toEqual({ home: true })
  // ssh remote
  expect(await detect({ origin: 'git@github.com:kunchenguid/firstmate.git' })).toEqual({ home: true })
  // a stale checkout many commits behind: nothing compares it with upstream, so it still counts
  expect(await detect({ origin: 'https://github.com/kunchenguid/firstmate', head: 'c0ffee0 (2025-01-01)' })).toEqual({ home: true })
  // a fork whose upstream points at the project
  expect(await detect({ origin: 'git@github.com:sam/firstmate.git', upstream: 'https://github.com/kunchenguid/firstmate' })).toEqual({ home: true })
})

test('a folder with the right file names but no Firstmate behind it is not a home', async () => {
  // the files alone (no git at all): a hostile clone of just the file names
  expect(await detect({ git: false })).toMatchObject({ home: false, reason: 'not a git repository' })
  // one of the marker files missing
  expect(await detect({ files: ['AGENTS.md'], origin: 'https://github.com/kunchenguid/firstmate' })).toMatchObject({ home: false, reason: 'bin/fm-captain-hold.sh is missing' })
  // a subdirectory of a checkout
  expect(await detect({ cdup: '../', origin: 'https://github.com/kunchenguid/firstmate' })).toMatchObject({ home: false, reason: 'not the top level of its git repository' })
  // the wrong remote, or none
  expect(await detect({ origin: 'https://github.com/someone-else/firstmate' })).toMatchObject({ home: false, reason: 'neither origin nor upstream points at github.com/kunchenguid/firstmate' })
  expect(await detect({})).toMatchObject({ home: false })
  // a run script with uncommitted edits, or not tracked at all
  expect(await detect({ origin: 'https://github.com/kunchenguid/firstmate', dirty: ['bin/fm-fleet-snapshot.sh'] }))
    .toEqual({ home: false, reason: 'uncommitted changes in bin/fm-fleet-snapshot.sh' })
  expect(await detect({ origin: 'https://github.com/kunchenguid/firstmate', untracked: ['bin/fm-captain-hold.sh'] }))
    .toMatchObject({ home: false, reason: 'a Firstmate script is not tracked by git' })
})

test('configured extra remotes and paths are trusted too; scripts must still be clean', async () => {
  const fork = { origin: 'git@github.com:sam/firstmate-fork.git' }
  expect(await detect(fork)).toMatchObject({ home: false })
  expect(await detect(fork, ['https://github.com/sam/firstmate-fork'])).toEqual({ home: true })
  expect(await detect(fork, ['/home/fm'])).toEqual({ home: true })
  expect(await detect(fork, ['/home/fm/'])).toEqual({ home: true })
  expect(await detect(fork, ['/home/other'])).toMatchObject({ home: false })
  expect(await detect({ ...fork, dirty: ['bin/fm-captain-hold.sh'] }, ['/home/fm'])).toMatchObject({ home: false, reason: 'uncommitted changes in bin/fm-captain-hold.sh' })
  // the re-check before each run sees a later edit
  expect(await scriptsClean(repo({ origin: 'https://github.com/kunchenguid/firstmate', dirty: ['bin/fm-captain-hold.sh'] }))).toMatchObject({ home: false })
  expect(await scriptsClean(repo({ origin: 'https://github.com/kunchenguid/firstmate' }))).toEqual({ home: true })
})
