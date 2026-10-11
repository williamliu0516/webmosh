package main

import (
	"bytes"
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

// Session: one mosh-server and the UDP socket aimed at it, plus whichever data channel the page
// currently has attached (none while the tab is frozen or reconnecting).
type Session struct {
	id      string
	kind    string // "mosh": datagrams to mosh-server; "ssh": a terminal the relay holds (pty.go)
	pty     *ptySession
	target  *Target
	host    net.IP
	port    int
	key     string
	pid     int // local mosh-server, ended with the session
	created time.Time
	udp     *net.UDPConn
	turn    turnCreds // this session's TURN login, if the relay runs TURN

	up, down atomic.Int64 // datagrams page->server, server->page

	mu         sync.Mutex
	pc         *webrtc.PeerConnection
	dc         *webrtc.DataChannel
	detachedAt time.Time // zero while a data channel is open
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

// pumpFromServer forwards mosh-server's datagrams to the attached data channel; with none
// attached they are dropped, and mosh resends the current state once the page is back.
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
		dc := s.dc
		s.mu.Unlock()
		if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
			if dc.Send(append([]byte(nil), buf[:n]...)) == nil {
				s.down.Add(1)
			}
		}
	}
}

// attach answers the page's offer with a new PeerConnection and replaces the previous one.
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
	old := s.pc
	s.pc = pc
	s.dc = nil
	if s.detachedAt.IsZero() {
		s.detachedAt = time.Now()
	}
	s.mu.Unlock()
	if old != nil {
		go old.Close()
	}
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if s.kind == "ssh" {
			s.attachPTY(pc, dc)
			return
		}
		dc.OnOpen(func() {
			s.mu.Lock()
			if s.closed || s.pc != pc {
				s.mu.Unlock()
				dc.Close()
				return
			}
			s.dc = dc
			s.detachedAt = time.Time{}
			s.mu.Unlock()
		})
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			if _, err := s.udp.Write(m.Data); err == nil {
				s.up.Add(1)
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

// detach forgets pc if it is still the current one.
func (s *Session) detach(pc *webrtc.PeerConnection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pc != pc {
		return
	}
	s.dc = nil
	if s.detachedAt.IsZero() {
		s.detachedAt = time.Now()
	}
}

func (s *Session) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	pc := s.pc
	s.pc, s.dc = nil, nil
	s.mu.Unlock()
	if pc != nil {
		pc.Close()
	}
	if s.udp != nil {
		s.udp.Close()
	}
	if s.pty != nil {
		s.pty.close()
	}
}

// attachPTY: an ssh session's data channel. On open: "reset", the ring's recent output, "live", then live output; a
// resize nudge makes full-screen programs redraw. The page drops the terminal's answers to queries in the replay. Sent under the pty's lock, so nothing is lost or doubled between the
// replay and the live output.
func (s *Session) attachPTY(pc *webrtc.PeerConnection, dc *webrtc.DataChannel) {
	p := s.pty
	dc.OnOpen(func() {
		s.mu.Lock()
		if s.closed || s.pc != pc {
			s.mu.Unlock()
			dc.Close()
			return
		}
		s.dc = dc
		s.detachedAt = time.Time{}
		s.mu.Unlock()
		p.mu.Lock()
		dc.SendText("reset")
		replay := p.ring
		if len(replay) >= ringMax {
			if i := bytes.IndexByte(replay, '\n'); i >= 0 {
				replay = replay[i+1:]
			}
		}
		sendChunks(dc, replay)
		dc.SendText("live")
		p.dc = dc
		p.mu.Unlock()
		p.nudge()
	})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if !m.IsString {
			p.write(m.Data)
			s.up.Add(1)
		}
	})
	dc.OnClose(func() {
		p.mu.Lock()
		if p.dc == dc {
			p.dc = nil
		}
		p.mu.Unlock()
		s.detach(pc)
	})
}

// ptyExited: tell the attached page before the session goes
func (s *Session) ptyExited() {
	p := s.pty
	p.mu.Lock()
	if p.dc != nil && p.dc.ReadyState() == webrtc.DataChannelStateOpen {
		p.dc.SendText("exit")
	}
	p.mu.Unlock()
}

// sendChunks: SCTP messages stay well under the 64 KB browsers accept
func sendChunks(dc *webrtc.DataChannel, b []byte) error {
	for len(b) > 0 {
		n := min(len(b), 16<<10)
		if err := dc.Send(b[:n]); err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}
