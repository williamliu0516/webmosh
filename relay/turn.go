package main

import (
	"fmt"
	"log"
	"net"
	"strconv"
	"sync"

	"github.com/pion/turn/v4"
)

// TURN, for Safari. Safari hides its host addresses from WebRTC unless the page has camera or
// microphone access, and without STUN on the tailnet it may then have no candidate the relay can
// reach. A relayed candidate is never hidden, so the relay runs its own TURN server: on the
// tailnet address only, with credentials minted per session, and allowed to forward only to this
// relay's own address (it must not become an open relay into the tailnet).
type turnServer struct {
	srv   *turn.Server
	ip    net.IP
	port  int
	realm string

	mu    sync.Mutex
	creds map[string][]byte // username -> key
}

type turnCreds struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

func startTURN(listen string) (*turnServer, error) {
	host, portStr, err := net.SplitHostPort(listen)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(host).To4()
	if ip == nil {
		return nil, fmt.Errorf("turn_listen needs an IPv4 address, got %q", host)
	}
	port, _ := strconv.Atoi(portStr)
	pc, err := net.ListenPacket("udp4", listen)
	if err != nil {
		return nil, err
	}
	t := &turnServer{ip: ip, port: port, realm: "webmosh", creds: map[string][]byte{}}
	t.srv, err = turn.NewServer(turn.ServerConfig{
		Realm: t.realm,
		AuthHandler: func(username, realm string, src net.Addr) ([]byte, bool) {
			t.mu.Lock()
			defer t.mu.Unlock()
			k, ok := t.creds[username]
			return k, ok
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            pc,
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{RelayAddress: ip, Address: host},
			PermissionHandler: func(_ net.Addr, peer net.IP) bool {
				return peer.Equal(ip)
			},
		}},
	})
	if err != nil {
		pc.Close()
		return nil, err
	}
	log.Printf("turn on %s (relays to %s only)", listen, ip)
	return t, nil
}

// mint returns fresh credentials; forget() them when the session ends.
func (t *turnServer) mint() turnCreds {
	user, pass := newID(), newID()
	t.mu.Lock()
	t.creds[user] = turn.GenerateAuthKey(user, t.realm, pass)
	t.mu.Unlock()
	return turnCreds{
		URLs:       []string{fmt.Sprintf("turn:%s:%d?transport=udp", t.ip, t.port)},
		Username:   user,
		Credential: pass,
	}
}

// restore re-admits credentials a session held before the relay restarted.
func (t *turnServer) restore(c turnCreds) {
	t.mu.Lock()
	t.creds[c.Username] = turn.GenerateAuthKey(c.Username, t.realm, c.Credential)
	t.mu.Unlock()
}

func (t *turnServer) forget(c turnCreds) {
	t.mu.Lock()
	delete(t.creds, c.Username)
	t.mu.Unlock()
}
