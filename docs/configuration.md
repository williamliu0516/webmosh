# Configuration

[README](../README.md) · [Using it](usage.md) · [Install](install.md) · [Hosts](hosts.md) · **Configuration** ·
[Security](security.md) · [How it works](how-it-works.md)

The relay reads `~/.config/webmosh/relay.json` (the installer writes it; `relay/relay.example.json` shows one):

| Field | |
|---|---|
| `listen` | where the relay listens; default `127.0.0.1:8810` |
| `origin` | the page's address as the browser sees it (`tailscale serve`'s) |
| `owner` | the Tailscale login let in; empty turns the check off (development only) |
| `ice_nets`, `turn_listen` | where WebRTC may listen (e.g. `["100.64.0.0/10"]`, the tailnet), and an optional TURN server on the relay's tailnet address (Safari can hide its host addresses; TURN is the fallback) |
| `ssh_key`, `known_hosts` | the relay's key, and the host keys of config targets |
| `detached_ttl` | how long a session waits for its page, from when the page left, across relay restarts; default `12h` |
| `state_dir` | sessions, hosts and device tabs; default systemd's `StateDirectory=`, else `~/Library/Application Support/webmosh` (macOS) or `~/.local/state/webmosh` |
| `targets` | `id`, `name`, `aliases`, `host`, `user`, `mosh_server`, `locale`, `local`, `env`, `args`, `end_via_ssh` |
| `frame_ancestors` | origins that may embed the page in an iframe and use the hosts API |
| `lang` | `en` (default) or `zh`: the page's and the relay's own messages |
| `page` | served to the page as `/site.json`: `theme` (an xterm.js theme laid over the default, Tomorrow Night), `terminal` (xterm.js options such as `fontSize`, the default size, `lineHeight`, `cursorStyle`), `keyboard` (`"off"`: no on-screen keyboard or iPadOS keyboard bar until switched on, for tablets with a keyboard; phones keep theirs; each device remembers its own switch) and `diagnostics` (`true`: key and pointer diagnostics to the relay's journal, see [Security](security.md)) |
| `static_dir` | files served in place of the built-in ones (below) |
| `ssh_from`, `hosts_scan`, `tailscale_status` | tailnet hosts: extra addresses for the key's `from=`, how often to read tailscale status (default `1m`), a status file instead (tests) |
| `ntfy_server`, `ntfy_topic`, `hosts_page` | announce new tailnet computers on ntfy, with a link to the hosts page (`hosts_page`; default the page's own, `<origin>/?hosts`) |

## Your own look

Put a `custom.css` in `static_dir`: the page loads it after its own styles, and the relay serves the fonts and
pictures it names from the same directory. An `@font-face` named `webmosh-mono` becomes the terminal's font
(`scripts/build-fonts.sh` subsets a Nerd Font for it); `web/src/custom.css` shows an example. The terminal draws with
xterm's WebGL renderer, which takes no CSS `font-feature-settings`: bake a font's variants into the subset instead
(`FEATURES="cv01 zero" scripts/build-fonts.sh ...`); `?renderer=dom` uses the DOM renderer. A transparent theme
background (`"background": "#1d1f2100"` with `"terminal": {"allowTransparency": true}`) lets a picture behind the
page show through the cells.

## Embedding

The page can live in an iframe of another page (a wall panel, say) that is listed in `frame_ancestors`. The parent
posts `webmosh:focus` and `webmosh:hide` when it shows and hides the terminal, and `{t: 'webmosh:open', kind, target}`
to open a tab; the page posts `webmosh:active` while someone types, `webmosh:close` (`exit` at the last prompt) and
`webmosh:toggle` (Cmd Shift H). `GET /api/device` tells the parent whether the terminal was on screen when that
device was last seen.

The parent may also use the relay's hosts API, as the hosts page does: `GET /api/hosts`, and `POST /api/hosts/setup`,
`test`, `update` (`name`, `aliases`, `port`, `off`, and a wan host's `address`) and `forget`, each with
`{"node": "<node id>"}`, and `add` with `{"address": "user@host:port", "name": "vps"}`, which answers with the new
host's node and its setup line. They need the owner's identity, and a POST an allowed `Origin`.
