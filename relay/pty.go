package main

// `ssh <host>` sessions: a terminal the relay itself holds, an SSH shell on a host (through its webmosh-gate) or, for
// a local target, a shell on this machine. Unlike mosh, the relay sees this session's plaintext; in return it gets
// what mosh cannot carry (sixel and other images, scrollback) and outlives its page: a reload reattaches to it.
//
// The page talks to it over a reliable data channel: binary messages are terminal bytes both ways; the relay's text
// messages are control ("reset": what follows is the replay, "live": the replay is over, "exit": the shell ended).
// Output is kept in a ring, so a
// page that (re)attaches gets the recent output again, and then a resize nudge makes full-screen programs (tmux, vim)
// redraw the whole screen.

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/crypto/ssh"
)

const ringMax = 256 << 10

type ptySession struct {
	mu         sync.Mutex
	ring       []byte
	link       link // the attached page (attach), under mu
	cols, rows int
	stdin      io.Writer
	setSize    func(cols, rows int) error
	stop       func()
	done       chan struct{}
}

// startPTY: an SSH shell on t through its gate, or a local login shell for a local target.
func startPTY(t *Target, cfg *Config, cols, rows int) (*ptySession, error) {
	if cols < 10 || rows < 3 {
		cols, rows = 80, 24
	}
	p := &ptySession{cols: cols, rows: rows, done: make(chan struct{})}
	locale := t.Locale
	if locale == "" {
		locale = "en_US.UTF-8"
	}
	if t.Local {
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/bash"
		}
		cmd := exec.Command(shell, "-l")
		cmd.Env = append(os.Environ(), "TERM=xterm-256color", "LANG="+locale)
		for k, v := range t.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		if home, err := os.UserHomeDir(); err == nil {
			cmd.Dir = home
		}
		f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
		if err != nil {
			return nil, err
		}
		p.stdin = f
		p.setSize = func(c, r int) error { return pty.Setsize(f, &pty.Winsize{Cols: uint16(c), Rows: uint16(r)}) }
		p.stop = func() { cmd.Process.Signal(syscall.SIGHUP); f.Close() }
		go p.pump(f, func() { cmd.Wait() })
		return p, nil
	}
	if !t.gated {
		return nil, fmt.Errorf(L("%s takes mosh only (its key may only start mosh-server)", "%s 只能 mosh（它的密钥只许启动 mosh-server）"), t.Name)
	}
	client, err := dialTarget(t, cfg)
	if err != nil {
		return nil, explainSSH(err)
	}
	sess, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, err
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 38400, ssh.TTY_OP_OSPEED: 38400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		client.Close()
		return nil, err
	}
	in, err := sess.StdinPipe()
	if err != nil {
		client.Close()
		return nil, err
	}
	out, err := sess.StdoutPipe()
	if err != nil {
		client.Close()
		return nil, err
	}
	if err := sess.Shell(); err != nil {
		client.Close()
		return nil, err
	}
	p.stdin = in
	p.setSize = func(c, r int) error { return sess.WindowChange(r, c) }
	p.stop = func() { sess.Close(); client.Close() }
	// keepalives: a host that went away (sleep, network) ends the session instead of hanging it
	go func() {
		for {
			select {
			case <-p.done:
				return
			case <-time.After(30 * time.Second):
				if _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
					client.Close()
					return
				}
			}
		}
	}()
	go p.pump(out, func() { sess.Wait(); client.Close() })
	return p, nil
}

func (p *ptySession) pump(r io.Reader, wait func()) {
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			b := buf[:n]
			p.mu.Lock()
			p.ring = append(p.ring, b...)
			if len(p.ring) > ringMax {
				p.ring = append([]byte(nil), p.ring[len(p.ring)-ringMax:]...)
			}
			if l := p.link; l != nil && l.Open() {
				if l.Buffered() > 8<<20 {
					// the page stopped reading (a frozen tab): let it reattach and get the replay instead
					p.link = nil
					go l.Close()
				} else {
					sendChunks(l, b)
				}
			}
			p.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	wait()
	close(p.done)
}

// attach: the page's link is open. "reset", the ring's recent output, "live", then live output; a resize nudge makes
// full-screen programs redraw. The page drops the terminal's answers to queries in the replay. Sent under the pty's
// lock, so nothing is lost or doubled between the replay and the live output.
func (p *ptySession) attach(l link) {
	p.mu.Lock()
	l.SendText("reset")
	replay := p.ring
	if len(replay) >= ringMax {
		if i := bytes.IndexByte(replay, '\n'); i >= 0 {
			replay = replay[i+1:]
		}
	}
	sendChunks(l, replay)
	l.SendText("live")
	p.link = l
	p.mu.Unlock()
	p.nudge()
}

func (p *ptySession) detach(l link) {
	p.mu.Lock()
	if p.link == l {
		p.link = nil
	}
	p.mu.Unlock()
}

// ptyExited: tell the attached page before the session goes
func (s *Session) ptyExited() {
	p := s.pty
	p.mu.Lock()
	if p.link != nil && p.link.Open() {
		p.link.SendText("exit")
	}
	p.mu.Unlock()
}

// sendChunks: SCTP messages stay well under the 64 KB browsers accept
func sendChunks(l link, b []byte) error {
	for len(b) > 0 {
		n := min(len(b), 16<<10)
		if err := l.Send(b[:n]); err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

func (p *ptySession) write(b []byte) {
	if _, err := p.stdin.Write(b); err != nil && debug {
		log.Printf("pty write: %v", err)
	}
}

func (p *ptySession) resize(cols, rows int) {
	if cols < 10 || rows < 3 {
		return
	}
	p.mu.Lock()
	p.cols, p.rows = cols, rows
	p.mu.Unlock()
	p.setSize(cols, rows)
}

// nudge: one row less and back, so full-screen programs repaint everything (SIGWINCH twice).
func (p *ptySession) nudge() {
	p.mu.Lock()
	c, r := p.cols, p.rows
	p.mu.Unlock()
	p.setSize(c, r-1)
	time.AfterFunc(80*time.Millisecond, func() { p.setSize(c, r) })
}

func (p *ptySession) close() {
	select {
	case <-p.done:
	default:
		p.stop()
	}
}

func (p *ptySession) ended() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}
