// The page's end of an `ssh <host>` session. The relay holds the terminal (relay/pty.go) and talks over a reliable
// data channel: binary messages are terminal bytes, its text messages are control ("reset": the replay of recent output
// follows, "live": the replay is over, "exit": the shell ended). This class has MoshClient's interface (client.mjs), so tabs, switching and a reload
// treat both kinds alike, and it keeps the recent output, to redraw its tab after a switch (the terminal is shared).

const RING = 256 << 10;

export class PtyClient {
  /**
   * @param {object} opts
   * @param {(bytes: Uint8Array, replay?: boolean) => void} opts.onScreen   output for xterm.js (the page writes it only
   *   while the tab shows); replay: output drawn a second time (the relay's replay, or this tab's redraw after a switch)
   * @param {() => void} opts.onReset                     the relay's replay follows: the terminal should be cleared
   * @param {(bytes: Uint8Array) => boolean} opts.send    to the data channel; false while it is not open
   * @param {(m: object) => void} opts.control            resize and nudge, over the WebSocket
   * @param {(reason: string) => void} [opts.onClose]
   */
  constructor(opts) {
    this.opts = opts;
    this.closed = false;
    this.chunks = [];
    this.size = 0;
    this.pending = []; // input typed while the data channel was down (reattaching), sent once it is back
    this.replaying = false; // between the relay's "reset" and "live"
    this.replayTimer = 0;
    this.encoder = new TextEncoder();
  }

  start() {}

  /** From the data channel: a string is control, bytes are output. */
  datagram(d) {
    if (this.closed) return;
    if (typeof d === 'string') {
      if (d === 'reset') {
        this.chunks = [];
        this.size = 0;
        this.opts.onReset();
        this.replaying = true;
        clearTimeout(this.replayTimer); // a relay that never says "live" (older than the page) still ends it
        this.replayTimer = setTimeout(() => { this.replaying = false; }, 3000);
      } else if (d === 'live') {
        this.replaying = false;
        clearTimeout(this.replayTimer);
      } else if (d === 'exit') {
        this.close('ended');
      }
      return;
    }
    this.chunks.push(d);
    this.size += d.length;
    while (this.size > RING && this.chunks.length > 1) this.size -= this.chunks.shift().length;
    this.opts.onScreen(d, this.replaying);
  }

  input(data) {
    if (this.closed) return;
    const b = typeof data === 'string' ? this.encoder.encode(data) : data;
    if (!this.pending.length && this.opts.send(b)) return;
    if (this.pending.reduce((n, x) => n + x.length, 0) < 64 << 10) this.pending.push(b);
  }

  /** The data channel is open (again). */
  opened() {
    while (this.pending.length && this.opts.send(this.pending[0])) this.pending.shift();
  }

  resize(cols, rows) {
    if (!this.closed) this.opts.control({ t: 'resize', cols, rows });
  }

  /** The tab is on screen again: its recent output from a line start, then a nudge so full-screen programs redraw. */
  repaint() {
    if (this.closed) return;
    let first = true;
    for (const c of this.chunks) {
      let b = c;
      if (first && this.size >= RING) {
        const i = b.indexOf(10);
        b = i >= 0 ? b.subarray(i + 1) : b;
      }
      first = false;
      this.opts.onScreen(b, true);
    }
    this.opts.control({ t: 'nudge' });
  }

  /** Closing the tab: the relay ends the shell when the page releases the session. */
  shutdown() { this.close('ended'); }

  status() { return 1; }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.opts.onClose?.(reason);
  }
}
