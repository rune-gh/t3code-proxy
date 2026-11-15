#!/bin/sh
# Build the hub artifacts from this fork's current checkout (the t3code branch).
# Usage: sh fork/build.sh [base-tag]   e.g. sh fork/build.sh v8.0.72
#   base-tag defaults to the nearest upstream v* tag below HEAD.
# Output: fork/out/cli-proxy-api.exe (windows/amd64), fork/out/management.html
# (the dashboard), and their SHA256s.
#
# Version metadata comes from the upstream base tag plus the fork commit, so the
# same commit + Go version always give the same exe SHA256 and the deployed exe
# can be re-verified by rebuilding it.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
tag="${1:-$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)}"
git merge-base --is-ancestor "$tag" HEAD || { echo "$tag is not an ancestor of HEAD; rebase t3code onto it first (see FORK.md)." >&2; exit 1; }
[ -z "$(git status --porcelain -- . ':!fork/out')" ] || { echo "Working tree is dirty; commit or stash first so the build matches a commit." >&2; exit 1; }

go test -count=1 ./sdk/cliproxy/auth/ ./sdk/cliproxy/ ./internal/api/handlers/management/ ./internal/config/ ./internal/quotahistory/

version="${tag#v}-t3code"
commit="$(git rev-parse --short=8 HEAD)"
date="$(git log -1 --format=%cI HEAD)"
mkdir -p fork/out
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags="-s -w -X 'main.Version=$version' -X 'main.Commit=$commit' -X 'main.BuildDate=$date'" \
  -o fork/out/cli-proxy-api.exe ./cmd/server/

(cd web && bun install --frozen-lockfile >/dev/null && bun run verify >/dev/null)
cp web/dist/index.html fork/out/management.html

echo "Built $version ($commit) with $(go env GOVERSION)"
shasum -a 256 fork/out/cli-proxy-api.exe fork/out/management.html
