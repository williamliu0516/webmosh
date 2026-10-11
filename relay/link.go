package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

// link: how a session reaches its page. Normally a WebRTC data channel, which never resends, so mosh's datagrams keep
// UDP's manners. When the page's WebRTC cannot reach the relay it is a WebSocket of the session's own instead
// (/link): Firefox offers ICE no address on the Tailscale interface (2026-10-10), so with ice_nets on the tailnet its
// checks never arrive. Over a WebSocket a lost packet holds up the ones behind it, as with ssh, but mosh's prediction,
// its sync of the whole screen and a session that outlives the connection all stay.
type link interface {
	Send(b []byte) error     // a datagram (mosh) or a chunk of output (ssh)
	SendText(s string) error // an ssh session's control words: reset, live, exit
	Open() bool
	Buffered() uint64 // bytes not yet sent
	Close() error
}

// dcLink: a WebRTC data channel
type dcLink struct{ dc *webrtc.DataChannel }

func (l dcLink) Send(b []byte) error     { return l.dc.Send(b) }
func (l dcLink) SendText(s string) error { return l.dc.SendText(s) }
func (l dcLink) Open() bool              { return l.dc.ReadyState() == webrtc.DataChannelStateOpen }
func (l dcLink) Buffered() uint64        { return l.dc.BufferedAmount() }
func (l dcLink) Close() error            { return l.dc.Close() }

var errLinkFull = errors.New("link: send queue full")

// wsLink: a WebSocket. Sends are queued and written in order by one goroutine, so a slow page never blocks
// mosh-server's datagrams or the pty: a full queue drops datagrams, as UDP would (mosh sends the state again), and an
// ssh session whose page stops reading is cut off by its Buffered() as with a data channel.
type wsLink struct {
	c      *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	q      chan wsOut
	queued atomic.Int64
	closed atomic.Bool
}

type wsOut struct {
	text bool
	b    []byte
}

func newWSLink(c *websocket.Conn) *wsLink {
	ctx, cancel := context.WithCancel(context.Background())
	l := &wsLink{c: c, ctx: ctx, cancel: cancel, q: make(chan wsOut, 4096)}
	go l.run()
	return l
}

func (l *wsLink) run() {
	for {
		select {
		case <-l.ctx.Done():
			return
		case m := <-l.q:
			l.queued.Add(-int64(len(m.b)))
			typ := websocket.MessageBinary
			if m.text {
				typ = websocket.MessageText
			}
			wctx, cancel := context.WithTimeout(l.ctx, 10*time.Second)
			err := l.c.Write(wctx, typ, m.b)
			cancel()
			if err != nil {
				l.Close()
				return
			}
		}
	}
}

func (l *wsLink) put(m wsOut) error {
	if l.closed.Load() {
		return errClosed
	}
	select {
	case l.q <- m:
		l.queued.Add(int64(len(m.b)))
		return nil
	default:
		return errLinkFull
	}
}

func (l *wsLink) Send(b []byte) error     { return l.put(wsOut{b: append([]byte(nil), b...)}) } // b is reused by the caller
func (l *wsLink) SendText(s string) error { return l.put(wsOut{text: true, b: []byte(s)}) }
func (l *wsLink) Open() bool              { return !l.closed.Load() }
func (l *wsLink) Buffered() uint64        { return uint64(max(l.queued.Load(), 0)) }
func (l *wsLink) Close() error {
	if l.closed.CompareAndSwap(false, true) {
		l.cancel()
		l.c.CloseNow()
	}
	return nil
}

// linkTicket: a one-time ticket for the session's /link, given in the answer to an attach over the page's own socket
// (so the attach claims the session for that page, as a WebRTC one does); good for 30 s.
func (s *Session) linkTicket() string {
	b := make([]byte, 16)
	rand.Read(b)
	t := hex.EncodeToString(b)
	s.mu.Lock()
	s.ticket, s.ticketAt = t, time.Now()
	s.mu.Unlock()
	return t
}

func (s *Session) takeTicket(t string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	ok := s.ticket != "" && time.Since(s.ticketAt) < 30*time.Second && subtle.ConstantTimeCompare([]byte(s.ticket), []byte(t)) == 1
	if ok {
		s.ticket = ""
	}
	return ok
}

// serveLink: /link?id=&t=, a session's WebSocket link (above). The owner from the page's own origin only, as /ws.
func (r *Relay) serveLink(w http.ResponseWriter, req *http.Request) {
	if !r.pageRequest(w, req) {
		return
	}
	s := r.get(req.URL.Query().Get("id"))
	if s == nil {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	if !s.takeTicket(req.URL.Query().Get("t")) {
		http.Error(w, "bad ticket", http.StatusForbidden)
		return
	}
	c, err := websocket.Accept(w, req, &websocket.AcceptOptions{InsecureSkipVerify: true}) // origin checked above
	if err != nil {
		return
	}
	c.SetReadLimit(1 << 20) // an ssh tab's paste arrives as one message (a data channel takes far more than the 32 KB default)
	l := newWSLink(c)
	defer l.Close()
	if !s.attachLink(l) {
		return
	}
	log.Printf("session %s: websocket link open", s.id)
	defer func() {
		s.detach(l)
		log.Printf("session %s: websocket link closed", s.id)
	}()
	// the page's socket can die without a close (a frozen tab, a network gone): pings find it within 45 s
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-l.ctx.Done():
				return
			case <-t.C:
			}
			pctx, cancel := context.WithTimeout(l.ctx, 20*time.Second)
			err := c.Ping(pctx)
			cancel()
			if err != nil {
				l.Close()
				return
			}
		}
	}()
	for {
		typ, b, err := c.Read(l.ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			s.fromPage(b)
		}
	}
}
