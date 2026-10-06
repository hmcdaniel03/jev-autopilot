# Contributing to jev-autopilot

Thanks for helping. Every pull request to `main` is raised through
[no-mistakes](https://github.com/kunchenguid/no-mistakes), a local git gate that
reviews, tests and documents your branch before it opens the PR for you. A required
check rejects PRs that did not go through it, so please do not open one by hand.

## How to contribute

1. Install no-mistakes (v1.46.0 or newer). On macOS and Linux:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh
   ```

   Other platforms are in its
   [installation guide](https://kunchenguid.github.io/no-mistakes/start-here/installation/).
   You also need [Claude Code](https://claude.com/claude-code) and Node.js 22 or newer
   for the checks below.

2. Fork `hmcdaniel03/jev-autopilot` on GitHub, then clone this repository (not your
   fork), so `origin` points at the parent:

   ```sh
   git clone https://github.com/hmcdaniel03/jev-autopilot.git
   cd jev-autopilot
   no-mistakes init --fork-url https://github.com/<you>/jev-autopilot.git
   ```

3. Work on a branch, commit, and push through the gate instead of to GitHub:

   ```sh
   git checkout -b my-change
   # edit, commit
   git push no-mistakes my-change
   ```

   The pipeline reviews the change, runs the tests, updates docs, pushes the branch
   to your fork and opens the PR against `main` with a generated body. Act on its
   findings in the TUI (`no-mistakes attach`), or let your coding agent drive it with
   `/no-mistakes`. After the PR is open, push follow-up commits the same way; each run
   refreshes the PR body.

Small, focused PRs are easiest to review. Add a line under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md) for anything a user would notice. Security problems go
to [SECURITY.md](SECURITY.md), not a PR.

## What the required check verifies

The **PR must be raised via no-mistakes** check
([`.github/workflows/no-mistakes-required.yml`](.github/workflows/no-mistakes-required.yml))
reads only the PR body. It passes when the body carries:

- the no-mistakes signature line (`Updates from [git push no-mistakes](...)`);
- a pipeline attestation comment (`<!-- no-mistakes-pipeline-attestation:v1 ... -->`)
  whose `head_sha` is the PR's current head commit, so a commit pushed outside the
  gate fails until you push through it again;
- `review`, `test` and `document` all recorded as `completed`. A skipped step, or a
  Test step approved over a failing test command, does not count.

PRs opened by GitHub Actions, Dependabot and the maintainer are exempt. The check is
a guardrail against skipping the pipeline by accident, not proof against a body
written by hand to look like one; review still applies.

## What the pipeline runs

[`.no-mistakes.yaml`](.no-mistakes.yaml) makes the Test step run the same checks as
[CI](.github/workflows/ci.yml). To run them yourself:

```sh
claude plugin validate --strict .                          # manifest and hooks
claude plugin validate --strict .claude-plugin/marketplace.json
claude plugin test .                                       # tests, no account needed
npx -y -p typescript@5 tsc --noEmit -p .                   # after the mod has loaded once
```

The type check needs `.claude-plugin/types/`, which Claude Code generates whenever it
loads the mod; it is git-ignored. `claude --plugin-dir . -p '/autopilot status'`
generates it without signing in, which is what CI and the pipeline do (the pipeline
runs it under a throwaway `HOME` so it never touches your own autopilot state).

## Code map

- `hooks/core.ts` and `hooks/trust.ts` hold the pure logic and are unit-tested.
- `hooks/register.ts` wires them to the engine and is covered by harness tests in
  `tests/register.test.ts`.
- `hooks/setup.ts` is the `/autopilot setup` state machine and its printed text.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
The no-mistakes check is derived from
[kunchenguid/firstmate](https://github.com/kunchenguid/firstmate) (MIT); its notice
is kept in [`.github/scripts/require-no-mistakes.py`](.github/scripts/require-no-mistakes.py).
