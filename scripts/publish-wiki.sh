#!/usr/bin/env bash
# Publishes wiki/ to the GitHub wiki of the public repository. GitHub keeps a wiki as
# its own git repository (<repo>.wiki.git); this clones it into a temporary directory,
# replaces its pages with the contents of wiki/, commits and pushes.
#
#   scripts/publish-wiki.sh              # sync, commit, push
#   scripts/publish-wiki.sh --dry-run    # sync and show what would change; no commit, no push
#
# WIKI_REPO overrides the wiki repository (default: the public repo's wiki over https).
# The wiki must exist once before the first push: create any page in the repository's
# Wiki tab on GitHub, which creates the .wiki.git repository.
set -euo pipefail

repo=${WIKI_REPO:-https://github.com/hmcdaniel03/jev-autopilot.wiki.git}
src=$(cd "$(dirname "$0")/../wiki" && pwd -P)
dry=0
case "${1:-}" in
  --dry-run) dry=1 ;;
  '') ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

[ -f "$src/Home.md" ] || { echo "refusing: $src has no Home.md" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git clone -q "$repo" "$tmp/wiki"

# wiki/ is the whole wiki: pages that are not in it any more are removed.
find "$tmp/wiki" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
(
  cd "$src"
  find . -type f ! -name '.DS_Store' -print0
) | while IFS= read -r -d '' f; do
  mkdir -p "$tmp/wiki/$(dirname "$f")"
  cp -p "$src/$f" "$tmp/wiki/$f"
done

cd "$tmp/wiki"
git add -A
if git diff --cached --quiet; then
  echo "wiki is up to date with $src"
  exit 0
fi
git --no-pager diff --cached --stat
if [ "$dry" = 1 ]; then
  echo "dry run: not committing or pushing"
  exit 0
fi

rev=$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)
git commit -q -m "wiki: sync from wiki/ at $rev"
git push -q origin HEAD
echo "published to $repo"
