# shellcheck shell=sh disable=SC2034 # variables are used by the sourcing scripts
# Shared build metadata, sourced by scripts/build.sh and scripts/release.sh.
#
# Sets VERSION, COMMIT, BUILD_DATE, LDFLAGS, and GOFLAGS_REPRO. Each can be
# overridden from the environment. The values depend only on the checkout, so
# the same commit and Go version produce the same binary.
#   VERSION     exact v* tag on HEAD without the "v", else "dev"
#   COMMIT      short commit hash
#   BUILD_DATE  commit date (not wall clock, for reproducibility)

if [ -z "${VERSION:-}" ]; then
  if tag="$(git describe --tags --exact-match --match 'v[0-9]*' HEAD 2>/dev/null)"; then
    VERSION="${tag#v}"
  else
    VERSION="dev"
  fi
fi
COMMIT="${COMMIT:-$(git rev-parse --short=8 HEAD 2>/dev/null || echo none)}"
BUILD_DATE="${BUILD_DATE:-$(git log -1 --format=%cI HEAD 2>/dev/null || echo unknown)}"
LDFLAGS="-s -w -X 'main.Version=$VERSION' -X 'main.Commit=$COMMIT' -X 'main.BuildDate=$BUILD_DATE'"
GOFLAGS_REPRO="-trimpath -buildvcs=false"
export VERSION COMMIT BUILD_DATE
