#!/usr/bin/env bash
# Copies this plugin folder into an empty directory as a fresh git repository with a
# single commit: no monorepo history, no sibling mods, no local settings or generated
# types. Adds no remote and pushes nowhere; that is a separate, deliberate step.
#
#   scripts/export-public.sh /path/to/empty/dir
#
# EXPORT_AUTHOR / EXPORT_EMAIL override the commit author (default: your git config).
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd -P)
dest=${1:-}
if [ -z "$dest" ]; then
  echo "usage: $0 <empty directory>" >&2
  exit 2
fi
mkdir -p "$dest"
dest=$(cd "$dest" && pwd -P)
if [ -n "$(ls -A "$dest")" ]; then
  echo "refusing: $dest is not empty" >&2
  exit 1
fi
case "$dest" in "$src"|"$src"/*) echo "refusing: $dest is inside the plugin folder" >&2; exit 1;; esac

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$src/.claude-plugin/plugin.json" | head -1)

# Everything tracked or trackable in the plugin folder, minus what never ships.
(
  cd "$src"
  find . -type f \
    ! -path './.git/*' \
    ! -path './.claude-plugin/types/*' \
    ! -path './node_modules/*' \
    ! -name '.env' \
    ! -name '*.local.json' \
    ! -name '.DS_Store' \
    -print0
) | while IFS= read -r -d '' f; do
  mkdir -p "$dest/$(dirname "$f")"
  cp -p "$src/$f" "$dest/$f"
done

cd "$dest"
git init -q -b main
git add -A
author_name=${EXPORT_AUTHOR:-$(git config user.name || true)}
author_email=${EXPORT_EMAIL:-$(git config user.email || true)}
if [ -z "$author_name" ] || [ -z "$author_email" ]; then
  echo "set EXPORT_AUTHOR and EXPORT_EMAIL (or git config user.name/user.email)" >&2
  exit 1
fi
GIT_AUTHOR_NAME=$author_name GIT_AUTHOR_EMAIL=$author_email \
GIT_COMMITTER_NAME=$author_name GIT_COMMITTER_EMAIL=$author_email \
  git commit -q -m "jev-autopilot ${version:-0.1.0}" -m "Initial public import."

echo "exported jev-autopilot ${version:-0.1.0} to $dest as one commit on main (no remote):"
git --no-pager log --oneline -1
git --no-pager ls-files | sed 's/^/  /'
echo
echo "next, when you are ready to publish:"
echo "  cd $dest && git remote add origin git@github.com:hmcdaniel03/jev-autopilot.git && git push -u origin main"
