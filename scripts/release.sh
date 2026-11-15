#!/bin/sh
# Cross-build release archives and a checksums file into dist/.
#
# Usage: scripts/release.sh [goos/goarch ...]
#   default targets: linux/amd64 linux/arm64 darwin/amd64 darwin/arm64
#                    windows/amd64 windows/arm64
#
# Environment:
#   SKIP_WEB=1   reuse the panel already staged by scripts/web.sh
#   VERSION, COMMIT, BUILD_DATE override scripts/buildinfo.sh
#
# Output: dist/t3code-proxy_<version>_<os>_<arch>.tar.gz (.zip on Windows) and
# dist/checksums.txt in sha256sum format.
#
# All targets are built with CGO_ENABLED=0 so one host can build them all.
# Consequence: Linux and macOS archives cannot load dynamic library plugins
# (that loader needs CGO); the Windows loader is pure Go and still works.
# The container image is built natively with CGO and keeps plugin support.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# shellcheck source=scripts/buildinfo.sh
. "$root/scripts/buildinfo.sh"

targets="$*"
[ -n "$targets" ] || targets="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64"

embedded="internal/managementasset/embedded/management.html"
if [ "${SKIP_WEB:-0}" = "1" ]; then
  [ -f "$embedded" ] || { echo "SKIP_WEB=1 but $embedded is missing; run scripts/web.sh first" >&2; exit 1; }
else
  sh "$root/scripts/web.sh"
fi

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# Deterministic archive metadata where GNU tar is available.
tar_flags=""
if tar --version 2>/dev/null | grep -q GNU; then
  epoch="$(git log -1 --format=%ct HEAD 2>/dev/null || echo 0)"
  tar_flags="--sort=name --owner=0 --group=0 --numeric-owner --mtime=@$epoch"
elif [ "$(uname -s)" = "Darwin" ]; then
  # bsdtar: keep macOS extended attributes out of the archives.
  tar_flags="--no-mac-metadata --no-xattrs"
  COPYFILE_DISABLE=1
  export COPYFILE_DISABLE
fi

mkdir -p dist
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT INT TERM

for target in $targets; do
  goos="${target%/*}"
  goarch="${target#*/}"
  name="t3code-proxy_${VERSION}_${goos}_${goarch}"
  dir="$stage/$name"
  mkdir -p "$dir"
  bin="t3code-proxy"
  [ "$goos" = "windows" ] && bin="t3code-proxy.exe"

  echo "==> $goos/$goarch"
  # shellcheck disable=SC2086 # GOFLAGS_REPRO is a list of flags.
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
    go build $GOFLAGS_REPRO -ldflags="$LDFLAGS" -o "$dir/$bin" ./cmd/server
  cp LICENSE README.md config.example.yaml config.hub.example.yaml "$dir/"
  cp -R deploy "$dir/deploy"

  rm -f "dist/$name.tar.gz" "dist/$name.zip"
  if [ "$goos" = "windows" ]; then
    (cd "$stage" && zip -qrX "$root/dist/$name.zip" "$name")
  else
    # shellcheck disable=SC2086 # tar_flags is a list of flags.
    (cd "$stage" && tar $tar_flags -czf "$root/dist/$name.tar.gz" "$name")
  fi
done

(
  cd dist
  # Checksum every archive of this version, including targets built earlier.
  set -- t3code-proxy_"${VERSION}"_*.tar.gz t3code-proxy_"${VERSION}"_*.zip
  files=""
  for f in "$@"; do [ -f "$f" ] && files="$files $f"; done
  # shellcheck disable=SC2086 # files is a list of names without spaces.
  sha256 $files | sort -k2 > checksums.txt
)

echo "Release $VERSION ($COMMIT) written to dist/:"
cat dist/checksums.txt
