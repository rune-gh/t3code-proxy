#!/bin/sh
# Install, update, or remove the t3code-proxy hub on Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/rune-gh/t3code-proxy/main/scripts/install.sh | sh
#   sh install.sh [options]
#
# Options:
#   --version X    release to install, e.g. 0.1.0 or v0.1.0 (default: latest)
#   --dir DIR      install directory (default: ~/.local/share/t3code-proxy)
#   --bin-dir DIR  where the t3code-proxy command is linked (default: ~/.local/bin)
#   --archive F    install from a local release archive instead of downloading;
#                  verified against checksums.txt next to it when present
#   --no-service   do not install or restart the systemd/launchd service
#   --dry-run      print what would be done without changing anything
#   --uninstall    remove the binary and service; keep config, logs, and accounts
#   -h, --help     show this help
#
# Safe to re-run: an existing config.yaml is never overwritten, so re-running
# upgrades the binary and service in place. A new config gets a freshly
# generated access key and management secret; they are written only to
# config.yaml (mode 600) and never printed.
set -eu

REPO="rune-gh/t3code-proxy"
NAME="t3code-proxy"
LABEL="com.t3code-proxy.hub"

version=""
install_dir="${HOME}/.local/share/${NAME}"
bin_dir="${HOME}/.local/bin"
archive=""
service=1
dry_run=0
uninstall=0

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# run prints the command in dry-run mode and executes it otherwise.
run() {
  if [ "$dry_run" -eq 1 ]; then
    say "[dry-run] $*"
  else
    "$@"
  fi
}

need_arg() { if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) need_arg "$@"; version="$2"; shift 2 ;;
    --dir) need_arg "$@"; install_dir="$2"; shift 2 ;;
    --bin-dir) need_arg "$@"; bin_dir="$2"; shift 2 ;;
    --archive) need_arg "$@"; archive="$2"; shift 2 ;;
    --no-service) service=0; shift ;;
    --dry-run) dry_run=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

case "$install_dir" in /*) ;; *) install_dir="$(pwd)/$install_dir" ;; esac
case "$bin_dir" in /*) ;; *) bin_dir="$(pwd)/$bin_dir" ;; esac

# --- platform -----------------------------------------------------------------

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) die "unsupported OS $(uname -s); on Windows use scripts/install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) die "unsupported CPU architecture $(uname -m)" ;;
esac

unit_path="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${NAME}.service"
plist_path="$HOME/Library/LaunchAgents/${LABEL}.plist"

have() { command -v "$1" >/dev/null 2>&1; }

systemd_user_ok() { have systemctl && systemctl --user show-environment >/dev/null 2>&1; }

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "need sha256sum or shasum to verify the download"
  fi
}

fetch() { # fetch URL DEST
  if have curl; then curl -fsSL --retry 3 -o "$2" "$1"
  elif have wget; then wget -q -O "$2" "$1"
  else die "need curl or wget to download"
  fi
}

latest_version() {
  url="https://github.com/${REPO}/releases/latest"
  if have curl; then
    final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$url")" || return 1
  else
    final="$(wget -q -S --spider "$url" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1 | tr -d '\r')" || return 1
  fi
  tag="${final##*/}"
  case "$tag" in v[0-9]*) printf '%s\n' "${tag#v}" ;; *) return 1 ;; esac
}

gen_secret() { # 40 random bytes as 54 URL-safe characters
  if have openssl; then openssl rand -base64 40
  else head -c 40 /dev/urandom | base64
  fi | tr -d '\n=' | tr '+/' '-_'
}

# --- service management -------------------------------------------------------

stop_service() {
  if [ "$os" = "linux" ]; then
    if systemd_user_ok && [ -f "$unit_path" ]; then
      run systemctl --user disable --now "${NAME}.service" || true
    fi
  else
    if [ -f "$plist_path" ]; then
      run launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    fi
  fi
}

install_service() { # install_service SOURCE_DEPLOY_DIR
  src="$1"
  if [ "$os" = "linux" ]; then
    if ! systemd_user_ok; then
      warn "systemd user session not available; start the hub yourself: $install_dir/$NAME -config $install_dir/config.yaml"
      return 0
    fi
    run mkdir -p "$(dirname "$unit_path")"
    if [ "$dry_run" -eq 1 ]; then
      say "[dry-run] write $unit_path"
    else
      sed "s|%h/.local/share/t3code-proxy|$install_dir|g" "$src/systemd/${NAME}.service" > "$unit_path"
    fi
    run systemctl --user daemon-reload
    run systemctl --user enable "${NAME}.service"
    run systemctl --user restart "${NAME}.service"
    linger="$(loginctl show-user "$(id -un)" --property=Linger 2>/dev/null || true)"
    if [ "$linger" != "Linger=yes" ]; then
      if [ "$dry_run" -eq 1 ]; then
        say "[dry-run] loginctl enable-linger $(id -un)"
      elif ! loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
        warn "could not enable linger; run: sudo loginctl enable-linger $(id -un)"
      fi
    fi
  else
    run mkdir -p "$(dirname "$plist_path")"
    if [ "$dry_run" -eq 1 ]; then
      say "[dry-run] write $plist_path"
    else
      sed "s|__INSTALL_DIR__|$install_dir|g" "$src/launchd/${LABEL}.plist" > "$plist_path"
    fi
    run launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    run launchctl bootstrap "gui/$(id -u)" "$plist_path"
  fi
}

# --- uninstall ----------------------------------------------------------------

if [ "$uninstall" -eq 1 ]; then
  stop_service
  if [ "$os" = "linux" ] && [ -f "$unit_path" ]; then
    run rm -f "$unit_path"
    if systemd_user_ok; then run systemctl --user daemon-reload; fi
  fi
  if [ "$os" = "darwin" ] && [ -f "$plist_path" ]; then
    run rm -f "$plist_path"
  fi
  if [ -L "$bin_dir/$NAME" ]; then run rm -f "$bin_dir/$NAME"; fi
  for f in "$NAME" config.example.yaml config.hub.example.yaml; do
    if [ -e "$install_dir/$f" ]; then run rm -f "$install_dir/$f"; fi
  done
  if [ -d "$install_dir/deploy" ]; then run rm -rf "$install_dir/deploy"; fi
  say "Removed $NAME. Kept your config, logs, and accounts:"
  say "  $install_dir (config.yaml, logs/)"
  say "  the auth dir set in config.yaml (default ~/.t3code-proxy)"
  exit 0
fi

# --- fetch and verify ---------------------------------------------------------

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -n "$archive" ]; then
  [ -f "$archive" ] || die "archive not found: $archive"
  file="$(basename "$archive")"
  cp "$archive" "$tmp/$file"
  sums="$(dirname "$archive")/checksums.txt"
  if [ -f "$sums" ]; then cp "$sums" "$tmp/checksums.txt"; else warn "no checksums.txt next to $archive; skipping verification"; fi
else
  if [ -z "$version" ]; then
    version="$(latest_version)" || die "could not determine the latest release; pass --version"
  fi
  version="${version#v}"
  file="${NAME}_${version}_${os}_${arch}.tar.gz"
  base="https://github.com/${REPO}/releases/download/v${version}"
  say "Downloading $file"
  fetch "$base/$file" "$tmp/$file" || die "download failed: $base/$file"
  fetch "$base/checksums.txt" "$tmp/checksums.txt" || die "download failed: $base/checksums.txt"
fi

if [ -f "$tmp/checksums.txt" ]; then
  expected="$(awk -v f="$file" '$2 == f || $2 == "*"f {print $1}' "$tmp/checksums.txt")"
  [ -n "$expected" ] || die "$file is not listed in checksums.txt"
  actual="$(sha256_of "$tmp/$file")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $file (expected $expected, got $actual)"
  say "Checksum verified: $file"
fi

mkdir "$tmp/x"
tar -xzf "$tmp/$file" -C "$tmp/x"
src="$(find "$tmp/x" -type f -name "$NAME" -perm -u+x | head -n 1)"
[ -n "$src" ] || die "archive does not contain a $NAME binary"
pkg="$(dirname "$src")"
for f in config.hub.example.yaml deploy; do
  [ -e "$pkg/$f" ] || die "archive is missing $f"
done

# --- install ------------------------------------------------------------------

existing=0
if [ -x "$install_dir/$NAME" ]; then existing=1; fi
if [ "$service" -eq 1 ] && [ "$existing" -eq 1 ]; then stop_service; fi

run mkdir -p "$install_dir/logs" "$bin_dir"
run cp "$src" "$install_dir/$NAME.new"
run chmod 755 "$install_dir/$NAME.new"
run mv -f "$install_dir/$NAME.new" "$install_dir/$NAME"
run cp "$pkg/config.hub.example.yaml" "$pkg/config.example.yaml" "$install_dir/"
run rm -rf "$install_dir/deploy"
run cp -R "$pkg/deploy" "$install_dir/deploy"
run ln -sf "$install_dir/$NAME" "$bin_dir/$NAME"

config="$install_dir/config.yaml"
if [ -e "$config" ]; then
  say "Keeping existing config: $config"
else
  if [ "$dry_run" -eq 1 ]; then
    say "[dry-run] write $config with a new access key and management secret"
  else
    key="$(gen_secret)"
    secret="$(gen_secret)"
    (
      umask 077
      sed -e "s|replace-with-a-54-char-url-safe-key|$key|" \
        -e "s|\"replace-me\"|\"$secret\"|" \
        "$pkg/config.hub.example.yaml" > "$config.tmp"
    )
    mv "$config.tmp" "$config"
    unset key secret
    say "Wrote new config: $config"
  fi
fi

if [ "$service" -eq 1 ]; then
  install_service "$pkg"
fi

# --- next steps ---------------------------------------------------------------

say ""
if [ "$dry_run" -eq 1 ]; then
  say "Dry run complete; nothing was changed. Would install $file to $install_dir"
else
  say "Installed $file to $install_dir"
fi
case ":$PATH:" in *":$bin_dir:"*) ;; *) say "Add $bin_dir to your PATH to run '$NAME' directly." ;; esac
cat <<EOF

Next steps:
  1. Your client API key and management panel secret are in:
       $config
  2. Sign in your subscriptions on this machine (not from a datacenter IP):
       $NAME -config "$config" -claude-login -no-browser
       $NAME -config "$config" -codex-device-login
  3. Publish the hub to your tailnet:
       tailscale serve --bg --https=8317 http://127.0.0.1:8317
  4. Check the setup:
       $NAME doctor -config "$config"
EOF
if [ "$os" = "linux" ]; then
  say "  Logs: journalctl --user -u $NAME -f"
else
  say "  Logs: $install_dir/logs/launchd.log"
fi
