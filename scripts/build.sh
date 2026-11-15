#!/bin/sh
# Build one t3code-proxy binary with reproducible flags.
#
# Usage: scripts/build.sh [-o output] [--web]
#   -o output  output path (default: bin/t3code-proxy, .exe added for windows)
#   --web      build and embed the web panel first (scripts/web.sh)
#
# Environment: GOOS, GOARCH, CGO_ENABLED select the target as usual; VERSION,
# COMMIT, BUILD_DATE override the metadata from scripts/buildinfo.sh.
#
# CGO: dynamic library plugins need CGO on Linux and macOS; the Windows plugin
# loader is pure Go. A native build uses Go's default (CGO on when a C compiler
# is present). Cross-builds from scripts/release.sh set CGO_ENABLED=0.
#
# Without --web the binary embeds whatever panel is already staged at
# internal/managementasset/embedded/management.html, or none.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

out=""
web=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) [ $# -ge 2 ] || { echo "-o needs a path" >&2; exit 2; }; out="$2"; shift 2 ;;
    --web) web=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# shellcheck source=scripts/buildinfo.sh
. "$root/scripts/buildinfo.sh"

if [ "$web" -eq 1 ]; then
  sh "$root/scripts/web.sh"
fi

goos="${GOOS:-$(go env GOOS)}"
if [ -z "$out" ]; then
  out="bin/t3code-proxy"
  [ "$goos" = "windows" ] && out="$out.exe"
fi
mkdir -p "$(dirname "$out")"

# shellcheck disable=SC2086 # GOFLAGS_REPRO is a list of flags.
go build $GOFLAGS_REPRO -ldflags="$LDFLAGS" -o "$out" ./cmd/server

echo "Built $out: t3code-proxy $VERSION ($COMMIT) $goos/${GOARCH:-$(go env GOARCH)} cgo=${CGO_ENABLED:-$(go env CGO_ENABLED)} with $(go env GOVERSION)"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$out"; else shasum -a 256 "$out"; fi
