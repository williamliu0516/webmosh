# Hosts

[README](../README.md) · [Using it](usage.md) · [Install](install.md) · **Hosts** · [Configuration](configuration.md) ·
[Security](security.md) · [How it works](how-it-works.md)

A target in the config is fixed: `local: true` runs mosh-server on the relay's own computer; otherwise the relay
logs in over SSH with its key to `host` as `user`.

Every Linux or macOS computer on the tailnet can also be a host without editing the config. The relay reads
`tailscale status --json` every minute and lists the computers it finds (phones and tablets are left out) on the
hosts page: `setup` at the prompt, or the page's address with `?hosts`. It opens over the terminal, and the tabs
underneath carry on.

## On the tailnet

On the hosts page, **Set up** gives a line for that computer, valid for 30 minutes. Run it there in a terminal, as the
user the terminal should log in as (on a Mac, turn on Remote Login first). It installs the gate, adds the key's line
and reports the user, where mosh-server is and the computer's SSH host key, which the relay pins; the relay then logs
in and checks, and the row turns ready. The prompt then takes `ssh <name>` and, with mosh installed, `mosh <name>`.
Under a row's arrow: its name and aliases, the SSH port, **Test** (log in again and check), **Turn off**, and
**Forget**, which shows the line that takes the key off the computer:
`sed -i.bak '/webmosh-relay@<relay host>/d' ~/.ssh/authorized_keys && rm -f ~/.local/bin/webmosh-gate`.

The gate on each host comes from its setup line, so updating the relay leaves it as it was. When a release's notes
say the gate changed, press **Set up again** under each ready host's arrow and run the new line there (for a computer
off the tailnet, through the same pipe as before).

## Off the tailnet

A computer off the tailnet, such as a VPS or a server at work, is added at the bottom of the hosts page by its
address, `user@host` or `user@host:port` (an IPv6 address in brackets when a port follows), as the user the terminal
should log in as. The relay must reach it there: its firewall lets in the SSH port, and UDP 60000-61000 for mosh. It
cannot reach the relay, so its line is run on a computer of the tailnet that can already ssh to it, such as your
laptop:

```
curl -fsSL '<relay>/setup.sh?t=…' | ssh -p 2222 you@vps.example.com sh | curl -sS -T - '<relay>/setup/report?t=…'
```

The script goes there through your own ssh, so your `known_hosts` vouches for the host key it reports, and its
report comes back through the same pipe (its messages on stderr), to the curl that hands it to the relay. Its key line
has no `from=`, since the relay's public address may change ([Security](security.md)). Under its row's arrow, its
address can be changed too; Forget takes it off the list.

## Names

Names are unique per protocol, not overall: `mosh box` and `ssh box` may reach different hosts. The config's
targets come first, then the hosts in the order they were first seen.
