#!/bin/sh
# webmosh: let the relay reach this computer for the terminal's `mosh <host>` and `ssh <host>`.
# Run as the user the terminal should log in as, from the line the hosts page shows:
#   curl -fsSL '{{.URL}}/setup.sh?t=…' | sh
# It changes only this user's files:
#   ~/.local/bin/webmosh-gate      the only thing the relay's key may run (see that file)
#   ~/.ssh/authorized_keys         one line for the relay's key: from the relay only, no forwarding, forced to the gate
#                                  (a copy of the old file is kept as authorized_keys.webmosh-bak)
# then tells the relay this user, this computer's SSH host key and where mosh-server is, and the relay tests it.
# The relay fills in the template, its messages in the relay's language (L English Chinese).
set -eu

RELAY='{{.URL}}'
TOKEN='{{.Token}}'
KEY_LINE='{{.KeyLine}}'
KEY_BODY='{{.KeyBody}}'

say() { printf '%s\n' "$*"; }
fail() { printf '{{L "webmosh setup failed: %s" "webmosh 设置失败：%s"}}\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "{{L "curl is missing" "没有 curl"}}"
[ "$(id -u)" != 0 ] || fail "{{L "run it as the user who should log in, not as root" "请用要登录的普通用户运行，不要用 root"}}"

# mosh-server: in PATH, or where package managers put it (sshd gives the gate a bare PATH, so keep the full path)
MOSH=$(command -v mosh-server 2>/dev/null || true)
for p in /opt/homebrew/bin/mosh-server /usr/local/bin/mosh-server /usr/bin/mosh-server \
         "$HOME/.nix-profile/bin/mosh-server" /run/current-system/sw/bin/mosh-server \
         "$HOME/.local/bin/mosh-server" "$HOME/micromamba/bin/mosh-server" "$HOME/miniforge3/bin/mosh-server"; do
  [ -n "$MOSH" ] && break
  [ -x "$p" ] && MOSH=$p
done

# the gate
mkdir -p "$HOME/.local/bin"
GATE="$HOME/.local/bin/webmosh-gate"
{
  printf '#!/bin/sh\n'
  printf "WEBMOSH_MOSH_SERVER='%s'\n" "$MOSH"
  sed 1d <<'WEBMOSH_GATE_EOF'
{{.Gate}}WEBMOSH_GATE_EOF
} > "$GATE.new"
chmod 755 "$GATE.new"
mv "$GATE.new" "$GATE"

# authorized_keys: drop any old line with the relay's key, add the new one
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
AK="$HOME/.ssh/authorized_keys"
touch "$AK"
cp -p "$AK" "$AK.webmosh-bak"
LINE=$(printf '%s' "$KEY_LINE" | sed "s|@GATE@|$GATE|")
{ grep -vF "$KEY_BODY" "$AK.webmosh-bak" || true; printf '%s\n' "$LINE"; } > "$AK.new"
chmod 600 "$AK.new"
mv "$AK.new" "$AK"

# this computer's SSH host key, so the relay knows it is talking to this computer and no other
HOSTKEY=
for f in ${WEBMOSH_HOSTKEY_FILE:-} /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh_host_ed25519_key.pub; do  # (the variable: tests)
  [ -r "$f" ] && { HOSTKEY=$(cat "$f"); break; }
done

SSHD=unknown
if command -v nc >/dev/null 2>&1; then
  if nc -z -w 2 127.0.0.1 22 >/dev/null 2>&1; then SSHD=yes; else SSHD=no; fi
fi

say "{{L "webmosh: wrote $GATE and ${AK} (the old file is kept as authorized_keys.webmosh-bak)" "webmosh: 已写好 $GATE 和 ${AK}（旧文件备份为 authorized_keys.webmosh-bak）"}}"
[ -n "$MOSH" ] && say "{{L "webmosh: mosh-server is $MOSH" "webmosh: mosh-server 在 $MOSH"}}" \
  || say "{{L "webmosh: mosh is not installed here (ssh works, mosh does not)" "webmosh: 这台电脑没装 mosh（ssh 可以用，mosh 不行）"}}"

RESULT=$(curl -fsS -X POST "$RELAY/setup/report?t=$TOKEN" \
  --data-urlencode "user=$(id -un)" \
  --data-urlencode "shell=${SHELL:-}" \
  --data-urlencode "system=$(uname -s)" \
  --data-urlencode "mosh_server=$MOSH" \
  --data-urlencode "host_key=$HOSTKEY" \
  --data-urlencode "sshd=$SSHD") || fail "{{L "cannot reach the relay at ${RELAY} (is this computer on the tailnet?)" "连不上中继 ${RELAY}（这台电脑在 tailnet 上吗？）"}}"
say "$RESULT"
