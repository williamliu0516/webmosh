package main

// Photos and files from the page (web/src/upload.mjs: Cmd+Shift+I, Cmd+V with a picture, a drop) to the computer a
// session is connected to, kept in ~/Downloads/webmosh/ there; the reply is the file's path, which the page pastes at
// the cursor. A tailnet host gets it through its webmosh-gate (`webmosh-put <name>`, the file on stdin); a local
// target (the relay's own computer) is written here. Config targets whose key only starts mosh-server cannot take files.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const uploadMax = 50 << 20

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// uploadName: a timestamp and the page's file name, cut down to what the gate accepts ([A-Za-z0-9._-], no leading
// dot, no spaces, so the pasted path needs no quoting). A clipboard picture is just "image.png", hence the time.
func uploadName(name string, now time.Time) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	ext := strings.ToLower(filepath.Ext(name))
	base := strings.TrimSuffix(name, filepath.Ext(name))
	base = strings.Trim(unsafeName.ReplaceAllString(base, "-"), "-.")
	ext = unsafeName.ReplaceAllString(ext, "")
	if len(ext) > 10 || ext == "." {
		ext = ""
	}
	if len(base) > 60 {
		base = base[:60]
	}
	if base == "" {
		base = "file"
	}
	return now.Format("20060102-150405") + "-" + base + ext
}

func (r *Relay) serveUpload(w http.ResponseWriter, req *http.Request) {
	reply := func(code int, v map[string]string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(v)
	}
	if req.Method != http.MethodPost || !r.allowed(req) {
		reply(http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if o := req.Header.Get("Origin"); r.cfg.Origin != "" && o != r.cfg.Origin && !(o == "" && req.Header.Get("Sec-Fetch-Site") == "same-origin") {
		reply(http.StatusForbidden, map[string]string{"error": "forbidden origin"})
		return
	}
	s := r.get(req.URL.Query().Get("session"))
	if s == nil || s.target == nil {
		reply(http.StatusNotFound, map[string]string{"error": L("this tab's session is gone", "这个标签的会话已经不在了")})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, uploadMax))
	if err != nil {
		reply(http.StatusRequestEntityTooLarge, map[string]string{"error": L("the file is over 50 MB", "文件超过 50 MB")})
		return
	}
	name := uploadName(req.URL.Query().Get("name"), time.Now())
	t := s.target
	var path string
	switch {
	case t.Local:
		path, err = putLocal(name, body)
	case t.gated:
		path, err = putGated(t, r.cfg, name, body)
	default:
		err = fmt.Errorf(L("%s's key may only start mosh-server, so it cannot take files", "%s 的密钥只许启动 mosh-server，传不了文件"), t.Name)
	}
	if err != nil {
		log.Printf("session %s: upload %s (%d bytes) to %s: %v", s.id, name, len(body), t.ID, err)
		reply(http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("session %s: upload %s (%d bytes) to %s: %s", s.id, name, len(body), t.ID, path)
	reply(http.StatusOK, map[string]string{"path": path})
}

// putLocal: into this machine's ~/Downloads/webmosh, never over an existing file.
func putLocal(name string, body []byte) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "Downloads", "webmosh")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 0; i < 100; i++ {
		p := filepath.Join(dir, name)
		if i > 0 {
			p = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i, ext))
		}
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		_, err = f.Write(body)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(p)
			return "", err
		}
		return p, nil
	}
	return "", errors.New("too many files with that name")
}

// putGated: through the host's webmosh-gate, which writes the file and prints its path.
func putGated(t *Target, cfg *Config, name string, body []byte) (string, error) {
	client, err := dialTarget(t, cfg)
	if err != nil {
		return "", explainSSH(err)
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	var out, errOut bytes.Buffer
	sess.Stdin = bytes.NewReader(body)
	sess.Stdout = &out
	sess.Stderr = &errOut
	if err := sess.Run("webmosh-put " + name); err != nil {
		msg := strings.TrimSpace(errOut.String())
		if strings.Contains(msg, "not allowed") {
			return "", fmt.Errorf(L("webmosh-gate on %s is too old to take files: press Set up again on the hosts page and run that line on the computer again",
				"%s 上的 webmosh-gate 是旧版，还不会收文件：在终端主机页点「重新设置」，在那台电脑上再跑一次那行命令"), t.Name)
		}
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(msg)
	}
	path := strings.TrimSpace(out.String())
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\n\r") {
		return "", fmt.Errorf("webmosh-put: unexpected reply %q", path)
	}
	return path, nil
}
