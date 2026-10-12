// webmosh: a mosh client session around one instance of the WASM module (web/dist/webmosh.mjs).
//
// The module is mosh-client's core with the sockets taken out. This class is the event loop
// mosh-client's select() used to be: it calls into the module on every event (a datagram, input,
// a resize, the timer the module asked for) and after each call hands the module's output to the
// page: screen bytes for xterm.js, encrypted datagrams for the relay.
//
// One session per module instance (the module keeps its state in globals), so create the module
// with createWebMosh() per session.

const DONE = 4 | 8 | 16; // wm_status: our shutdown acked, ack timed out, server ended the session

export class MoshClient {
  /**
   * @param {object} M         an instance from createWebMosh()
   * @param {object} opts
   * @param {string} opts.key  the 22-char key from "MOSH CONNECT <port> <key>"
   * @param {string} [opts.port]  only shown in mosh's messages
   * @param {number} opts.cols
   * @param {number} opts.rows
   * @param {string} [opts.predict]  adaptive (default) | always | never | experimental
   * @param {(bytes: Uint8Array) => void} opts.onScreen     UTF-8 terminal output for xterm.js
   * @param {(datagram: Uint8Array) => void} opts.onDatagram  encrypted datagram for the relay
   * @param {(reason: string) => void} [opts.onClose]
   */
  constructor(M, opts) {
    this.M = M;
    this.opts = opts;
    this.timer = null;
    this.closed = false;
    this.encoder = new TextEncoder();
  }

  start() {
    const { M } = this;
    const { key, port = '', cols, rows, predict = 'adaptive' } = this.opts;
    const k = M.stringToNewUTF8(key);
    const p = M.stringToNewUTF8(String(port));
    const m = M.stringToNewUTF8(predict);
    let rc;
    try {
      rc = M._wm_start(k, p, cols, rows, m);
    } finally {
      M._free(k); M._free(p); M._free(m);
    }
    if (rc !== 0) throw new Error('wm_start: ' + M.UTF8ToString(M._wm_error()));
    this.after(M._wm_tick());
  }

  /** One encrypted datagram from the relay. */
  datagram(bytes) {
    if (this.closed) return;
    this.withBytes(bytes, (ptr, len) => this.M._wm_datagram(ptr, len));
  }

  /** Keystrokes or pasted text (a string from xterm.js onData, or bytes). */
  input(data) {
    if (this.closed) return;
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    this.withBytes(bytes, (ptr, len) => this.M._wm_input(ptr, len));
  }

  resize(cols, rows) {
    if (this.closed) return;
    this.after(this.M._wm_resize(cols, rows));
  }

  /** A new link to the relay is open: let the server hear from us now (wm_poke), not at the next heartbeat. */
  opened() {
    if (this.closed) return;
    this.after(this.M._wm_poke());
  }

  /** The terminal lost its contents (reset, page restored): redraw everything. */
  repaint() {
    if (this.closed) return;
    this.after(this.M._wm_repaint());
  }

  /** Ask the server to end the session. onClose fires when it acknowledges (or times out). */
  shutdown() {
    if (this.closed) return;
    this.after(this.M._wm_shutdown());
  }

  /** Bit 0 connected, 1 shutting down, 2 shutdown acked, 3 ack timed out, 4 server ended. */
  status() { return this.M._wm_status(); }

  /** ms since the last datagram from the server. */
  sinceHeard() { return this.M._wm_since_heard(); }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.opts.onClose?.(reason);
  }

  withBytes(bytes, fn) {
    const { M } = this;
    const len = bytes.length;
    const ptr = M._malloc(len || 1);
    M.HEAPU8.set(bytes, ptr);
    let wait;
    try {
      wait = fn(ptr, len);
    } finally {
      M._free(ptr);
    }
    this.after(wait);
  }

  // The end of every call: hand out what the module produced, then sleep as long as it asked.
  after(wait) {
    const { M } = this;
    let n = M._wm_take_screen();
    if (n > 0) {
      const p = M._wm_scratch();
      this.opts.onScreen(M.HEAPU8.slice(p, p + n));
    }
    while ((n = M._wm_take_datagram()) > 0) {
      const p = M._wm_scratch();
      this.opts.onDatagram(M.HEAPU8.slice(p, p + n));
    }
    if (wait < 0) {
      this.close('error: ' + M.UTF8ToString(M._wm_error()));
      return;
    }
    if (M._wm_status() & DONE) {
      this.close('ended');
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.after(M._wm_tick());
    }, wait);
  }
}
