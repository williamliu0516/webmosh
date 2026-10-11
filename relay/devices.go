package main

// What each device's page last had, kept on the relay: its tabs (host, tmux session, relay session per tab) and whether
// the embedding panel showed the terminal. The page keeps its tabs in localStorage too, but the iPad Kiosk app comes back from
// being swiped away with that storage empty (2026-10-10: a board reload restored the tab and typed the tmux attach, a
// Kiosk relaunch twelve minutes later restored nothing), so the user typed `mosh <host>` and `tmux` again. With this
// copy the page reopens the same tabs, and the panel brings the terminal back if it was on screen.
//
// A device is the owner's login plus the tailnet address the page comes from (tailscale serve's X-Forwarded-For).
// Pages of one device share a record, as they share localStorage: the last one to change its tabs wins.

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxDevices   = 64
	maxSavedTabs = 32 << 10 // bytes of the page's JSON
)

type deviceState struct {
	Tabs  json.RawMessage `json:"tabs,omitempty"` // the page's own record: {tabs: [...], active, at}
	Shown bool            `json:"shown"`          // the embedding panel showed the terminal last
	Seen  time.Time       `json:"seen"`
}

type Devices struct {
	mu    sync.Mutex
	path  string
	byKey map[string]*deviceState
}

func newDevices(r *Relay) *Devices {
	d := &Devices{byKey: map[string]*deviceState{}}
	if p := r.statePath(); p != "" {
		d.path = filepath.Join(filepath.Dir(p), "devices.json")
	}
	// development (no owner): every relay starts with none, so one test run's page never reopens another run's tabs
	// (all of them are one device, 127.0.0.1); within a run they are kept and saved as on the Pi
	if r.cfg.Owner != "" {
		d.load()
	}
	return d
}

func (d *Devices) load() {
	if d.path == "" {
		return
	}
	b, err := os.ReadFile(d.path)
	if err != nil {
		return
	}
	if err := json.Unmarshal(b, &d.byKey); err != nil {
		log.Printf("devices: %v", err)
		d.byKey = map[string]*deviceState{}
	}
}

// saveLocked writes the file (d.mu held); the oldest devices go past maxDevices
func (d *Devices) saveLocked() {
	if len(d.byKey) > maxDevices {
		keys := make([]string, 0, len(d.byKey))
		for k := range d.byKey {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return d.byKey[keys[i]].Seen.After(d.byKey[keys[j]].Seen) })
		for _, k := range keys[maxDevices:] {
			delete(d.byKey, k)
		}
	}
	if d.path == "" {
		return
	}
	b, _ := json.MarshalIndent(d.byKey, "", "  ")
	tmp := d.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("devices: %v", err)
		return
	}
	if err := os.Rename(tmp, d.path); err != nil {
		log.Printf("devices: %v", err)
	}
}

func (d *Devices) get(key string) deviceState {
	d.mu.Lock()
	defer d.mu.Unlock()
	if s := d.byKey[key]; s != nil {
		return *s
	}
	return deviceState{}
}

func (d *Devices) update(key string, f func(*deviceState)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := d.byKey[key]
	if s == nil {
		s = &deviceState{}
		d.byKey[key] = s
	}
	f(s)
	s.Seen = time.Now()
	d.saveLocked()
}

// setTabs keeps the page's record as it sent it: the page alone reads it back
func (d *Devices) setTabs(key string, tabs json.RawMessage) {
	if len(tabs) == 0 || len(tabs) > maxSavedTabs || !json.Valid(tabs) {
		return
	}
	d.update(key, func(s *deviceState) { s.Tabs = append(json.RawMessage(nil), tabs...) })
}

func (d *Devices) setShown(key string, on bool) {
	if d.get(key).Shown == on {
		return
	}
	d.update(key, func(s *deviceState) { s.Shown = on })
}

// deviceKey: the owner's login and the page's tailnet address. Behind tailscale serve (loopback) that is the last
// X-Forwarded-For entry, the one tailscale serve added; otherwise (development) the connection's own address.
func deviceKey(req *http.Request) string {
	ip, _, _ := net.SplitHostPort(req.RemoteAddr)
	if a := net.ParseIP(ip); a != nil && a.IsLoopback() {
		if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			ip = strings.TrimSpace(parts[len(parts)-1])
		}
	}
	return req.Header.Get("Tailscale-User-Login") + " " + ip
}

// serveDevice: GET /api/device, for the embedding panel at start: was the terminal on screen on this device. Same origin rules as
// /api/hosts.
func (r *Relay) serveDevice(w http.ResponseWriter, req *http.Request) {
	origin := req.Header.Get("Origin")
	if origin != "" && r.originAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		w.Header().Set("Vary", "Origin")
	}
	if req.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !r.allowed(req) || req.Method != http.MethodGet {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s := r.devices.get(deviceKey(req))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"shown": s.Shown})
}
