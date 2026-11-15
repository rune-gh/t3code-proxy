#!/bin/sh
# Build the web management panel and stage it for go:embed.
#
# Usage: scripts/web.sh [--verify]
#   --verify  run the panel's tests and lint before building (what CI runs)
#
# Output: web/dist/index.html, copied to
# internal/managementasset/embedded/management.html (gitignored), which the
# Go build embeds when present.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

script="build"
case "${1:-}" in
  "") ;;
  --verify) script="verify" ;;
  *) echo "usage: scripts/web.sh [--verify]" >&2; exit 2 ;;
esac

command -v bun >/dev/null 2>&1 || { echo "bun is required to build the web panel: https://bun.sh" >&2; exit 1; }

(cd web && bun install --frozen-lockfile && bun run "$script")

dest="internal/managementasset/embedded/management.html"
mkdir -p "$(dirname "$dest")"
cp web/dist/index.html "$dest"
echo "Staged web panel at $dest"
