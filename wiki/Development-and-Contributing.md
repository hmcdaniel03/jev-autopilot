# Development and Contributing

jev-autopilot is a Claude Code mod: a plugin whose `hooks/hooks.json` names a TypeScript module that registers hook handlers against the engine interface (`$`). It is developed in the author's monorepo and exported to the public repository as a flat history.

## Repository layout

| Path | What |
| --- | --- |
| `.claude-plugin/plugin.json` | The plugin manifest: name, version, and the `userConfig` options with their defaults and descriptions. |
| `.claude-plugin/marketplace.json` | Lets the repository itself be added as a marketplace (`claude plugin marketplace add hmcdaniel03/jev-autopilot`). |
| `hooks/hooks.json` | `{ "modules": ["./register.ts"] }`. |
| `hooks/register.ts` | The wiring: secrets, the Telegram poller and listener lease, the slash command, the `AskUserQuestion` and tool-call hooks, keep-going, the `/autopilot setup` runner. Everything that touches `$`. |
| `hooks/core.ts` | Pure logic: Jev request builders and verdicts, Telegram message formatting and update classification, markdown-to-Telegram HTML, roles, the Firstmate snapshot readers, temp-cleanup detection, internal-script detection. No `$`. |
| `hooks/trust.ts` | Pure trust logic: secret redaction, the secrets-file parser and mode check, pairing codes, Firstmate detection. No `$`. |
| `hooks/setup.ts` | The `/autopilot setup` state machine and every line it prints, per OS. No `$`. |
| `tests/*.test.ts` | Unit tests for the pure modules and harness tests for `register.ts`. |
| `scripts/export-public.sh` | Copies the plugin folder into an empty directory as a fresh repository with one commit. |
| `scripts/publish-wiki.sh` | Pushes `wiki/` to the GitHub wiki. |
| `wiki/` | The sources of this wiki. |
| `.github/workflows/ci.yml` | CI for the public repository. |
| `CHANGELOG.md`, `SECURITY.md`, `LICENSE`, `README.md` | What they say. |

## Checks

```sh
claude plugin validate --strict .                      # manifest and hooks; warnings are errors
claude plugin validate --strict .claude-plugin/marketplace.json
claude plugin test .                                   # the tests; no account, sign-in or network needed
claude --plugin-dir . -p '/autopilot status'           # generates .claude-plugin/types/ (git-ignored), signed out
npx -y -p typescript@5 tsc --noEmit -p .               # type check, after the line above
```

All of these must stay green. `tsconfig.json` extends the engine-generated `.claude-plugin/types/tsconfig.json`, which is why the mod has to be loaded once before `tsc`.

### Tests

`claude plugin test` runs the files under `tests/` in a child of the Claude Code binary. `core.test.ts`, `trust.test.ts` and `setup.test.ts` call the pure functions directly. `register.test.ts` loads the mod in the engine's harness with a mocked environment and store, hooks its `http.fetch`, `process.run`, `fs.*`, `store.*` and `ui.*` operations, and asserts on toasts, denials, log lines and Telegram calls. Two harness details worth knowing: an operation such as `store.set` can be hooked once per test (so do not combine `mock.store` with your own `store.*` hook), and the test's `$` has no `store` noun to read back; assert through the hook instead.

### Validator sharp edge

`claude plugin validate` scans the module's source. A local variable named like a function that receives `$` (for example `let jev` beside `async function jev($)`) fails validation as "assigned to elsewhere". Pick a different local name.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request of the public repository (it is a no-op while the plugin lives in a subfolder of another repository, because GitHub only runs workflows from the root). No job needs an account or a secret:

- **validate-and-test**: installs Claude Code, validates the plugin and the marketplace manifest with `--strict`, runs the tests.
- **typecheck**: installs Claude Code and Node 22, loads the mod once with `claude --plugin-dir . -p '/autopilot status'` to generate the types, checks they exist, runs `tsc`.

## Conventions

- Keep logic that can be pure in `core.ts`, `trust.ts` or `setup.ts`, with a unit test; keep `register.ts` to wiring.
- Everything logged, thrown or sent goes through `redact()`. A new place that could carry a secret (an error message quoting a URL, a toast) must too.
- Any text that names the owner uses `ownerName` (`owner()` in `register.ts`, a parameter in `core.ts`), never a hard-coded name.
- Paths and commands shown to users are spelled for macOS/Linux and for Windows.
- Record user-visible changes in `CHANGELOG.md` under Unreleased.
- Nothing private in the repository or this wiki: no personal paths, chat ids, tokens or project names.

## Releasing to the public repository

The monorepo is the source of truth. `scripts/export-public.sh <empty dir>` copies the plugin folder (everything except `.git`, the generated types, `node_modules`, `.env`, `*.local.json` and `.DS_Store`) into a fresh repository with a single commit named after the version in `plugin.json`, adds no remote and pushes nowhere; pushing is a separate, deliberate step that the script prints. The `wiki/` folder ships with the code on purpose: the docs are reviewed in the same pull requests as the behaviour they describe, and the publish script below works from a public clone too.

## Publishing this wiki

GitHub stores a wiki as its own git repository (`<repo>.wiki.git`). The sources live in `wiki/` so they are versioned and reviewed with the code; `scripts/publish-wiki.sh` pushes them:

```sh
scripts/publish-wiki.sh              # clone the wiki repo to a temp dir, sync wiki/ into it, commit, push
scripts/publish-wiki.sh --dry-run    # everything but the push; prints the diff summary
WIKI_REPO=git@github.com:you/fork.wiki.git scripts/publish-wiki.sh   # another wiki repository
```

The wiki must exist once before the first push: create any page in the repository's Wiki tab on GitHub, which creates the `.wiki.git` repository. The script removes pages that no longer exist in `wiki/`, so the folder is the whole wiki.

Conventions in `wiki/`:

- `Home.md` is the front page; `_Sidebar.md` and `_Footer.md` are the navigation and footer GitHub shows on every page.
- A page's file name is its title with spaces as hyphens (`How-Autopilot-Works.md` is "How Autopilot Works").
- Link pages as `[[Page Title]]`, or `[[shown text|Page Title]]`; link headings as `[text](#heading-slug)`.
- Diagrams are fenced ` ```mermaid ` blocks, which GitHub renders.
- Keep the README the short entry point and put detail here.

## Contributing

Open an issue or a pull request on the public repository. For a vulnerability, use private reporting instead (see `SECURITY.md`). Keep pull requests small, add or update a test for behaviour, and run the checks above. The maintainer imports accepted changes into the monorepo and re-exports.
