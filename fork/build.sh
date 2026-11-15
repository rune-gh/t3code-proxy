#!/bin/sh
# Build the hub binary from this fork's current checkout (the t3code branch).
# Usage: sh fork/build.sh [base-tag]   e.g. sh fork/build.sh v8.0.72
#   base-tag defaults to the nearest upstream v* tag below HEAD.
# Output: fork/out/cli-proxy-api.exe (windows/amd64) and its SHA256.
#
# Version metadata comes from the upstream base tag, not from the fork commits,
# so the same tag + routing commit + Go version always give the same SHA256 and
# the deployed exe can be re-verified by rebuilding it.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
tag="${1:-$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)}"
git merge-base --is-ancestor "$tag" HEAD || { echo "$tag is not an ancestor of HEAD; rebase t3code onto it first (see FORK.md)." >&2; exit 1; }
[ -z "$(git status --porcelain -- . ':!fork/out')" ] || { echo "Working tree is dirty; commit or stash first so the build matches a commit." >&2; exit 1; }

go test -count=1 ./sdk/cliproxy/auth/ ./sdk/cliproxy/ ./internal/api/handlers/management/ ./internal/config/

version="${tag#v}-reset-routing"
commit="$(git rev-parse --short "$tag")-srf"
date="$(git log -1 --format=%cI "$tag")"
mkdir -p fork/out
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags="-s -w -X 'main.Version=$version' -X 'main.Commit=$commit' -X 'main.BuildDate=$date'" \
  -o fork/out/cli-proxy-api.exe ./cmd/server/
echo "Built $version ($commit) with $(go env GOVERSION): $(shasum -a 256 fork/out/cli-proxy-api.exe | cut -d' ' -f1)"
