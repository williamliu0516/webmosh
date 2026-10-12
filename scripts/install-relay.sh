#!/bin/bash
# Installs webmosh's relay on this computer (macOS or Linux) as a service, set up from Tailscale, and publishes it on
# your tailnet with `tailscale serve`. This computer is also the first host: `mosh <its name>` at the page's prompt.
# Run it as yourself; it asks for sudo for the service. Run it again to update the binary (the config is kept).
#   install-relay.sh [--port 8445] [--listen 127.0.0.1:8810] [--turn-port 3478] [--version v1.2.3] [--binary <file>]
#                    [--dry-run]
#   install-relay.sh --uninstall [--port 8445]    stops and removes the service, the binary and the serve port;
#                                                 keeps ~/.config/webmosh (the config and the relay's SSH key)
# The relay binary: --binary, else this repository's build (build/relay/webmosh-relay-<os>-<arch>, scripts/build-all.sh),
# else the release's (the latest, or --version), downloaded and checked against its SHA256SUMS; so the script works on
# its own, downloaded from the release page. Needs Tailscale (logged in, with HTTPS certificates on for the tailnet),
# mosh (brew install mosh, apt install mosh), python3 and curl. --dry-run prints what it would do and changes nothing.
# Runs under macOS /bin/bash 3.2 — no bash-4 features.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8445 LISTEN=127.0.0.1:8810 TURN_PORT=3478 BINARY="" VERSION="" DRY=0 UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift ;;
    --listen) LISTEN="$2"; shift ;;
    --turn-port) TURN_PORT="$2"; shift ;;
    --binary) BINARY="$2"; shift ;;
    --version) VERSION="$2"; shift ;;
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (--help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }

INSTALL_DIR="$HOME/webmosh"
BIN="$INSTALL_DIR/webmosh-relay"
CONF_DIR="$HOME/.config/webmosh"
CONF="$CONF_DIR/relay.json"
case "$(uname -s)" in
  Darwin) OS=darwin; SERVICE=/Library/LaunchDaemons/webmosh.relay.plist ;;
  Linux) OS=linux; SERVICE=/etc/systemd/system/webmosh-relay.service ;;
  *) die "this computer runs $(uname -s): the relay runs on macOS or Linux (on Windows, maybe in WSL 2)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=amd64 ;;
  armv6l|armv7l) ARCH=arm ;;
  *) die "no relay build for $(uname -m)" ;;
esac

# the tailscale command; macOS's app keeps it inside the app, and acts as the CLI only when told to
TS="$(command -v tailscale || true)"
[ -n "$TS" ] || [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -n "$TS" ] || die "Tailscale is not installed: https://tailscale.com/download"
export TAILSCALE_BE_CLI=1
serve() { "$TS" serve "$@" || { [ "$OS" = linux ] && sudo "$TS" serve "$@"; }; }   # Linux: root unless an operator is set

if [ "$UNINSTALL" = 1 ]; then
  say "→ removing the webmosh relay service"
  if [ "$OS" = darwin ]; then
    run sudo launchctl bootout system/webmosh.relay 2>/dev/null || true
    run sudo rm -f "$SERVICE"
    if [ -x /usr/libexec/ApplicationFirewall/socketfilterfw ] && [ -e "$BIN" ]; then
      run sudo /usr/libexec/ApplicationFirewall/socketfilterfw --remove "$BIN" >/dev/null || true
    fi
  else
    run sudo systemctl disable --now webmosh-relay 2>/dev/null || true
    run sudo rm -f "$SERVICE"
    run sudo systemctl daemon-reload
  fi
  say "→ tailscale serve: port $PORT off"
  if [ "$DRY" = 1 ]; then say "  would run: tailscale serve --https=$PORT off"; else serve --https="$PORT" off || true; fi
  run rm -f "$BIN" "$BIN.prev"
  say "Done. Kept $CONF_DIR (the config and the relay's key) and the relay's state; remove them by hand if you like."
  exit 0
fi

command -v python3 >/dev/null || die "python3 is needed (macOS: xcode-select --install)"

# Files from the release: downloaded into a temporary directory and checked against the release's SHA256SUMS.
# WEBMOSH_RELEASES points somewhere else (a mirror, a test server).
REPO_URL=https://github.com/williamliu0516/webmosh
if [ -n "$VERSION" ]; then RELEASES="${WEBMOSH_RELEASES:-$REPO_URL/releases/download/$VERSION}"
else RELEASES="${WEBMOSH_RELEASES:-$REPO_URL/releases/latest/download}"; fi
DL="$(mktemp -d)"; trap 'rm -rf "$DL"' EXIT
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
release_file() { # name: its path in $DL, verified
  [ -f "$DL/SHA256SUMS" ] || curl -fsSL -o "$DL/SHA256SUMS" "$RELEASES/SHA256SUMS" || die "cannot download $RELEASES/SHA256SUMS"
  curl -fsSL -o "$DL/$1" "$RELEASES/$1" || die "cannot download $RELEASES/$1"
  want="$(awk -v f="$1" '$2 == f || $2 == "*" f {print $1}' "$DL/SHA256SUMS")"
  [ -n "$want" ] && [ "$(sha256 "$DL/$1")" = "$want" ] || die "$1 does not match the release's SHA256SUMS: not installing it"
  printf '%s' "$DL/$1"
}

if [ -n "$BINARY" ]; then BIN_SRC="$BINARY"
elif [ -x "$ROOT/build/relay/webmosh-relay-$OS-$ARCH" ]; then BIN_SRC="$ROOT/build/relay/webmosh-relay-$OS-$ARCH"
else
  say "→ downloading webmosh-relay-$OS-$ARCH from $RELEASES"
  BIN_SRC="$(release_file "webmosh-relay-$OS-$ARCH")"
  chmod +x "$BIN_SRC"
  say "  checked against SHA256SUMS"
fi
[ -x "$BIN_SRC" ] || die "no relay binary at $BIN_SRC"
# the service templates: this repository's, or the release's
template() { if [ -f "$ROOT/relay/service/$1" ]; then printf '%s' "$ROOT/relay/service/$1"; else release_file "$1"; fi; }

# this computer on the tailnet: its name, address and owner
STATUS="$("$TS" status --json)" || die "tailscale status failed: is Tailscale running and logged in?"
eval "$(printf '%s' "$STATUS" | python3 -c '
import json, shlex, sys
s = json.load(sys.stdin)
me = s.get("Self") or {}
user = (s.get("User") or {}).get(str(me.get("UserID")), {})
ip4 = next((ip for ip in me.get("TailscaleIPs") or [] if "." in ip), "")
for k, v in (("STATE", s.get("BackendState", "")), ("DNSNAME", (me.get("DNSName") or "").rstrip(".")),
             ("TSIP", ip4), ("OWNER", user.get("LoginName", ""))):
    print(f"{k}={shlex.quote(v)}")
')"
[ "$STATE" = Running ] || die "Tailscale is $STATE here: log in first (tailscale up, or the app)"
[ -n "$DNSNAME" ] && [ -n "$TSIP" ] && [ -n "$OWNER" ] || die "tailscale status gave no name, address or owner for this computer"

MOSH_SERVER="$(command -v mosh-server || true)"
for p in /opt/homebrew/bin/mosh-server /usr/local/bin/mosh-server /usr/bin/mosh-server; do
  [ -n "$MOSH_SERVER" ] || [ ! -x "$p" ] || MOSH_SERVER="$p"
done
[ -n "$MOSH_SERVER" ] || die "mosh is not installed: brew install mosh (macOS), or apt install mosh (Debian, Ubuntu, Raspberry Pi OS)"

NAME="$(hostname -s 2>/dev/null || hostname)"
NAME="$(printf '%s' "$NAME" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g; s/^-//; s/-$//')"
[ -n "$NAME" ] || NAME=here
ORIGIN="https://$DNSNAME:$PORT"
say "This computer: $DNSNAME ($TSIP), $OS/$ARCH; the page will be $ORIGIN for $OWNER"

# the binary (the one before is kept as .prev)
say "→ binary: $BIN"
run mkdir -p "$INSTALL_DIR"
run cp "$BIN_SRC" "$BIN.new"
[ ! -f "$BIN" ] || run cp -p "$BIN" "$BIN.prev"
run mv "$BIN.new" "$BIN"
[ "$OS" != darwin ] || [ "$DRY" = 1 ] || xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true   # a browser download

# the relay's SSH key (for other computers later) and its config, written once and kept
run mkdir -p "$CONF_DIR"
run chmod 700 "$CONF_DIR"
if [ ! -f "$CONF_DIR/id_ed25519" ]; then
  say "→ the relay's SSH key: $CONF_DIR/id_ed25519"
  run ssh-keygen -q -t ed25519 -N '' -C "webmosh-relay@$NAME" -f "$CONF_DIR/id_ed25519"
fi
[ -f "$CONF_DIR/known_hosts" ] || run touch "$CONF_DIR/known_hosts"
CONFIG="$(OS="$OS" LISTEN="$LISTEN" ORIGIN="$ORIGIN" OWNER="$OWNER" TSIP="$TSIP" TURN_PORT="$TURN_PORT" NAME="$NAME" \
  MOSH_SERVER="$MOSH_SERVER" CONF_DIR="$CONF_DIR" python3 -c '
import json, os
e = os.environ
here = {"id": e["NAME"], "name": e["NAME"] + ", the relay itself", "aliases": ["here"], "local": True,
        "mosh_server": e["MOSH_SERVER"], "env": {"MOSH_SERVER_NETWORK_TMOUT": "43200"}}
if e["OS"] == "linux":
    here["locale"] = "C.UTF-8"   # en_US.UTF-8 is often not generated there
print(json.dumps({
    "listen": e["LISTEN"], "origin": e["ORIGIN"], "owner": e["OWNER"], "ice_nets": ["100.64.0.0/10"],
    "turn_listen": e["TSIP"] + ":" + e["TURN_PORT"] if e["TURN_PORT"] != "0" else "",
    "ssh_key": e["CONF_DIR"] + "/id_ed25519", "known_hosts": e["CONF_DIR"] + "/known_hosts", "detached_ttl": "12h",
    "targets": [here],
}, indent=2))
')"
if [ -f "$CONF" ]; then
  say "→ config: keeping $CONF"
  KEPT_ORIGIN="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("origin", ""))' "$CONF")"
  [ "$KEPT_ORIGIN" = "$ORIGIN" ] || say "  note: its origin is $KEPT_ORIGIN, not $ORIGIN; edit it if the address changed"
elif [ "$DRY" = 1 ]; then
  say "→ config: would write $CONF:"; printf '%s\n' "$CONFIG" | sed 's/^/    /'
else
  say "→ config: $CONF"
  (umask 077; printf '%s\n' "$CONFIG" > "$CONF")
fi
LISTEN="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("listen", "127.0.0.1:8810"))' "$CONF" 2>/dev/null || echo "$LISTEN")"

# the service, from the templates in relay/service
TMP="$DL/service"
if [ "$OS" = darwin ]; then
  T="$(template webmosh.relay.plist)"; [ -f "$T" ] || die "no launchd template"
  sed -e "s|/Users/you|$HOME|g" -e "s|<string>you</string>|<string>$USER</string>|" "$T" > "$TMP"
  say "→ service: $SERVICE (launchd, runs as $USER from boot)"
  run sudo install -m 644 -o root -g wheel "$TMP" "$SERVICE"
  run sudo launchctl bootout system/webmosh.relay 2>/dev/null || true
  run sudo launchctl bootstrap system "$SERVICE"
  # with the firewall on, WebRTC and TURN need the relay let in
  FW=/usr/libexec/ApplicationFirewall/socketfilterfw
  if [ -x "$FW" ] && "$FW" --getglobalstate 2>/dev/null | grep -q enabled; then
    say "→ firewall: letting $BIN accept connections"
    run sudo "$FW" --add "$BIN"
    run sudo "$FW" --unblockapp "$BIN"
  fi
else
  T="$(template webmosh-relay.service)"; [ -f "$T" ] || die "no systemd template"
  sed -e "s|/home/you|$HOME|g" -e "s|^User=you$|User=$USER|" "$T" > "$TMP"
  say "→ service: $SERVICE (systemd, runs as $USER)"
  run sudo install -m 644 "$TMP" "$SERVICE"
  run sudo systemctl daemon-reload
  run sudo systemctl enable webmosh-relay
  run sudo systemctl restart webmosh-relay
fi

say "→ tailscale serve: https port $PORT → http://$LISTEN"
if [ "$DRY" = 1 ]; then
  say "  would run: tailscale serve --bg --https=$PORT http://$LISTEN"
  exit 0
fi
serve --bg --https="$PORT" "http://$LISTEN" >/dev/null ||
  die "tailscale serve failed: HTTPS certificates must be on for the tailnet (admin console, DNS page), then run this again"

for i in $(seq 1 20); do
  if curl -fsS -o /dev/null -H "Tailscale-User-Login: $OWNER" "http://$LISTEN/site.json" 2>/dev/null; then
    say ""
    say "webmosh is running: $ORIGIN"
    say "Open it on a device on your tailnet, signed in to Tailscale as $OWNER, and type: mosh $NAME"
    say "Other computers on the tailnet can be hosts too: see the README's Hosts section."
    exit 0
  fi
  sleep 1
done
[ "$OS" = darwin ] && LOG="$HOME/Library/Logs/webmosh-relay.log" || LOG="journalctl -u webmosh-relay"
die "the relay does not answer on $LISTEN; see $LOG"
