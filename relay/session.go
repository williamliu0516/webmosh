package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

var debug = os.Getenv("WEBMOSH_DEBUG") != ""

// Session: one mosh-server and the UDP socket aimed at it, plus whichever link the page currently has attached
// (link.go: a data channel, or a WebSocket; none while the tab is frozen or reconnecting).
type Session struct {
	id      string
	kind    string // "mosh": datagrams to mosh-server; "ssh": a terminal the relay holds (pty.go)
	pty     *ptySession
	target  *Target
	host    net.IP
	port    int
	key     string
	pid     int // its mosh-server, on the target's computer: ended with the session (by SIGTERM here, or webmosh-end)
	created time.Time
	udp     *net.UDPConn
	turn    turnCreds // this session's TURN login, if the relay runs TURN

	up, down atomic.Int64 // datagrams page->server, server->page

	mu         sync.Mutex
	pc         *webrtc.PeerConnection // the current attachment when it is WebRTC (open or still connecting)
	ws         *wsLink                // the current attachment when it is a WebSocket
	link       link                   // the current attachment's open link, nil while none is open
	ticket     string                 // the /link ticket of an attach over WebSocket (link.go)
	ticketAt   time.Time
	detachedAt time.Time // zero while a link is open
	closed     bool
	owner      int  // the page connection (relay.clients) that opened, attached or claimed it last; 0 = none
	replaced   bool // a reloaded page took its tab over: it ends when its owner's connection does
}

func (s *Session) setOwner(c int) {
	s.mu.Lock()
	s.owner = c
	s.replaced = false
	s.mu.Unlock()
}

func (s *Session) detachedSince() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.detachedAt
}

// pumpFromServer forwards mosh-server's datagrams to the attached link; with none attached they
// are dropped, and mosh resends the current state once the page is back.
func (s *Session) pumpFromServer() {
	buf := make([]byte, 2048)
	for {
		n, err := s.udp.Read(buf)
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if closed {
				return
			}
			time.Sleep(50 * time.Millisecond) // e.g. ICMP port unreachable; don't spin
			continue
		}
		s.mu.Lock()
		l := s.link
		s.mu.Unlock()
		if l != nil && l.Open() {
			if l.Send(append([]byte(nil), buf[:n]...)) == nil {
				s.down.Add(1)
			}
		}
	}
}

// fromPage: what the page sent, to mosh-server (a datagram) or into the pty (keys)
func (s *Session) fromPage(b []byte) {
	if s.pty != nil {
		s.pty.write(b)
		s.up.Add(1)
		return
	}
	if _, err := s.udp.Write(b); err == nil {
		s.up.Add(1)
	}
}

// current: whether att (a *webrtc.PeerConnection or a *wsLink) is the session's attachment now. Under mu.
func (s *Session) current(att any) bool {
	switch a := att.(type) {
	case *webrtc.PeerConnection:
		return a != nil && s.pc == a
	case *wsLink:
		return a != nil && s.ws == a
	}
	return false
}

// replace makes pc or ws the attachment and closes the one before, whichever kind. Under mu; the closing is the caller's.
func (s *Session) replace(pc *webrtc.PeerConnection, ws *wsLink) (oldPC *webrtc.PeerConnection, oldWS *wsLink) {
	oldPC, oldWS = s.pc, s.ws
	s.pc, s.ws, s.link = pc, ws, nil
	if s.detachedAt.IsZero() {
		s.detachedAt = time.Now()
	}
	return
}

func closeOld(pc *webrtc.PeerConnection, ws *wsLink) {
	if pc != nil {
		go pc.Close()
	}
	if ws != nil {
		ws.Close()
	}
}

// opened: att's link l is open. An ssh session's page then gets the recent output (pty.go attach).
func (s *Session) opened(att any, l link) bool {
	s.mu.Lock()
	if s.closed || !s.current(att) {
		s.mu.Unlock()
		l.Close()
		return false
	}
	s.link = l
	s.detachedAt = time.Time{}
	s.mu.Unlock()
	if s.pty != nil {
		s.pty.attach(l)
	}
	return true
}

// attachLink: the page's WebSocket link (link.go) replaces whatever it had
func (s *Session) attachLink(l *wsLink) bool {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	oldPC, oldWS := s.replace(nil, l)
	s.mu.Unlock()
	closeOld(oldPC, oldWS)
	return s.opened(l, l)
}

// attach answers the page's offer with a new PeerConnection and replaces the previous attachment.
func (s *Session) attach(api *webrtc.API, offer string) (string, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return "", errClosed
	}
	s.mu.Unlock()

	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	oldPC, oldWS := s.replace(pc, nil)
	s.mu.Unlock()
	closeOld(oldPC, oldWS)
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		l := dcLink{dc}
		dc.OnOpen(func() { s.opened(pc, l) })
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			if s.pty == nil || !m.IsString { // an ssh session's keys are binary
				s.fromPage(m.Data)
			}
		})
		dc.OnClose(func() { s.detach(pc) })
	})
	pc.OnICEConnectionStateChange(func(st webrtc.ICEConnectionState) {
		if debug {
			log.Printf("session %s: ice %s", s.id, st)
		}
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		log.Printf("session %s: webrtc %s", s.id, st)
		if st == webrtc.PeerConnectionStateConnected {
			if sctp := pc.SCTP(); sctp != nil {
				if pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
					log.Printf("session %s: path local %s %s:%d <-> remote %s %s:%d", s.id,
						pair.Local.Typ, pair.Local.Address, pair.Local.Port, pair.Remote.Typ, pair.Remote.Address, pair.Remote.Port)
				}
			}
		}
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.detach(pc)
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		pc.Close()
		return "", err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return "", err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return "", err
	}
	select {
	case <-gathered:
	case <-time.After(3 * time.Second):
	}

	ld := pc.LocalDescription()
	if debug && ld != nil {
		log.Printf("session %s: offer:\n%s\nanswer:\n%s", s.id, offer, ld.SDP)
	}
	if ld == nil {
		return "", fmt.Errorf("no local description")
	}
	return ld.SDP, nil
}

// detach forgets att's link if att is still the current attachment.
func (s *Session) detach(att any) {
	s.mu.Lock()
	if !s.current(att) {
		s.mu.Unlock()
		return
	}
	l := s.link
	s.link = nil
	if s.detachedAt.IsZero() {
		s.detachedAt = time.Now()
	}
	s.mu.Unlock()
	if l != nil && s.pty != nil {
		s.pty.detach(l)
	}
}

func (s *Session) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	pc, ws := s.pc, s.ws
	s.pc, s.ws, s.link = nil, nil, nil
	s.mu.Unlock()
	if pc != nil {
		pc.Close()
	}
	if ws != nil {
		ws.Close()
	}
	if s.udp != nil {
		s.udp.Close()
	}
	if s.pty != nil {
		s.pty.close()
	}
}
