package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

var (
	moshConnect = regexp.MustCompile(`MOSH CONNECT (\d+) ([A-Za-z0-9/+]{22})`)
	moshPID     = regexp.MustCompile(`mosh-server detached, pid = (\d+)`)
)

type moshServer struct {
	ip   net.IP
	port int
	key  string
	pid  int // on the target's computer (0 if it never said): the session's own mosh-server, which the relay ends
}

// startMoshServer runs "mosh-server new" on the target, the way the mosh wrapper script does over
// SSH, and returns where its UDP socket is and the session key. mosh-server detaches right after
// printing MOSH CONNECT, so the SSH connection is closed as soon as that line is read.
//
// -s binds mosh-server to the address this SSH connection reached, which is also where the relay
// sends its datagrams. A target's authorized_keys may force the command; the forced one wins.
func startMoshServer(t *Target, cfg *Config) (*moshServer, error) {
	serverPath := t.MoshServer
	if serverPath == "" {
		serverPath = "mosh-server"
	}
	locale := t.Locale
	if locale == "" {
		locale = "en_US.UTF-8"
	}
	if t.Local {
		// mosh-server forks, prints MOSH CONNECT on stdout and its pid on stderr, and its daemon
		// half points both at /dev/null, so the combined output ends when the parent exits.
		args := append([]string{"new", "-i", "127.0.0.1", "-c", "256", "-l", "LANG=" + locale}, t.Args...)
		cmd := exec.Command(serverPath, args...)
		cmd.Env = os.Environ()
		for k, v := range t.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		if home, err := os.UserHomeDir(); err == nil {
			cmd.Dir = home // the shell starts where a login would
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("mosh-server: %w: %s", err, strings.TrimSpace(string(out)))
		}
		port, key, err := parseConnect(strings.NewReader(string(out)))
		if err != nil {
			return nil, err
		}
		ms := &moshServer{ip: net.IPv4(127, 0, 0, 1), port: port, key: key}
		if m := moshPID.FindStringSubmatch(string(out)); m != nil {
			ms.pid, _ = strconv.Atoi(m[1])
		}
		return ms, nil
	}

	client, err := dialTarget(t, cfg)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	defer sess.Close()
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	sess.Stderr = &stderr
	command := shellJoin(append([]string{serverPath, "new", "-s", "-c", "256", "-l", "LANG=" + locale}, t.Args...))
	if err := sess.Start(command); err != nil {
		return nil, err
	}

	type result struct {
		port int
		key  string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		p, k, err := parseConnect(stdout)
		done <- result{p, k, err}
	}()
	var res result
	select {
	case res = <-done:
	case <-time.After(10 * time.Second):
		res.err = fmt.Errorf("no MOSH CONNECT within 10 s")
	}
	if res.err != nil {
		return nil, res.err
	}
	host, _, _ := net.SplitHostPort(client.RemoteAddr().String())
	ip := net.ParseIP(host)
	if ip == nil {
		return nil, fmt.Errorf("remote address %q", host)
	}
	ms := &moshServer{ip: ip, port: res.port, key: res.key}
	// The parent prints the daemon's pid on stderr and exits right after MOSH CONNECT. Ending the session later by
	// that pid, not just its port, leaves alone a newer mosh-server that has been given the same port (endRemote).
	waited := make(chan error, 1)
	go func() { waited <- sess.Wait() }()
	select {
	case <-waited:
		if m := moshPID.FindStringSubmatch(stderr.String()); m != nil {
			ms.pid, _ = strconv.Atoi(m[1])
		}
	case <-time.After(3 * time.Second):
	}
	return ms, nil
}

func dialTarget(t *Target, cfg *Config) (*ssh.Client, error) {
	keyPEM, err := os.ReadFile(cfg.SSHKey)
	if err != nil {
		return nil, err
	}
	signer, err := ssh.ParsePrivateKey(keyPEM)
	if err != nil {
		return nil, err
	}
	addr := t.Host
	if _, _, err := net.SplitHostPort(addr); err != nil {
		addr = net.JoinHostPort(addr, "22")
	}
	cc := &ssh.ClientConfig{User: t.User, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, Timeout: 8 * time.Second}
	if t.hostKey != nil { // a tailnet host: the key its setup reported
		cc.HostKeyCallback = ssh.FixedHostKey(t.hostKey)
		cc.HostKeyAlgorithms = algorithmsFor(t.hostKey.Type())
	} else {
		hostKeys, err := knownhosts.New(cfg.KnownHosts)
		if err != nil {
			return nil, err
		}
		cc.HostKeyCallback = hostKeys
		cc.HostKeyAlgorithms = knownKeyAlgorithms(cfg.KnownHosts, addr)
	}
	return ssh.Dial("tcp", addr, cc)
}

func algorithmsFor(keyType string) []string {
	if keyType == ssh.KeyAlgoRSA {
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA}
	}
	return []string{keyType}
}

// endRemote asks the target's webmosh-gate to end the mosh-server listening on port at the address the
// relay connects to (setup/webmosh-gate), and only if it is pid when the relay knows it: a session kept after its
// mosh-server had gone names a port a newer one may have been given since. Only for targets with end_via_ssh:
// under a key whose forced command is mosh-server itself, any SSH command would start one more mosh-server instead.
func endRemote(t *Target, cfg *Config, port, pid int) (string, error) {
	client, err := dialTarget(t, cfg)
	if err != nil {
		return "", err
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	command := fmt.Sprintf("webmosh-end %d", port)
	if pid > 0 {
		command += fmt.Sprintf(" %d", pid)
	}
	out, err := sess.CombinedOutput(command)
	if err != nil && strings.Contains(string(out), "bad port") {
		out = append(out, " (a webmosh-gate from before pids: run the computer's setup line again)"...)
	}
	return strings.TrimSpace(string(out)), err
}

// knownKeyAlgorithms lists the host key algorithms for the key types known_hosts has for addr.
// Without it the client asks for its default first choice (ECDSA), and a host pinned by its
// ed25519 key fails with "key mismatch".
func knownKeyAlgorithms(path, addr string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	want := knownhosts.Normalize(addr)
	var algos []string
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || strings.HasPrefix(f[0], "#") {
			continue
		}
		match := false
		for _, h := range strings.Split(f[0], ",") {
			if knownhosts.Normalize(h) == want {
				match = true
			}
		}
		if !match {
			continue
		}
		algos = append(algos, algorithmsFor(f[1])...)
	}
	return algos
}

func parseConnect(r io.Reader) (int, string, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		if m := moshConnect.FindStringSubmatch(sc.Text()); m != nil {
			port, _ := strconv.Atoi(m[1])
			return port, m[2], nil
		}
	}
	return 0, "", fmt.Errorf("mosh-server printed no MOSH CONNECT line")
}

// shellJoin quotes for the remote shell (sshd runs the command through the user's shell).
func shellJoin(args []string) string {
	q := make([]string, len(args))
	for i, a := range args {
		if a != "" && strings.Trim(a, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./=:,+@") == "" {
			q[i] = a
		} else {
			q[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
	}
	return strings.Join(q, " ")
}
