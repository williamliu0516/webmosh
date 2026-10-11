package main

// Computers on the tailnet as terminal hosts: a hosts page (the embedding panel's) lists them, sets one up with a line the
// user runs on it (setup/setup.sh), and from then on the page's prompt takes `mosh <name>` and `ssh <name>`.
//
// Discovery: `tailscale status --json` every minute. A computer (Linux, macOS) the relay has not seen before is
// added as "new", and after the first scan a new one is announced on ntfy.
//
// Trust: one relay key (cfg.SSHKey). The setup line installs ~/.local/bin/webmosh-gate and one authorized_keys
// line, from the relay's addresses only, `restrict,pty`, forced to the gate. The setup script reports the
// computer's SSH host key, which the relay pins (no trust on first use), the user, and where mosh-server is;
// the relay then logs in and runs `webmosh-check` to prove it works.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"text/template"
	"time"

	"golang.org/x/crypto/ssh"
)

//go:embed setup/setup.sh setup/webmosh-gate
var setupFS embed.FS

const tokenTTL = 30 * time.Minute

type Host struct {
	Node      string    `json:"node"`              // Tailscale's stable node ID
	Name      string    `json:"name"`              // what `mosh <name>` / `ssh <name>` take; unique among hosts and targets
	Aliases   []string  `json:"aliases,omitempty"` // other names for it
	Display   string    `json:"display"`           // Tailscale's host name ("Ada的MacBook Pro")
	DNSName   string    `json:"dns_name"`
	OS        string    `json:"os"`
	IP        string    `json:"ip"`             // tailnet IPv4: SSH and mosh's UDP go here
	Port      int       `json:"port,omitempty"` // sshd; 0 = 22
	Online    bool      `json:"online"`
	LastSeen  time.Time `json:"last_seen"`
	FirstSeen time.Time `json:"first_seen"`
	Gone      bool      `json:"gone,omitempty"` // no longer in the tailnet

	State       string    `json:"state"` // new | pending (setup line issued) | ready | error | off
	Error       string    `json:"error,omitempty"`
	Checked     time.Time `json:"checked"`
	User        string    `json:"user,omitempty"`
	Shell       string    `json:"shell,omitempty"`
	System      string    `json:"system,omitempty"`
	MoshServer  string    `json:"mosh_server,omitempty"`
	MoshVersion string    `json:"mosh_version,omitempty"`
	HostKey     string    `json:"host_key,omitempty"` // pinned: the authorized_keys form of the computer's ed25519 key

	token       string
	tokenExpiry time.Time
}

func (h *Host) usable() bool { return h.State == "ready" && !h.Gone }

// target is how a session reaches this host.
func (h *Host) target() *Target {
	port := h.Port
	if port == 0 {
		port = 22
	}
	t := &Target{ID: h.Name, Name: h.Display, Aliases: h.Aliases, Host: net.JoinHostPort(h.IP, fmt.Sprint(port)),
		User: h.User, MoshServer: "mosh-server", EndViaSSH: true, gated: true}
	if k, _, _, _, err := ssh.ParseAuthorizedKey([]byte(h.HostKey)); err == nil {
		t.hostKey = k
	}
	return t
}

type Hosts struct {
	r       *Relay
	mu      sync.Mutex
	byNode  map[string]*Host
	scanned bool // the first scan is done: from now on a new computer is announced
	selfIPs []string
}

func newHosts(r *Relay) *Hosts {
	h := &Hosts{r: r, byNode: map[string]*Host{}}
	h.load()
	return h
}

func (hs *Hosts) path() string {
	p := hs.r.statePath()
	if p == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(p), "hosts.json")
}

func (hs *Hosts) load() {
	path := hs.path()
	if path == "" {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var list []*Host
	if err := json.Unmarshal(b, &list); err != nil {
		log.Printf("hosts: %v", err)
		return
	}
	for _, h := range list {
		if h.State == "pending" { // its setup line died with the old relay
			h.State = "new"
			if h.HostKey != "" {
				h.State = "error"
				h.Error = L("setup did not finish", "设置没有完成")
			}
		}
		hs.byNode[h.Node] = h
	}
}

// save: under hs.mu
func (hs *Hosts) save() {
	path := hs.path()
	if path == "" {
		return
	}
	list := hs.sortedLocked()
	b, _ := json.MarshalIndent(list, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err == nil {
		os.Rename(tmp, path)
	}
}

func (hs *Hosts) sortedLocked() []*Host {
	list := make([]*Host, 0, len(hs.byNode))
	for _, h := range hs.byNode {
		list = append(list, h)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Gone != list[j].Gone {
			return !list[i].Gone
		}
		return list[i].Name < list[j].Name
	})
	return list
}

// ---- discovery --------------------------------------------------------------------------------

type tsStatus struct {
	Self *tsPeer           `json:"Self"`
	Peer map[string]tsPeer `json:"Peer"`
}

type tsPeer struct {
	ID           string    `json:"ID"`
	HostName     string    `json:"HostName"`
	DNSName      string    `json:"DNSName"`
	OS           string    `json:"OS"`
	TailscaleIPs []string  `json:"TailscaleIPs"`
	Online       bool      `json:"Online"`
	LastSeen     time.Time `json:"LastSeen"`
}

// tailscaleCLI: the tailscale command. macOS's Tailscale app keeps it inside the app, out of PATH (and a launchd job's
// PATH is short anyway), so look there and in the usual places too.
func tailscaleCLI() string {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p
	}
	for _, p := range []string{"/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale",
		"/usr/local/bin/tailscale", "/usr/bin/tailscale", "/usr/sbin/tailscale"} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return "tailscale"
}

func (hs *Hosts) status() (*tsStatus, error) {
	var b []byte
	var err error
	if f, ok := strings.CutPrefix(hs.r.cfg.TailscaleStatus, "file:"); ok { // tests
		b, err = os.ReadFile(f)
	} else {
		cmd := exec.Command(tailscaleCLI(), "status", "--json")
		// the macOS app's binary is the GUI too, and takes itself for it without a terminal (under launchd, say)
		cmd.Env = append(os.Environ(), "TAILSCALE_BE_CLI=1")
		b, err = cmd.Output()
	}
	if err != nil {
		return nil, err
	}
	var st tsStatus
	return &st, json.Unmarshal(b, &st)
}

func (hs *Hosts) run() {
	every, err := time.ParseDuration(hs.r.cfg.HostsScan)
	if err != nil || every < time.Second {
		every = time.Minute
	}
	last := ""
	for {
		err := hs.scan()
		if msg := fmt.Sprint(err); err != nil && msg != last { // once per new error, not every minute
			log.Printf("hosts: tailscale status: %v", err)
			last = msg
		} else if err == nil {
			last = ""
		}
		time.Sleep(every)
	}
}

var labelRE = regexp.MustCompile(`[^a-z0-9-]+`)

func (hs *Hosts) scan() error {
	st, err := hs.status()
	if err != nil {
		return err
	}
	var fresh []*Host
	hs.mu.Lock()
	if st.Self != nil {
		hs.selfIPs = st.Self.TailscaleIPs
	}
	seen := map[string]bool{}
	changed := false
	for _, p := range st.Peer {
		if p.OS != "linux" && p.OS != "macOS" { // phones and tablets are not hosts
			continue
		}
		seen[p.ID] = true
		ip := ""
		for _, a := range p.TailscaleIPs {
			if net.ParseIP(a).To4() != nil {
				ip = a
			}
		}
		h := hs.byNode[p.ID]
		if h == nil {
			label := strings.SplitN(strings.TrimSuffix(p.DNSName, "."), ".", 2)[0]
			if label == "" {
				label = labelRE.ReplaceAllString(strings.ToLower(p.HostName), "-")
			}
			h = &Host{Node: p.ID, Name: hs.uniqueLocked(label, nil), FirstSeen: time.Now(), State: "new"}
			hs.byNode[p.ID] = h
			fresh = append(fresh, h)
			changed = true
		}
		if h.Display != p.HostName || h.DNSName != p.DNSName || h.OS != p.OS || h.IP != ip || h.Online != p.Online || h.Gone {
			changed = true
		}
		h.Display, h.DNSName, h.OS, h.IP, h.Online, h.Gone = p.HostName, p.DNSName, p.OS, ip, p.Online, false
		if p.Online {
			h.LastSeen = time.Now()
		} else if !p.LastSeen.IsZero() {
			h.LastSeen = p.LastSeen
		}
	}
	for id, h := range hs.byNode {
		if !seen[id] && !h.Gone {
			h.Gone, h.Online, changed = true, false, true
		}
	}
	announce := hs.scanned
	hs.scanned = true
	if changed {
		hs.save()
	}
	hs.mu.Unlock()
	if changed {
		hs.r.broadcastHosts()
	}
	if announce {
		for _, h := range fresh {
			log.Printf("hosts: new computer on the tailnet: %s (%s, %s)", h.Display, h.OS, h.IP)
			hs.r.notify(L("New computer on the tailnet: ", "新电脑加入 tailnet：")+h.Display,
				fmt.Sprintf(L("%s, %s. Set it up once on the hosts page, then mosh / ssh to it from the terminal.",
					"%s，%s。在终端主机页设置一次，就能在终端里 mosh / ssh 它。"), h.OS, h.IP))
		}
	}
	return nil
}

// ---- names ------------------------------------------------------------------------------------
//
// A name (or alias) is unique per protocol, not overall (the user's rule): `mosh box` and `ssh box` may reach
// different entries. Who holds a name for a protocol goes by precedence: the config targets in their order, then the
// tailnet hosts in the order they were first seen. A host may take a name that some other entry already holds for
// one of its protocols; the name then reaches it only by the other (the sheet says so).

var kindsAll = []string{"mosh", "ssh"}

// hostKinds: ssh always (through the gate), mosh when it has mosh-server
func hostKinds(h *Host) []string {
	if h.MoshServer != "" {
		return kindsAll
	}
	return []string{"ssh"}
}

func targetKinds(t *Target) []string {
	if t.Local || t.gated {
		return kindsAll
	}
	return []string{"mosh"}
}

func hasKind(list []string, k string) bool {
	for _, x := range list {
		if x == k {
			return true
		}
	}
	return false
}

func (h *Host) answers(n string) bool {
	if h.Name == n {
		return true
	}
	for _, a := range h.Aliases {
		if a == n {
			return true
		}
	}
	return false
}

func (t *Target) answers(n string) bool {
	if t.ID == n {
		return true
	}
	for _, a := range t.Aliases {
		if a == n {
			return true
		}
	}
	return false
}

// byPrecedenceLocked: the hosts in the order they were first seen (ties by node ID)
func (hs *Hosts) byPrecedenceLocked() []*Host {
	list := make([]*Host, 0, len(hs.byNode))
	for _, h := range hs.byNode {
		list = append(list, h)
	}
	sort.Slice(list, func(i, j int) bool {
		if !list[i].FirstSeen.Equal(list[j].FirstSeen) {
			return list[i].FirstSeen.Before(list[j].FirstSeen)
		}
		return list[i].Node < list[j].Node
	})
	return list
}

// holderLocked: who `<kind> <n>` reaches: a config target's name, a host's name, or "" (nobody). Hosts that are off
// or gone do not hold names.
func (hs *Hosts) holderLocked(n, kind string, onlyUsable bool) (string, *Target, *Host) {
	for i := range hs.r.cfg.Targets {
		t := &hs.r.cfg.Targets[i]
		if t.answers(n) && hasKind(targetKinds(t), kind) {
			return t.Name, t, nil
		}
	}
	for _, h := range hs.byPrecedenceLocked() {
		if h.Gone || h.State == "off" || (onlyUsable && !h.usable()) {
			continue
		}
		if h.answers(n) && hasKind(hostKinds(h), kind) {
			return h.Display, nil, h
		}
	}
	return "", nil, nil
}

// takenLocked: n is held for kind by an entry other than self
func (hs *Hosts) takenLocked(n, kind string, self *Host) bool {
	for i := range hs.r.cfg.Targets {
		t := &hs.r.cfg.Targets[i]
		if t.answers(n) && hasKind(targetKinds(t), kind) {
			return true
		}
	}
	for _, h := range hs.byNode {
		if h != self && !h.Gone && h.State != "off" && h.answers(n) && hasKind(hostKinds(h), kind) {
			return true
		}
	}
	return false
}

// uniqueLocked: a name for a new host (ssh, which every host has): name, or name-2, name-3…
func (hs *Hosts) uniqueLocked(name string, self *Host) string {
	if !hs.takenLocked(name, "ssh", self) {
		return name
	}
	for i := 2; ; i++ {
		if n := fmt.Sprintf("%s-%d", name, i); !hs.takenLocked(n, "ssh", self) {
			return n
		}
	}
}

// shadowedLocked: the names of h that reach someone else by one of h's protocols, e.g. "box: mosh → build box"
func (hs *Hosts) shadowedLocked(h *Host) []string {
	var out []string
	for _, n := range append([]string{h.Name}, h.Aliases...) {
		for _, k := range hostKinds(h) {
			if who, _, hh := hs.holderLocked(n, k, false); who != "" && hh != h {
				out = append(out, fmt.Sprintf("%s %s → %s", k, n, who))
			}
		}
	}
	return out
}

// ---- lookups ----------------------------------------------------------------------------------

// find: the ready host `<kind> <name>` reaches, if a host (not a config target) holds that name
func (hs *Hosts) find(name, kind string) *Host {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	_, t, h := hs.holderLocked(name, kind, true)
	if t != nil {
		return nil
	}
	return h
}

func (hs *Hosts) targetInfos() []targetInfo {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	var out []targetInfo
	for _, h := range hs.byPrecedenceLocked() {
		if h.usable() {
			out = append(out, targetInfo{ID: h.Name, Name: h.Display, Aliases: h.Aliases, Mosh: h.MoshServer != "", SSH: true})
		}
	}
	return out
}

// ---- setup ------------------------------------------------------------------------------------

func newToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// setupCommand issues a setup line for a host (valid for tokenTTL).
func (hs *Hosts) setupCommand(node string) (string, error) {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	h := hs.byNode[node]
	if h == nil {
		return "", fmt.Errorf("%s", L("no such computer", "没有这台电脑"))
	}
	h.token, h.tokenExpiry = newToken(), time.Now().Add(tokenTTL)
	if h.State != "ready" {
		h.State, h.Error = "pending", ""
	}
	hs.save()
	return fmt.Sprintf("curl -fsSL '%s/setup.sh?t=%s' | sh", hs.r.cfg.Origin, h.token), nil
}

func (hs *Hosts) byToken(t string) *Host {
	if len(t) != 32 {
		return nil
	}
	for _, h := range hs.byNode {
		if h.token != "" && h.token == t && time.Now().Before(h.tokenExpiry) {
			return h
		}
	}
	return nil
}

// fromList: where the relay's SSH comes from, for the key's from= option
func (hs *Hosts) fromList() string {
	hs.mu.Lock()
	ips := append([]string(nil), hs.selfIPs...)
	hs.mu.Unlock()
	ips = append(ips, hs.r.cfg.SSHFrom...)
	return strings.Join(ips, ",")
}

// keyComment ends the relay key's authorized_keys line on every computer: webmosh-relay@ and the relay's host name
// (webmosh-relay@raspberrypi). The undo line deletes the lines that have it.
func keyComment() string {
	name, _ := os.Hostname()
	name, _, _ = strings.Cut(name, ".")
	if !regexp.MustCompile(`^[A-Za-z0-9-]+$`).MatchString(name) {
		name = "relay"
	}
	return "webmosh-relay@" + name
}

func (hs *Hosts) serveScript(w http.ResponseWriter, req *http.Request) {
	hs.mu.Lock()
	h := hs.byToken(req.URL.Query().Get("t"))
	hs.mu.Unlock()
	if h == nil {
		http.Error(w, "echo 'webmosh: "+L("this setup line has expired; get a new one on the hosts page", "这行设置命令已过期，请在终端主机页重新获取")+"' >&2; exit 1", http.StatusForbidden)
		return
	}
	pub, err := hs.r.publicKey()
	if err != nil {
		http.Error(w, "echo 'webmosh: relay has no key' >&2; exit 1", http.StatusInternalServerError)
		return
	}
	keyBody := strings.Fields(pub)[1]
	keyLine := fmt.Sprintf(`from="%s",restrict,pty,command="@GATE@" %s %s`, hs.fromList(), strings.Join(strings.Fields(pub)[:2], " "), keyComment())
	script, _ := setupFS.ReadFile("setup/setup.sh")
	gate, _ := setupFS.ReadFile("setup/webmosh-gate")
	tmpl, err := template.New("setup").Funcs(template.FuncMap{"L": L}).Parse(string(script))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var buf bytes.Buffer
	tmpl.Execute(&buf, map[string]string{"URL": hs.r.cfg.Origin, "Token": req.URL.Query().Get("t"),
		"KeyLine": keyLine, "KeyBody": keyBody, "Gate": string(gate)})
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(buf.Bytes())
}

// serveReport: the setup script's report from the computer; the relay then tests the login and answers in words.
func (hs *Hosts) serveReport(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	req.Body = http.MaxBytesReader(w, req.Body, 16<<10)
	if err := req.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	hs.mu.Lock()
	h := hs.byToken(req.URL.Query().Get("t"))
	if h == nil {
		hs.mu.Unlock()
		http.Error(w, "webmosh: "+L("this setup line has expired; get a new one on the hosts page", "这行设置命令已过期，请在终端主机页重新获取"), http.StatusForbidden)
		return
	}
	f := req.PostForm
	user := f.Get("user")
	if !regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`).MatchString(user) {
		hs.mu.Unlock()
		http.Error(w, "webmosh: "+L("bad user name", "用户名不对"), http.StatusBadRequest)
		return
	}
	hostKey := strings.TrimSpace(f.Get("host_key"))
	if hostKey != "" {
		k, _, _, _, err := ssh.ParseAuthorizedKey([]byte(hostKey))
		if err != nil {
			hs.mu.Unlock()
			http.Error(w, "webmosh: "+L("cannot read this computer's SSH host key", "读不懂这台电脑的 SSH 主机密钥"), http.StatusBadRequest)
			return
		}
		hostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
	}
	h.User, h.Shell, h.System, h.HostKey = user, f.Get("shell"), f.Get("system"), hostKey
	h.MoshServer = f.Get("mosh_server")
	node := h.Node
	hs.save()
	hs.mu.Unlock()
	if hostKey == "" {
		hs.setResult(node, fmt.Errorf("%s", L("this computer has no /etc/ssh/ssh_host_ed25519_key.pub, so its SSH host key is unknown",
			"这台电脑没有 /etc/ssh/ssh_host_ed25519_key.pub，读不到它的 SSH 主机密钥")))
	} else {
		hs.check(node)
	}
	hs.mu.Lock()
	state, errText, name, mosh := h.State, h.Error, h.Name, h.MoshServer
	hs.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if state == "ready" {
		msg := fmt.Sprintf(L("webmosh: set up. In the terminal: ssh %s", "webmosh: 设置完成。在终端里：ssh %s"), name)
		if mosh != "" {
			msg += fmt.Sprintf(L(", or mosh %s", "，或 mosh %s"), name)
		} else {
			msg += L(" (mosh is not installed here; once it is, press Test on the hosts page)", "（这台电脑没装 mosh，装好后在终端主机页点「测试」）")
		}
		fmt.Fprintln(w, msg)
	} else {
		fmt.Fprintf(w, L("webmosh: the relay cannot log in to this computer: %s\n", "webmosh: 中继登录不了这台电脑：%s\n"), errText)
		if f.Get("sshd") == "no" {
			fmt.Fprintln(w, L("webmosh: sshd is not listening on port 22 here (macOS: System Settings > General > Sharing > Remote Login)",
				"webmosh: 这台电脑的 sshd 没在 22 端口上（macOS：系统设置 > 通用 > 共享 > 远程登录）"))
		}
	}
}

// check logs in with the relay key and runs the gate's webmosh-check.
func (hs *Hosts) check(node string) {
	hs.mu.Lock()
	h := hs.byNode[node]
	if h == nil {
		hs.mu.Unlock()
		return
	}
	t := h.target()
	hs.mu.Unlock()
	if t.hostKey == nil {
		hs.setResult(node, fmt.Errorf("%s", L("no SSH host key for this computer yet: run the setup line on it first", "还没有这台电脑的 SSH 主机密钥：先在它上面运行设置命令")))
		return
	}
	client, err := dialTarget(t, hs.r.cfg)
	if err != nil {
		hs.setResult(node, explainSSH(err))
		return
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		hs.setResult(node, err)
		return
	}
	defer sess.Close()
	out, err := sess.CombinedOutput("webmosh-check")
	if err != nil {
		hs.setResult(node, fmt.Errorf("webmosh-check: %v %s", err, strings.TrimSpace(string(out))))
		return
	}
	info := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		if k, v, ok := strings.Cut(sc.Text(), "="); ok {
			info[k] = v
		}
	}
	if info["user"] == "" {
		hs.setResult(node, fmt.Errorf("%s", L("logged in, but webmosh-gate did not answer (the authorized_keys line is wrong)", "登录进去了，但不是 webmosh-gate 在回答（authorized_keys 那一行不对）")))
		return
	}
	hs.mu.Lock()
	h.Shell, h.System, h.MoshServer, h.MoshVersion = info["shell"], info["system"], info["mosh_server"], info["mosh_version"]
	hs.mu.Unlock()
	hs.setResult(node, nil)
}

func explainSSH(err error) error {
	s := err.Error()
	switch {
	case strings.Contains(s, "connection refused"):
		return fmt.Errorf("%s", L("sshd is off (macOS: System Settings > General > Sharing > Remote Login)", "sshd 没开（macOS：系统设置 > 通用 > 共享 > 远程登录）"))
	case strings.Contains(s, "unable to authenticate"):
		return fmt.Errorf("%s", L("the key was refused (no line for the relay in authorized_keys, or the wrong user)", "密钥不被接受（authorized_keys 里没有中继那一行，或用户不对）"))
	case strings.Contains(s, "host key mismatch"):
		return fmt.Errorf("%s", L("the SSH host key is not the one reported at setup: run the setup line again", "SSH 主机密钥和设置时报告的不一样：重新运行设置命令"))
	case strings.Contains(s, "i/o timeout"):
		return fmt.Errorf("%s", L("unreachable (the computer is offline or not on the tailnet)", "连不上（电脑离线或不在 tailnet 上）"))
	}
	return err
}

func (hs *Hosts) setResult(node string, err error) {
	hs.mu.Lock()
	if h := hs.byNode[node]; h != nil {
		h.Checked = time.Now()
		if err != nil {
			h.State, h.Error = "error", err.Error()
		} else {
			h.State, h.Error = "ready", ""
		}
		log.Printf("hosts: %s (%s) checked: %s %s", h.Name, h.IP, h.State, h.Error)
		hs.save()
	}
	hs.mu.Unlock()
	hs.r.broadcastHosts()
}

// ---- the management API (the hosts page) ---------------------------------------------------------

type hostView struct {
	*Host
	Setup       string   `json:"setup,omitempty"` // the setup line, while it is valid
	SetupExpiry string   `json:"setup_expiry,omitempty"`
	Shadowed    []string `json:"shadowed,omitempty"` // "mosh box → build box": a name that reaches someone else by that protocol
}

func (hs *Hosts) view() []hostView {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	var out []hostView
	for _, h := range hs.sortedLocked() {
		v := hostView{Host: h, Shadowed: hs.shadowedLocked(h)}
		if h.token != "" && time.Now().Before(h.tokenExpiry) {
			v.Setup = fmt.Sprintf("curl -fsSL '%s/setup.sh?t=%s' | sh", hs.r.cfg.Origin, h.token)
			v.SetupExpiry = h.tokenExpiry.Format(time.RFC3339)
		}
		out = append(out, v)
	}
	return out
}

// serveAPI: GET /api/hosts; POST /api/hosts/{setup,test,update,forget} with {"node": …}. The page (or an embedding
// panel, an allowed origin) calls it with the owner's identity; POSTs must carry an allowed Origin (CSRF).
func (hs *Hosts) serveAPI(w http.ResponseWriter, req *http.Request) {
	origin := req.Header.Get("Origin")
	if origin != "" && hs.r.originAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Vary", "Origin")
	}
	if req.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !hs.r.allowed(req) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	reply := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(v)
	}
	if req.Method == http.MethodGet && req.URL.Path == "/api/hosts" {
		reply(map[string]any{"hosts": hs.view(), "targets": hs.r.configTargets(), "relay": hs.r.cfg.Origin})
		return
	}
	if req.Method != http.MethodPost || !hs.r.originAllowed(origin) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Node    string    `json:"node"`
		Name    *string   `json:"name"`
		Aliases *[]string `json:"aliases"`
		Port    *int      `json:"port"`
		Off     *bool     `json:"off"`
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, 8<<10)).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	switch strings.TrimPrefix(req.URL.Path, "/api/hosts/") {
	case "setup":
		cmd, err := hs.setupCommand(body.Node)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		hs.r.broadcastHosts()
		reply(map[string]string{"command": cmd})
	case "test":
		hs.check(body.Node)
		reply(map[string]any{"hosts": hs.view()})
	case "update":
		if err := hs.update(body.Node, body.Name, body.Aliases, body.Port, body.Off); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		hs.r.broadcastHosts()
		reply(map[string]any{"hosts": hs.view()})
	case "forget":
		hs.mu.Lock()
		if h := hs.byNode[body.Node]; h != nil {
			*h = Host{Node: h.Node, Name: h.Name, Display: h.Display, DNSName: h.DNSName, OS: h.OS, IP: h.IP,
				Online: h.Online, LastSeen: h.LastSeen, FirstSeen: h.FirstSeen, Gone: h.Gone, State: "new"}
			if h.Gone {
				delete(hs.byNode, body.Node)
			}
			hs.save()
		}
		hs.mu.Unlock()
		hs.r.broadcastHosts()
		reply(map[string]any{"hosts": hs.view(),
			"undo": "sed -i.bak '/" + keyComment() + "/d' ~/.ssh/authorized_keys && rm -f ~/.local/bin/webmosh-gate"})
	default:
		http.NotFound(w, req)
	}
}

var nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)

func (hs *Hosts) update(node string, name *string, aliases *[]string, port *int, off *bool) error {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	h := hs.byNode[node]
	if h == nil {
		return fmt.Errorf("%s", L("no such computer", "没有这台电脑"))
	}
	// a name is refused only if every protocol this host has already reaches someone else by it
	check := func(n string) error {
		if !nameRE.MatchString(n) {
			return fmt.Errorf(L("a name takes lowercase letters, digits, dots, dashes and underscores only: %q", "名字只能用小写字母、数字、点、横线、下划线：%q"), n)
		}
		for _, k := range hostKinds(h) {
			if !hs.takenLocked(n, k, h) {
				return nil
			}
		}
		if len(hostKinds(h)) == 1 {
			return fmt.Errorf(L("there is already an ssh host called %q", "ssh 里已经有叫 %q 的主机了"), n)
		}
		return fmt.Errorf(L("there are already a mosh and an ssh host called %q", "mosh 和 ssh 里都已经有叫 %q 的主机了"), n)
	}
	if name != nil {
		if err := check(*name); err != nil {
			return err
		}
		h.Name = *name
	}
	if aliases != nil {
		var list []string
		for _, a := range *aliases {
			if a = strings.TrimSpace(a); a == "" || a == h.Name {
				continue
			}
			if err := check(a); err != nil {
				return err
			}
			list = append(list, a)
		}
		h.Aliases = list
	}
	if port != nil {
		if *port < 0 || *port > 65535 {
			return fmt.Errorf("%s", L("bad port", "端口不对"))
		}
		h.Port = *port
	}
	if off != nil {
		switch {
		case *off:
			h.State = "off"
		case h.State == "off":
			h.State = "error"
			h.Error = L("enabled again: press Test", "重新启用：点「测试」")
		}
	}
	hs.save()
	return nil
}

// ---- ntfy ---------------------------------------------------------------------------------------

func (r *Relay) notify(title, message string) {
	if r.cfg.NtfyTopic == "" {
		return
	}
	server := r.cfg.NtfyServer
	if server == "" {
		server = "https://ntfy.sh"
	}
	body := map[string]any{"topic": r.cfg.NtfyTopic, "title": title, "message": message, "priority": 3}
	if r.cfg.HostsPage != "" {
		body["click"] = r.cfg.HostsPage
	}
	b, _ := json.Marshal(body)
	go func() {
		resp, err := http.Post(strings.TrimRight(server, "/"), "application/json", bytes.NewReader(b))
		if err != nil {
			log.Printf("ntfy: %v", err)
			return
		}
		resp.Body.Close()
	}()
}
