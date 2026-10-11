package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
	"golang.org/x/crypto/ssh"
)

type Relay struct {
	cfg     *Config
	api     *webrtc.API
	turn    *turnServer // nil without turn_listen
	ttl     time.Duration
	targets map[string]*Target

	mu       sync.Mutex
	sessions map[string]*Session

	hosts   *Hosts   // tailnet computers (hosts.go)
	devices *Devices // what each device's page last had (devices.go)

	clientsMu  sync.Mutex
	clients    map[int]func(wsMsg) // connected pages, for broadcasts
	nextClient int
}

func newRelay(cfg *Config) (*Relay, error) {
	ttl, err := time.ParseDuration(cfg.DetachedTTL)
	if err != nil {
		return nil, fmt.Errorf("detached_ttl: %w", err)
	}
	var nets []*net.IPNet
	for _, c := range cfg.ICENets {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			return nil, fmt.Errorf("ice_nets: %w", err)
		}
		nets = append(nets, n)
	}

	se := webrtc.SettingEngine{}
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	// Offer candidates only on the tailnet: the page is always a tailnet peer, and nothing else
	// (the LAN, Docker bridges) should see a port open.
	if len(nets) > 0 {
		se.SetIPFilter(func(ip net.IP) bool {
			for _, n := range nets {
				if n.Contains(ip) {
					return true
				}
			}
			return false
		})
	}
	// Safari hides its host candidates behind .local names that cannot resolve across Tailscale;
	// the page's connectivity checks still reach us and become peer-reflexive candidates.
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)

	r := &Relay{
		cfg:      cfg,
		api:      webrtc.NewAPI(webrtc.WithSettingEngine(se)),
		ttl:      ttl,
		targets:  map[string]*Target{},
		sessions: map[string]*Session{},
	}
	if cfg.TURNListen != "" {
		if r.turn, err = startTURN(cfg.TURNListen); err != nil {
			return nil, fmt.Errorf("turn: %w", err)
		}
	}
	for i := range cfg.Targets {
		t := &cfg.Targets[i]
		r.targets[t.ID] = t
	}
	r.clients = map[int]func(wsMsg){}
	r.hosts = newHosts(r)
	r.devices = newDevices(r)
	r.restore()
	go r.reap()
	go r.hosts.run()
	return r, nil
}

// allowed: the owner, through tailscale serve. tailscale serve strips any client-sent
// Tailscale-* headers and connects from loopback, so the header can be trusted only there.
func (r *Relay) allowed(req *http.Request) bool {
	if r.cfg.Owner == "" {
		return true
	}
	host, _, _ := net.SplitHostPort(req.RemoteAddr)
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return false
	}
	return req.Header.Get("Tailscale-User-Login") == r.cfg.Owner
}

type wsMsg struct {
	T       string       `json:"t"`
	Target  string       `json:"target,omitempty"`
	ID      string       `json:"id,omitempty"`
	Ref     string       `json:"ref,omitempty"` // the page's tab that sent an open (echoed in its session or error), or an attach's offer (echoed in its answer)
	SDP     string       `json:"sdp,omitempty"`
	Key     string       `json:"key,omitempty"`
	Port    int          `json:"port,omitempty"`
	Msg     string       `json:"msg,omitempty"`
	Login   string       `json:"login,omitempty"`
	Targets []targetInfo `json:"targets,omitempty"`
	ICE     []turnCreds  `json:"ice,omitempty"` // iceServers for the page's RTCPeerConnection
	Lines   []string     `json:"lines,omitempty"`
	IDs     []string     `json:"ids,omitempty"`  // own / replaced: session ids
	Kind    string       `json:"kind,omitempty"` // "mosh" (default) or "ssh"
	Cols    int          `json:"cols,omitempty"`
	Rows    int          `json:"rows,omitempty"`
	// tabs: the page's saved tabs; hello: this device's, as its page last sent them (devices.go)
	Saved json.RawMessage `json:"saved,omitempty"`
	Shown bool            `json:"shown,omitempty"` // shown: the embedding panel shows the terminal (false: hides it)
	WS    bool            `json:"ws,omitempty"`    // attach: over a WebSocket of its own, not WebRTC (link.go)
	Link  string          `json:"link,omitempty"`  // answer to such an attach: the /link ticket
}

type targetInfo struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Aliases []string `json:"aliases,omitempty"`
	Mosh    bool     `json:"mosh"`
	SSH     bool     `json:"ssh"`
}

func (r *Relay) configTargets() []targetInfo {
	var list []targetInfo
	for _, t := range r.cfg.Targets {
		list = append(list, targetInfo{ID: t.ID, Name: t.Name, Aliases: t.Aliases, Mosh: true, SSH: t.Local || t.gated})
	}
	return list
}

func (r *Relay) allTargets() []targetInfo {
	return append(r.configTargets(), r.hosts.targetInfos()...)
}

// resolve: what `<kind> <name>` reaches: a config target, else a ready tailnet host (names are unique per
// protocol, hosts.go)
func (r *Relay) resolve(name, kind string) *Target {
	r.hosts.mu.Lock()
	defer r.hosts.mu.Unlock()
	_, t, h := r.hosts.holderLocked(name, kind, true)
	if t != nil {
		return t
	}
	if h != nil {
		return h.target()
	}
	return nil
}

func (r *Relay) connected(c int) bool {
	r.clientsMu.Lock()
	defer r.clientsMu.Unlock()
	_, ok := r.clients[c]
	return ok
}

func (r *Relay) list() []*Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s)
	}
	return out
}

func (r *Relay) broadcast(m wsMsg) {
	r.clientsMu.Lock()
	sends := make([]func(wsMsg), 0, len(r.clients))
	for _, f := range r.clients {
		sends = append(sends, f)
	}
	r.clientsMu.Unlock()
	for _, f := range sends {
		go f(m)
	}
}

// broadcastHosts: the host list changed (a computer set up, renamed, gone)
func (r *Relay) broadcastHosts() { r.broadcast(wsMsg{T: "hosts", Targets: r.allTargets()}) }

func (r *Relay) originAllowed(o string) bool {
	if o == "" {
		return false
	}
	if o == r.cfg.Origin {
		return true
	}
	for _, a := range r.cfg.FrameAncestors {
		if o == a {
			return true
		}
	}
	return false
}

// publicKey: the relay key's public half, authorized_keys form
func (r *Relay) publicKey() (string, error) {
	b, err := os.ReadFile(r.cfg.SSHKey)
	if err != nil {
		return "", err
	}
	signer, err := ssh.ParsePrivateKey(b)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))), nil
}

// pageRequest: a WebSocket from the owner's page: the owner (allowed), and the page's own origin. The owner's identity
// comes with every request their browser makes to this host, so a page from anywhere else must not be able to open
// these sockets (cross-site WebSocket hijacking).
func (r *Relay) pageRequest(w http.ResponseWriter, req *http.Request) bool {
	if !r.allowed(req) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	if r.cfg.Origin != "" && req.Header.Get("Origin") != r.cfg.Origin {
		log.Printf("%s: refused origin %q", req.URL.Path, req.Header.Get("Origin"))
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return false
	}
	return true
}

func (r *Relay) serveWS(w http.ResponseWriter, req *http.Request) {
	if !r.pageRequest(w, req) {
		return
	}
	c, err := websocket.Accept(w, req, &websocket.AcceptOptions{InsecureSkipVerify: true}) // origin checked above
	if err != nil {
		return
	}
	login := req.Header.Get("Tailscale-User-Login")
	ctx := req.Context()
	defer c.CloseNow()

	send := func(m wsMsg) error {
		b, _ := json.Marshal(m)
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return c.Write(wctx, websocket.MessageText, b)
	}
	// m says what failed: Ref (an open, for that tab) or ID (an attach, for that session)
	fail := func(m wsMsg, format string, a ...any) {
		m.T, m.Msg = "error", fmt.Sprintf(format, a...)
		send(m)
	}

	dev := deviceKey(req)
	hello := wsMsg{T: "hello", Login: login, Targets: r.allTargets(), Target: r.cfg.DefaultTarget, Saved: r.devices.get(dev).Tabs}
	if err := send(hello); err != nil {
		return
	}
	// iPadOS kills a swiped-away app, or freezes a page in the background, without closing its socket; until a write
	// failed, such a page counted as connected for good, and the sessions a reloaded page had replaced waited on it
	// (2026-10-10: a Kiosk relaunch left its old mosh-server running). Pings find it within 45 s.
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			err := c.Ping(pctx)
			cancel()
			if err != nil {
				c.CloseNow()
				return
			}
		}
	}()
	r.clientsMu.Lock()
	r.nextClient++
	me := r.nextClient
	r.clients[me] = func(m wsMsg) { send(m) }
	r.clientsMu.Unlock()
	defer func() {
		r.clientsMu.Lock()
		delete(r.clients, me)
		r.clientsMu.Unlock()
		// sessions a reloaded page has taken over end with the page that had them
		for _, s := range r.list() {
			s.mu.Lock()
			end := s.owner == me && s.replaced
			s.mu.Unlock()
			if end {
				r.drop(s, "replaced by a reloaded page")
			}
		}
	}()

	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		var m wsMsg
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		switch m.T {
		case "open":
			kind := m.Kind
			if kind != "ssh" {
				kind = "mosh"
			}
			t := r.resolve(m.Target, kind)
			if t == nil {
				fail(wsMsg{Ref: m.Ref}, L("no host %[2]s for %[1]s", "没有能 %[1]s 的 %[2]s"), kind, m.Target)
				continue
			}
			s, err := r.open(t, kind, m.Cols, m.Rows)
			if err != nil {
				log.Printf("open %s %s for %s: %v", kind, t.ID, login, err)
				if kind == "ssh" {
					fail(wsMsg{Ref: m.Ref}, L("cannot reach %s: %v", "连不上 %s：%v"), t.Name, err)
				} else {
					fail(wsMsg{Ref: m.Ref}, "could not start mosh-server on %s: %v", t.Name, err)
				}
				continue
			}
			s.setOwner(me)
			if kind == "ssh" {
				log.Printf("session %s: ssh %s opened by %s", s.id, t.ID, login)
			} else {
				log.Printf("session %s: %s opened by %s (mosh-server udp %s)", s.id, t.ID, login, s.udp.RemoteAddr())
			}
			send(r.sessionMsg(s, m.Ref))
		case "resume": // a page reloaded: its ssh session is still here
			s := r.get(m.ID)
			if s == nil || s.kind != "ssh" {
				send(wsMsg{T: "gone", ID: m.ID, Ref: m.Ref})
				continue
			}
			s.setOwner(me)
			send(r.sessionMsg(s, m.Ref))
		case "own": // a page after a WebSocket reconnect: these sessions are still its own
			for _, id := range m.IDs {
				if s := r.get(id); s != nil {
					s.setOwner(me)
				}
			}
		case "replaced": // a reloaded page reopened these tabs: their old mosh sessions are of no use to anyone
			for _, id := range m.IDs {
				s := r.get(id)
				if s == nil || s.kind != "mosh" {
					continue
				}
				s.mu.Lock()
				owner := s.owner
				s.mu.Unlock()
				if owner == me {
					continue
				}
				if !r.connected(owner) {
					r.drop(s, "replaced by a reloaded page")
				} else {
					s.mu.Lock()
					s.replaced = true
					s.mu.Unlock()
				}
			}
		case "tabs": // the page's tabs changed: kept for a page of this device that comes back with its storage empty
			r.devices.setTabs(dev, m.Saved)
		case "shown": // the embedding panel showed or hid the terminal: it opens again at the next start if it was on screen
			r.devices.setShown(dev, m.Shown)
		case "resize":
			if s := r.get(m.ID); s != nil && s.pty != nil {
				s.pty.resize(m.Cols, m.Rows)
			}
		case "nudge":
			if s := r.get(m.ID); s != nil && s.pty != nil {
				s.pty.nudge()
			}
		case "attach":
			s := r.get(m.ID)
			if s == nil {
				send(wsMsg{T: "gone", ID: m.ID})
				continue
			}
			s.setOwner(me)
			if m.WS { // the page's WebRTC cannot reach us: it opens /link with this ticket instead
				send(wsMsg{T: "answer", ID: s.id, Link: s.linkTicket(), Ref: m.Ref})
				continue
			}
			answer, err := s.attach(r.api, m.SDP)
			if err != nil {
				log.Printf("session %s: attach: %v", s.id, err)
				fail(wsMsg{ID: s.id}, "attach: %v", err)
				continue
			}
			// Ref: which of the page's offers this answers (a woken page can have sent more than one)
			send(wsMsg{T: "answer", ID: s.id, SDP: answer, Ref: m.Ref})
		case "keylog": // the page's ?keylog mode: Option and composition events only
			for i, l := range m.Lines {
				if i >= 50 {
					break
				}
				if len(l) > 300 {
					l = l[:300]
				}
				log.Printf("keylog %s: %s", login, l)
			}
		case "close":
			if s := r.get(m.ID); s != nil {
				r.drop(s, "closed by page")
			}
		}
	}
}

func (r *Relay) sessionMsg(s *Session, ref string) wsMsg {
	m := wsMsg{T: "session", ID: s.id, Ref: ref, Target: s.target.ID, Kind: s.kind, Key: s.key, Port: s.port}
	if s.turn.Username != "" {
		m.ICE = []turnCreds{s.turn}
	}
	return m
}

func (r *Relay) open(t *Target, kind string, cols, rows int) (*Session, error) {
	if kind == "ssh" {
		p, err := startPTY(t, r.cfg, cols, rows)
		if err != nil {
			return nil, err
		}
		s := &Session{id: newID(), kind: "ssh", target: t, pty: p, created: time.Now(), detachedAt: time.Now()}
		if r.turn != nil {
			s.turn = r.turn.mint()
		}
		r.mu.Lock()
		r.sessions[s.id] = s
		r.mu.Unlock()
		go func() {
			<-p.done
			s.ptyExited()
			r.drop(s, "shell exited")
			r.broadcast(wsMsg{T: "gone", ID: s.id})
		}()
		return s, nil
	}
	ms, err := startMoshServer(t, r.cfg)
	if err != nil {
		return nil, err
	}
	udp, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: ms.ip, Port: ms.port})
	if err != nil {
		return nil, err
	}
	s := &Session{id: newID(), kind: "mosh", target: t, host: ms.ip, port: ms.port, key: ms.key, pid: ms.pid,
		udp: udp, created: time.Now(), detachedAt: time.Now()}
	if r.turn != nil {
		s.turn = r.turn.mint()
	}
	r.mu.Lock()
	r.sessions[s.id] = s
	r.mu.Unlock()
	r.save()
	go s.pumpFromServer()
	return s, nil
}

func (r *Relay) get(id string) *Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[id]
}

// drop forgets a session for good: closes its sockets and ends its mosh-server: a local one with
// SIGTERM (the shell gets SIGHUP), a remote one through the target's webmosh-gate if it has one
// (end_via_ssh); otherwise that mosh-server waits out MOSH_SERVER_NETWORK_TMOUT.
func (r *Relay) drop(s *Session, why string) {
	r.mu.Lock()
	_, had := r.sessions[s.id]
	delete(r.sessions, s.id)
	r.mu.Unlock()
	if !had {
		return
	}
	r.save()
	s.close()
	if r.turn != nil {
		r.turn.forget(s.turn)
	}
	if s.kind == "ssh" {
		log.Printf("session %s: ssh %s dropped (%s)", s.id, s.target.ID, why)
		return
	}
	ended := ""
	if s.target.Local && s.pid > 0 {
		if err := syscall.Kill(s.pid, syscall.SIGTERM); err == nil {
			ended = fmt.Sprintf(", ended mosh-server %d", s.pid)
		}
	} else if s.target.EndViaSSH {
		go func() {
			out, err := endRemote(s.target, r.cfg, s.port)
			if err != nil {
				log.Printf("session %s: ending the mosh-server on %s: %v %s", s.id, s.target.ID, err, out)
			} else {
				log.Printf("session %s: %s", s.id, out)
			}
		}()
	}
	log.Printf("session %s: %s dropped (%s), %d datagrams up, %d down%s", s.id, s.target.ID, why, s.up.Load(), s.down.Load(), ended)
}

// reap drops sessions whose page has been gone longer than the TTL.
func (r *Relay) reap() {
	for range time.Tick(time.Minute) {
		r.mu.Lock()
		var old []*Session
		for _, s := range r.sessions {
			if at := s.detachedSince(); !at.IsZero() && time.Since(at) > r.ttl {
				old = append(old, s)
			}
		}
		r.mu.Unlock()
		for _, s := range old {
			r.drop(s, "page gone for "+r.ttl.String())
		}
	}
}

// suspendAll is the relay stopping: mosh sessions stay in the state file and their mosh-servers keep
// running; the next relay reopens the sockets and the pages reattach as if they had roamed. An ssh
// session lives in this process and ends with it (its page opens a new one and goes back into tmux).
func (r *Relay) suspendAll() {
	r.save()
	r.mu.Lock()
	all := make([]*Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		all = append(all, s)
	}
	r.mu.Unlock()
	kept := 0
	for _, s := range all {
		s.close()
		if s.kind != "ssh" {
			kept++
		}
	}
	log.Printf("stopping: %d mosh session(s) kept for the next relay, %d ssh session(s) ended", kept, len(all)-kept)
}

// ---- persistence ---------------------------------------------------------------------------

type savedSession struct {
	ID      string    `json:"id"`
	Target  string    `json:"target"`
	Host    string    `json:"host"`
	Port    int       `json:"port"`
	Key     string    `json:"key"` // the mosh session key: the file is 0600 in the relay's own state dir
	PID     int       `json:"pid,omitempty"`
	TURN    turnCreds `json:"turn"`
	Created time.Time `json:"created"`
}

func (r *Relay) statePath() string {
	return filepath.Join(r.cfg.StateDir, "sessions.json") // main sets StateDir (stateDir)
}

func (r *Relay) save() {
	path := r.statePath()
	if path == "" {
		return
	}
	r.mu.Lock()
	list := make([]savedSession, 0, len(r.sessions))
	for _, s := range r.sessions {
		if s.kind == "ssh" { // ends with the relay
			continue
		}
		list = append(list, savedSession{ID: s.id, Target: s.target.ID, Host: s.host.String(), Port: s.port,
			Key: s.key, PID: s.pid, TURN: s.turn, Created: s.created})
	}
	r.mu.Unlock()
	b, _ := json.MarshalIndent(list, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("state: %v", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		log.Printf("state: %v", err)
	}
}

// restore reopens the sessions a previous relay left. A new UDP socket means a new source port;
// mosh-server takes the next authenticated datagram from it as the client having roamed.
func (r *Relay) restore() {
	path := r.statePath()
	if path == "" {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var list []savedSession
	if err := json.Unmarshal(b, &list); err != nil {
		log.Printf("state: %v", err)
		return
	}
	for _, v := range list {
		t := r.resolve(v.Target, "mosh") // a config target, or a tailnet host by name
		ip := net.ParseIP(v.Host)
		if t == nil || ip == nil {
			continue
		}
		if t.Local && v.PID > 0 && syscall.Kill(v.PID, 0) != nil {
			log.Printf("session %s: mosh-server %d is gone, not restored", v.ID, v.PID)
			continue
		}
		udp, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: ip, Port: v.Port})
		if err != nil {
			continue
		}
		s := &Session{id: v.ID, target: t, host: ip, port: v.Port, key: v.Key, pid: v.PID, turn: v.TURN,
			udp: udp, created: v.Created, detachedAt: time.Now()}
		if r.turn != nil && v.TURN.Username != "" {
			r.turn.restore(v.TURN)
		}
		r.sessions[s.id] = s
		go s.pumpFromServer()
		log.Printf("session %s: %s restored (mosh-server udp %s)", s.id, t.ID, udp.RemoteAddr())
	}
	r.save()
}

// serveClose is the page going away (pagehide, sent as a beacon): end its session now rather than
// leave a mosh-server waiting for 12 hours.
func (r *Relay) serveClose(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost || !r.allowed(req) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if o := req.Header.Get("Origin"); r.cfg.Origin != "" && o != r.cfg.Origin && !(o == "" && req.Header.Get("Sec-Fetch-Site") == "same-origin") {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	b, _ := io.ReadAll(io.LimitReader(req.Body, 100))
	if s := r.get(strings.TrimSpace(string(b))); s != nil {
		r.drop(s, "page closed")
	}
	w.WriteHeader(http.StatusNoContent)
}

func newID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

var errClosed = errors.New("session closed")
