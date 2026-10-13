# Security

[README](../README.md) · [Using it](usage.md) · [Install](install.md) · [Hosts](hosts.md) ·
[Configuration](configuration.md) · **Security** · [How it works](how-it-works.md)

Read this before running it. The relay is a remote shell service.

- **Access is your Tailscale identity.** The relay listens on loopback behind `tailscale serve`, which adds a
  `Tailscale-User-Login` header to every request from the tailnet. Only the configured `owner` gets in, and the
  header is trusted only from loopback. The WebSockets (`/ws`, and a session's `/link`, which also needs a one-time
  ticket from `/ws`) and the hosts API also check the request's `Origin`. There is no other authentication, so never
  publish the relay to the internet (no Funnel, no port forward), and run it on a computer where nobody else can
  reach its loopback port.
- **The relay is trusted with your sessions.** mosh's datagrams are encrypted end to end between the page and
  `mosh-server`, and the relay only forwards them. But the relay starts `mosh-server` and reads the session key to
  hand it to the page, and keeps it in its state file so that sessions survive a restart. Whoever controls the relay
  can read mosh sessions. ssh tabs run on the relay itself, in plaintext.
- **The relay's SSH key reaches every host you set up.** On each host, one `authorized_keys` line lets it in:
  `from=` the relay's tailnet addresses only (not on a computer off the tailnet, which the relay reaches from its
  public address, and a home connection's changes: there the key alone keeps others out), `restrict,pty` (no
  forwarding of any kind), and a forced command, `webmosh-gate`, which allows a login shell, mosh-server with fixed
  options, ending one by its port and pid, receiving an uploaded file and a status check. A login shell is a login
  shell: if the relay is compromised, so is every host's user that was set up.
- **The setup line is `curl | sh`** (for a computer off the tailnet, `curl | ssh host sh | curl -T -`). It carries a
  token for that one computer, valid for 30 minutes (a new line replaces it). Read `relay/setup/setup.sh` before
  running it; it changes only that user's `~/.ssh/authorized_keys` (one line, with a backup of the old file) and
  `~/.local/bin/webmosh-gate`.
- **ntfy.** If `ntfy_topic` is set, new tailnet computers are announced there. Anyone who knows a topic's name can
  read it, so use a long random one.
- **Diagnostics are off unless you turn them on.** With `page.diagnostics` set, or on a page opened with `?keylog`,
  the page reports keyboard events with modifiers (Option, Ctrl, dead keys) and a line per pointer press to the
  relay's journal, for debugging a device's keyboard. Plain letters and input method text are never reported. The
  journal always gets the page's connection events (hidden, shown, reconnected), which carry nothing typed.
