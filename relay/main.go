// webmosh-relay: carries a browser's mosh datagrams between a WebRTC data channel and UDP.
//
// The page runs mosh-client's core as WASM (see ../wasm). It cannot send UDP, so for each session
// this relay starts mosh-server on the target over SSH, hands the session key to the page, and then
// copies encrypted datagrams both ways: data channel <-> one UDP socket aimed at mosh-server. It
// never sees plaintext; mosh's own OCB encryption runs end to end between the page and the server.
//
// A session outlives its data channel: iPadOS freezes a backgrounded tab and the WebRTC connection
// dies, so the page reattaches with a new one and mosh carries on as if the client had roamed.
//
// Access: the relay listens on loopback behind `tailscale serve`, which adds Tailscale-User-Login.
// Only the configured owner gets in, and only from the page's own origin (identity rides along
// with every request the owner's browser makes, so a foreign page must not be able to use it).
package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

//go:embed all:static
var staticFS embed.FS

// version: the commit the relay was built from (`git describe --always --dirty`), set by scripts/build-all.sh with
// -ldflags; "dev" for a plain `go build`. -version prints it; the startup line and /site.json report it.
var version = "dev"

type Target struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Aliases    []string          `json:"aliases"` // other names the page's prompt accepts (`mosh box`)
	Host       string            `json:"host"`    // SSH host or host:port; mosh's UDP goes to the same host
	User       string            `json:"user"`
	MoshServer string            `json:"mosh_server"` // path on the target (non-login SSH has a bare PATH)
	Args       []string          `json:"args"`        // after "mosh-server new ...", e.g. ["--", "tmux", "new", "-A"]
	Local      bool              `json:"local"`       // run mosh-server on this machine (the relay's own shell), no SSH
	Env        map[string]string `json:"env"`         // Local only
	Locale     string            `json:"locale"`      // LANG for the remote shell; default en_US.UTF-8
	EndViaSSH  bool              `json:"end_via_ssh"` // the key's forced command is setup/webmosh-gate: the relay ends a closed page's mosh-server

	hostKey ssh.PublicKey // a tailnet host's pinned key (hosts.go); config targets use known_hosts
	gated   bool          // the key goes through webmosh-gate, which also gives a shell (`ssh <host>`)
}

type Config struct {
	Listen      string   `json:"listen"`      // 127.0.0.1:8810
	Origin      string   `json:"origin"`      // https://relay-host.tailnet-name.ts.net:8445
	Owner       string   `json:"owner"`       // Tailscale-User-Login let in; "" turns the check off (development)
	ICENets     []string `json:"ice_nets"`    // where WebRTC may listen, e.g. ["100.64.0.0/10"] (tailnet)
	TURNListen  string   `json:"turn_listen"` // e.g. "<the relay's tailnet IP>:3478"; "" = no TURN (see turn.go)
	SSHKey      string   `json:"ssh_key"`
	KnownHosts  string   `json:"known_hosts"`
	DetachedTTL string   `json:"detached_ttl"` // how long a session waits for its page, e.g. "12h"
	Targets     []Target `json:"targets"`

	DefaultTarget  string   `json:"default_target"`  // the page opens this on load (the landing shell)
	StateDir       string   `json:"state_dir"`       // sessions survive relay restarts; default: stateDir
	FrameAncestors []string `json:"frame_ancestors"` // origins that may embed the page and use /api/hosts (a panel)

	// the page
	Lang      string          `json:"lang"`       // "en" (default) or "zh": the page and the relay's own messages (lang.go)
	StaticDir string          `json:"static_dir"` // files served in place of the built-in page's: custom.css, fonts, pictures
	Page      json.RawMessage `json:"page"`       // the page's look, served as /site.json: {"theme": {...}, "terminal": {...}}

	// tailnet computers as hosts (hosts.go)
	TailscaleStatus string   `json:"tailscale_status"` // "" = run `tailscale status --json`; "file:<path>" for tests
	SSHFrom         []string `json:"ssh_from"`         // addresses added to the relay's tailnet IPs in the key's from=
	NtfyServer      string   `json:"ntfy_server"`      // default https://ntfy.sh
	NtfyTopic       string   `json:"ntfy_topic"`       // a new computer on the tailnet is announced here ("" = not)
	HostsPage       string   `json:"hosts_page"`       // the notification's link; default the page's own hosts page (/?hosts)
	HostsScan       string   `json:"hosts_scan"`       // how often to read tailscale status; default 1m
}

func loadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := &Config{Listen: "127.0.0.1:8810", DetachedTTL: "12h"}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	if c.Lang != "" && c.Lang != "en" && c.Lang != "zh" {
		return nil, fmt.Errorf(`lang %q: "en" or "zh"`, c.Lang)
	}
	if len(c.Page) > 0 {
		var page map[string]any
		if err := json.Unmarshal(c.Page, &page); err != nil {
			return nil, fmt.Errorf("page: %v", err)
		}
	}
	if c.StaticDir != "" {
		if st, err := os.Stat(c.StaticDir); err != nil || !st.IsDir() {
			return nil, fmt.Errorf("static_dir %s: not a directory", c.StaticDir)
		}
	}
	return c, nil
}

// stateDir: where sessions, hosts and device tabs are kept: the config's state_dir, systemd's StateDirectory=, or the
// user's own (~/Library/Application Support/webmosh on macOS, $XDG_STATE_HOME/webmosh or ~/.local/state/webmosh).
func stateDir(dir string) (string, error) {
	if dir == "" {
		dir = os.Getenv("STATE_DIRECTORY")
	}
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		switch {
		case runtime.GOOS == "darwin":
			dir = filepath.Join(home, "Library", "Application Support", "webmosh")
		case os.Getenv("XDG_STATE_HOME") != "":
			dir = filepath.Join(os.Getenv("XDG_STATE_HOME"), "webmosh")
		default:
			dir = filepath.Join(home, ".local", "state", "webmosh")
		}
	}
	return dir, os.MkdirAll(dir, 0o700)
}

// /site.json: the page's language and look (the config's "lang" and "page"), read before it draws anything
func siteJSON(c *Config) []byte {
	site := map[string]any{}
	if len(c.Page) > 0 {
		json.Unmarshal(c.Page, &site) // checked in loadConfig
	}
	site["lang"] = c.Lang
	site["version"] = version
	b, _ := json.Marshal(site)
	return b
}

// overlayFS serves a file from the config's static_dir when it has one, else the built-in one: a deployment's
// own custom.css, fonts and pictures over the page's defaults.
type overlayFS struct {
	dir  fs.FS // nil: no static_dir
	base fs.FS
}

func (o overlayFS) Open(name string) (fs.File, error) {
	if o.dir != nil {
		if st, err := fs.Stat(o.dir, name); err == nil && !st.IsDir() {
			return o.dir.Open(name)
		}
	}
	return o.base.Open(name)
}

func main() {
	cfgPath := flag.String("config", os.ExpandEnv("$HOME/.config/webmosh/relay.json"), "config file")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if cfg.Owner == "" {
		log.Printf("WARNING: no owner configured, identity check is off (development only)")
	}
	zh = cfg.Lang == "zh"
	if cfg.StateDir, err = stateDir(cfg.StateDir); err != nil {
		log.Fatalf("state_dir: %v", err)
	}
	r, err := newRelay(cfg)
	if err != nil {
		log.Fatalf("relay: %v", err)
	}

	ancestors := "'none'"
	if len(cfg.FrameAncestors) > 0 {
		ancestors = strings.Join(cfg.FrameAncestors, " ")
	}
	csp := "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors " + ancestors

	static, _ := fs.Sub(staticFS, "static")
	pageFS := overlayFS{base: static}
	if cfg.StaticDir != "" {
		pageFS.dir = os.DirFS(cfg.StaticDir)
	}
	files := http.FileServer(http.FS(pageFS))
	site := siteJSON(cfg)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", r.serveWS)
	mux.HandleFunc("/link", r.serveLink) // a session's WebSocket link, when WebRTC cannot connect (link.go)
	mux.HandleFunc("/close", r.serveClose)
	mux.HandleFunc("/upload", r.serveUpload)
	mux.HandleFunc("/api/hosts", r.hosts.serveAPI)
	mux.HandleFunc("/api/hosts/", r.hosts.serveAPI)
	mux.HandleFunc("/api/device", r.serveDevice)
	// the setup line run on a computer: its token is the authorization (curl there may carry no identity)
	mux.HandleFunc("/setup.sh", r.hosts.serveScript)
	mux.HandleFunc("/setup/report", r.hosts.serveReport)
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		if !r.allowed(req) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Security-Policy", csp)
		if req.URL.Path == "/site.json" {
			w.Header().Set("Content-Type", "application/json")
			w.Write(site)
			return
		}
		files.ServeHTTP(w, req)
	})

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()
	log.Printf("webmosh-relay %s on %s, origin %s, %d target(s), state in %s", version, cfg.Listen, cfg.Origin, len(cfg.Targets), cfg.StateDir)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	r.suspendAll() // sessions stay in the state file; the next relay picks them up
}
