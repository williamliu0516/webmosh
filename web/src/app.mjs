// The webmosh page: xterm.js on top, mosh-client's core (WASM) in the middle, and a WebRTC data
// channel to the relay underneath, which carries mosh's encrypted datagrams to mosh-server.
//
// Signaling and session setup go over a WebSocket to the relay. The session (mosh-server plus the
// relay's UDP socket) outlives the data channel: when iPadOS freezes the tab, the channel dies; on
// return the page attaches a new one and mosh resyncs the screen as if the client had roamed.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import { MoshClient } from './client.mjs';
import { PtyClient } from './ptyclient.mjs';
import { CHARS, encode } from './keys.mjs';
import { createPrompt } from './prompt.mjs';
import { fontSizeControls, showBadge } from './fontsize.mjs';
import { createTabBar, pageShortcut } from './tabs.mjs';
import { createKeyRow } from './keyrow.mjs';
import { APPLE, TOUCH, PHONE } from './platform.mjs';
import { createUploader, prepare } from './upload.mjs';
import { createHostsPage } from './hosts.mjs';
import { DEFAULT_THEME } from './theme.mjs';
import { L, setLang } from './i18n.mjs';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// The WebGL renderer caches glyphs as it first draws them, so have the font before opening the
// terminal (give up after 3 s and use the fallback). "webmosh-mono" is the deployment's, from its custom.css.
// Meanwhile the deployment's language and look: the relay's site.json (its config's "lang" and "page").
const FONT = '"webmosh-mono", ui-monospace, Menlo, monospace';
const [site] = await Promise.all([
  fetch('site.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  Promise.race([
    Promise.all(['15px', 'bold 15px'].map((f) => document.fonts.load(`${f} "webmosh-mono"`))),
    new Promise((r) => setTimeout(r, 3000)),
  ]).catch(() => {}),
]);
setLang(site.lang);
const theme = { ...DEFAULT_THEME, ...site.theme };
// Keyboard and pointer diagnostics to the relay's journal (see the block near the end): only where the deployment
// turns them on (page.diagnostics) or the page is opened with ?keylog.
const DIAG = site.diagnostics === true || params.has('keylog');
// the page's own colors follow the theme's (without a transparent background's alpha)
const opaque = (c) => (/^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) : c);
document.documentElement.style.setProperty('--bg', opaque(theme.background));
document.documentElement.style.setProperty('--fg', opaque(theme.foreground));

// html.embedded (inside a panel's overlay) or html.standalone, for styles that differ between the two
document.documentElement.classList.add(window.parent !== window ? 'embedded' : 'standalone');

const term = new Terminal({
  fontFamily: FONT,
  fontSize: 15,
  scrollback: 0, // mosh syncs the screen only; scroll in tmux
  macOptionIsMeta: true,
  allowProposedApi: true,
  ...site.terminal, // the deployment's xterm.js options
  theme,
});
// for tests and the console: window.webmosh.term / .session (the active tab's) / .tabs / .sent (with ?keylog)
window.webmosh = { term, get session() { return active?.session ?? null; }, get tabs() { return tabs; }, sent: null };
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';
// Images (sixel and iTerm2's inline images), for ssh tabs: yazi's previews, chafa/img2sixel, timg. mosh drops them on
// the way (its terminal keeps no images), so mosh tabs never get any. The addon also answers DA1 with sixel support (4)
// and turns on the cell and window size reports (CSI 14/16/18 t), which yazi uses to size a preview. Inside tmux images
// pass through only with allow-passthrough on (the dotfiles' tmux.conf has it). Its image store stays small for the iPad.
const images = new ImageAddon({ storageLimit: 32 });
term.loadAddon(images);
window.webmosh.images = images;
term.open($('#term'));
// The WebGL renderer, unless ?renderer=dom. It draws box drawing (tmux's pane borders, rules) as rectangles that fill
// whole cells, so a border is one straight line. The DOM renderer lays each row out as text and corrects the widths with
// letter-spacing, which comes out a little different on each row (CJK, bold): a border jagged by a device pixel or two
// from row to row, and with a lineHeight over 1 its │ left a gap between rows (2026-10-11). The DOM renderer was the
// default for a while because headless Chrome drew a blank WebGL screen (2026-10-08); headless Chrome and Firefox draw
// WebGL wrong, but real browsers and Playwright's WebKit draw it right, icons and all. If the context is lost for good,
// the DOM renderer takes over, and WebGL is tried again the next time the page is shown.
let webgl = null;     // the WebglAddon while it draws
let webglLost = false;
Object.defineProperty(window.webmosh, 'renderer', { get: () => (webgl ? 'webgl' : 'dom') });
// xterm 5.5's WebGL renderer keeps a cell's dim, italic and extended-attribute flags in its background value and draws
// an opaque rectangle for any background value but 0, in the theme's background at full alpha: with a transparent theme
// (a picture behind the terminal) dim and italic text sat in dark boxes. So the rectangles are drawn from a copy of the
// render model whose backgrounds keep only their colour (mode and RGB). Still so in addon-webgl 0.20 beta.
const BG_COLOR = 0x3ffffff;
function keepBackgroundsClear(gl) {
  const proto = Object.getPrototypeOf(gl._renderer?._rectangleRenderer?.value ?? {});
  if (!proto.updateBackgrounds) { console.warn('webgl: no background renderer to patch, dim text may sit in boxes'); return; }
  if (proto.updateBackgrounds.clearBackgrounds) return;
  const update = proto.updateBackgrounds;
  let cells = new Uint32Array(0);
  proto.updateBackgrounds = function (model) {
    if (cells.length !== model.cells.length) cells = new Uint32Array(model.cells.length);
    cells.set(model.cells);
    for (let i = 1; i < cells.length; i += 4) cells[i] &= BG_COLOR; // 4 values a cell, the background second
    return update.call(this, { ...model, cells });
  };
  proto.updateBackgrounds.clearBackgrounds = true;
}
function startWebgl() {
  webglLost = false;
  try {
    const gl = new WebglAddon();
    term.loadAddon(gl);
    keepBackgroundsClear(gl);
    gl.onContextLoss(() => {
      life('webgl context lost, the DOM renderer until the page is shown again');
      gl.dispose();
      webgl = null;
      webglLost = true;
      term.refresh(0, term.rows - 1);
    });
    webgl = gl;
  } catch (e) {
    console.warn('webgl unavailable:', e.message);
  }
}
if (params.get('renderer') !== 'dom') startWebgl();
fit.fit();
// Inside a panel the terminal takes the focus only while the panel shows it (webmosh:focus, webmosh:hide). Chrome and
// WebKit let a hidden iframe focus itself (a tab reconnecting after a relay restart), and the panel's keys then went
// into the shell unseen.
let shown = true;
let hostsPage = null; // the hosts page over the terminal (hosts.mjs) keeps the focus while it is open
const focusTerm = () => { if (shown && !hostsPage?.isOpen) term.focus(); };
const fontSize = fontSizeControls({ term, fit }); // Cmd = / Cmd - / Cmd 0 (fontsize.mjs)
window.webmosh.fontSize = fontSize;

// The on-screen keyboard, and iPadOS's keyboard bar: with the terminal's input focused a touch screen shows its keyboard,
// or with the iPad's Magic Keyboard a bar (A, up, down, mic) over the bottom of the screen. inputmode="none" asks for no
// keyboard UI at all, which takes the bar with it; keys and Pinyin still work (the input keeps the focus). On by default,
// so a phone can type; the relay's page.keyboard "off" turns it off (the user's iPad, which has a keyboard, 2026-10-08),
// but not on a phone: one sharing that relay showed no keyboard on a tap and the corner button went unseen (2026-10-10).
// Cmd+Shift+K, or on a touch screen the keyboard button (keyrow.mjs), turns it on and off, remembered on the device.
// WebKit reloads the keyboard UI when a focused input's inputmode changes, so the switch applies at once.
//
// Without keyboard UI iPadOS does not switch input sources either (2026-10-08: Ctrl+Space, Caps Lock and Globe all did
// nothing with the bar off, all worked with it on), and Ctrl+Space then reaches the page instead. The user wants one
// press to switch (a first try that opened the bar for a second press was rejected). So Ctrl+Space turns the keyboard
// UI on right in its keydown and is NOT marked handled: WebKit hands an unhandled key back to iPadOS after the page, and
// the inputmode change goes out before that, so iPadOS finds keyboard UI when it gets the key, and switches on that
// same press (confirmed on the iPad, 2026-10-08). The bar then goes away 1.5 s after the last key (never in the middle
// of a Pinyin composition). The remote never gets Ctrl+Space (^@); on the user's Mac it switches input sources too.
// The Globe key cannot do this: with the bar off iPadOS never hands it to the page.
const KBBAR_KEY = 'webmosh.keyboardBar';
let kbBar = PHONE || site.keyboard !== 'off';
try { const v = localStorage.getItem(KBBAR_KEY); if (v) kbBar = v === 'on'; } catch { /* storage off */ }
let kbTemp = false;      // open only for an input source switch
let kbTimer = 0;
let composing = false;
function setKeyboardUI(on) {
  if (on) term.textarea?.removeAttribute('inputmode');
  else term.textarea?.setAttribute('inputmode', 'none');
}
setKeyboardUI(kbBar);
function toggleKbBar() {
  kbBar = !kbBar;
  try { localStorage.setItem(KBBAR_KEY, kbBar ? 'on' : 'off'); } catch { /* storage off */ }
  kbTemp = false;
  clearTimeout(kbTimer);
  setKeyboardUI(kbBar);
  keyRow?.show(kbBar);
  fit.fit(); // the row takes the bottom rows
  if (!TOUCH) showBadge(kbBar ? L('Keyboard bar on', '键盘栏开') : L('Keyboard bar off', '键盘栏关'));
}
// a touch screen: the keys its keyboard lacks under the terminal, or a button to bring the keyboard back (keyrow.mjs)
// Bringing the keyboard back: the input loses the focus and gets it again inside the tap, since iOS raises the
// keyboard only for a focus a tap gave (the page focuses the terminal at load too, without one).
const keyRow = TOUCH ? createKeyRow({ term, send: (d) => input(d), onToggle: () => { toggleKbBar(); if (kbBar) { term.blur(); focusTerm(); } },
  onPick: () => pageAction({ t: 'pick' }) }) : null;
keyRow?.show(kbBar);
fit.fit();
function openForSwitch() {
  if (kbBar) return; // the bar is on: iPadOS takes Ctrl+Space itself
  kbTemp = true;
  setKeyboardUI(true);
  closeForSwitchLater();
}
function closeForSwitchLater() {
  clearTimeout(kbTimer);
  kbTimer = setTimeout(() => {
    if (!kbTemp || kbBar) return;
    if (composing) { closeForSwitchLater(); return; }
    kbTemp = false;
    setKeyboardUI(false);
  }, 1500);
}
term.textarea?.addEventListener('compositionstart', () => { composing = true; }, true);
term.textarea?.addEventListener('compositionend', () => { composing = false; }, true);
term.textarea?.addEventListener('keydown', () => { if (kbTemp) closeForSwitchLater(); }, true);
window.webmosh.toggleKbBar = toggleKbBar;
window.webmosh.keyboardUI = () => term.textarea?.getAttribute('inputmode') !== 'none';

// ---- tabs ------------------------------------------------------------------------------------

// Each tab is the page's prompt or one mosh session (tabs.mjs). They share the terminal: only the
// active tab draws; the others keep running, and a switch redraws from the tab's own state.
/** @typedef {{id: string, kind: 'mosh' | 'ssh', target: string, client: MoshClient | PtyClient, ice: RTCIceServer[], tab: Tab, pc?: RTCPeerConnection, dc?: RTCDataChannel, attaching?: boolean, attachWs?: WebSocket, attachRef?: string, openedAt?: number, closing?: boolean, released?: boolean}} Session */
/** @typedef {{n: number, label: string, title: string, target: string, kind: 'mosh' | 'ssh', tmux: string, reattach?: string, resume?: string, restore?: {target: string, label: string, tmux: string, kind?: string, id?: string} | null, session: Session | null, opening: boolean, closed?: boolean, prompt: ReturnType<typeof createPrompt>}} Tab */
/** @type {Tab[]} */
const tabs = [];
/** @type {Tab | null} */
let active = null;
let tabSeq = 0;
let ws = null;
let targets = [];            // hosts from the relay's hello: [{ id, name, aliases }]
const keytest = params.has('keytest'); // ?keytest: keys go to the test (keytest.mjs), not a shell or the prompt
let autoTarget = params.get('target') || ''; // ?target=: open it at once (tests, links) instead of the prompt
const sessions = () => tabs.map((t) => t.session).filter(Boolean);

// There is no status bar. Between sessions a tab shows the page's own prompt (prompt.mjs); during a
// session mosh draws its own "Last contact" notice when the network is gone.

const bar = createTabBar({ onSelect: (t) => activate(t), onClose: (t) => closeTab(t), onNew: () => newTab() });
function renderBar() {
  bar.render(tabs, active);
  fit.fit(); // the bar takes a row or two from the terminal (every session gets the new size)
  saveTabs();
}

// ---- tabs survive a reload ---------------------------------------------------------------------

// A reload (the Kiosk app swiped away, the panel reloading after a deploy) loses the page's mosh clients; a new client
// cannot take over a live mosh session, as starting again under the same key would reuse its nonces. So the page keeps
// each tab's host and tmux session (from tmux's title, set-titles-string '#S · #W') in localStorage. On load it opens
// the same tabs again, a new session to each host, and types `tmux attach` to that tmux session. What ran outside tmux
// is gone, as before. The old sessions are not closed from here: another page of this origin (a second Safari tab)
// may still be using them; pagehide closes them, and the relay drops any left over after its detached_ttl.
//
// The relay keeps a copy per device (relay/devices.go): the iPad Kiosk app comes back from being swiped away with its
// localStorage empty (2026-10-10: a board reload restored the tab, a relaunch restored nothing and the user typed
// `mosh <host>` and `tmux` again). Each copy carries when its tabs last changed (at); on the first hello the page takes
// the relay's when it is the newer one and nothing has started here yet.
const TABS_KEY = 'webmosh.tabs';
let restoring = false;
let savedKey = ''; // the tabs as last saved, so only a change is saved (renderBar saves on every fit)
let savedAt = 0;
let helloSeen = false; // the relay's copy is sent only after the first hello, which carries the one to compare with
function saveTabs() {
  if (keytest || restoring) return;
  const list = tabs.map((t) => {
    const r = t.restore;
    // id: the relay session. An ssh tab is resumed by it; a mosh tab is reopened, and its old session is ended
    // (reopenTabs sends 'replaced').
    return r ? { target: r.target, label: r.label, tmux: r.tmux, kind: r.kind, id: r.id }
      : { target: t.target, label: t.label, tmux: t.tmux, kind: t.kind, id: t.session?.id || t.resume || '' };
  });
  const key = JSON.stringify({ tabs: list, active: tabs.indexOf(active) });
  if (key === savedKey) return;
  savedKey = key;
  savedAt = Date.now();
  try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: list, active: tabs.indexOf(active), at: savedAt })); } catch { /* storage off */ }
  syncTabs();
}
function syncTabs() {
  if (helloSeen && savedKey) send({ t: 'tabs', saved: { ...JSON.parse(savedKey), at: savedAt } });
}
// the tmux session in a title "main · zsh" (tmux.conf: set-titles-string '#S · #W'); '' for any other title
const tmuxOf = (title) => /^(\S+) · /.exec(title || '')?.[1] || '';
function localTabs() {
  try { return JSON.parse(localStorage.getItem(TABS_KEY) || 'null'); } catch { return null; } // storage off or bad
}
const startTabs = keytest || autoTarget ? null : localTabs(); // what this page opened with
// The first hello's copy of this device's tabs: taken in place of the page's own when it changed later than those (or
// the page had none), while every tab still only waits to reopen or shows an empty prompt.
function adoptSaved(saved) {
  if (keytest || autoTarget || !saved?.tabs?.length || (saved.at || 0) <= (startTabs?.at || 0)) return;
  if (tabs.some((t) => t.session || t.opening || (!t.restore && t.prompt.line))) return;
  tabs.length = 0;
  active = null;
  restoreTabs(saved);
}
function restoreTabs(saved) {
  if (!saved?.tabs?.length) return false;
  restoring = true;
  for (const v of saved.tabs) {
    const tab = newTab(false);
    if (v.target) {
      tab.restore = { target: v.target, label: v.label || v.target, tmux: v.tmux || '', kind: v.kind || 'mosh', id: v.id || '' };
      tab.label = tab.restore.label;
      tab.kind = tab.restore.kind;
    } else {
      tab.prompt.show();
    }
  }
  restoring = false;
  active = null;
  activate(tabs[Math.min(Math.max(saved.active | 0, 0), tabs.length - 1)]);
  return true;
}
// The host `<kind> <name>` reaches: names are unique per protocol, so the first host in the relay's order that has
// the protocol and answers to the name (the relay resolves it the same way).
function hostFor(name, kind) {
  const has = (x) => (kind === 'ssh' ? x.ssh : x.mosh !== false);
  return targets.find((x) => has(x) && (x.id === name || (x.aliases || []).includes(name)));
}

// the embedding panel asked for a new tab to a host (webmosh:open): once the relay has said which hosts there are.
let pendingOpen = null;
function openPending() {
  const p = pendingOpen;
  if (!p || ws?.readyState !== WebSocket.OPEN || !targets.length) return;
  pendingOpen = null;
  const fresh = active && !active.session && !active.opening && !active.restore;
  const tab = fresh ? active : newTab(false);
  const h = hostFor(p.target, p.kind);
  if (!h) { tab.prompt.show(L(`[no host ${p.target} for ${p.kind}]`, `[没有能 ${p.kind} 的 ${p.target}]`)); return; }
  tab.prompt.hide(); // keys wait for the session instead of editing the prompt line
  open(tab, p.target, p.target, p.kind);
}

// The hosts page (hosts.mjs): the prompt's `setup`, or ?hosts in the address (the relay's ntfy link to a new computer).
// Its ssh and mosh buttons open a tab the way the embedding panel's webmosh:open does.
hostsPage = createHostsPage({
  onOpen: (kind, target) => { pendingOpen = { kind, target }; openPending(); },
  onClose: () => focusTerm(),
});

// After the relay's hello (the host list): open what restoreTabs() set up. The mosh sessions those tabs had before
// the reload are no use to anyone now (no page can take a mosh session over): the relay ends them once the page
// that had them is gone, also the mosh-server behind (through the host's gate, or locally).
function reopenTabs() {
  const replaced = [];
  for (const t of tabs) {
    const r = t.restore;
    if (!r || t.session || t.opening) continue;
    t.restore = null;
    if (r.kind !== 'ssh' && r.id) replaced.push(r.id);
    if (!hostFor(r.target, r.kind)) {
      t.label = 'webmosh';
      t.prompt.show(L(`[${r.label} is no longer a host]`, `[${r.label} 不在主机列表里了]`));
      continue;
    }
    if (r.kind === 'ssh' && r.id) {
      // an ssh session outlives the page on the relay: take it up again (the relay answers 'session', or 'gone')
      t.opening = true;
      t.kind = 'ssh';
      t.target = r.target;
      t.resume = r.id;
      t.tmux = r.tmux;
      send({ t: 'resume', id: r.id, ref: String(t.n) });
      continue;
    }
    t.reattach = r.tmux;
    open(t, r.target, r.label, r.kind);
  }
  if (replaced.length) send({ t: 'replaced', ids: replaced });
  renderBar();
}

function newTab(showPrompt = true) {
  /** @type {Tab} */
  const tab = { n: ++tabSeq, label: 'webmosh', title: '', target: '', kind: 'mosh', tmux: '', session: null, opening: false, prompt: null };
  tab.prompt = createPrompt({
    term,
    hosts: () => targets,
    onMosh: (id, name) => open(tab, id, name, 'mosh'),
    onSsh: (id, name) => open(tab, id, name, 'ssh'),
    onSetup: () => hostsPage.open(),
    onExit: () => {
      if (tabs.length > 1) closeTab(tab);
      else if (!leave()) term.write(`\x1b[2m${L('Not inside a panel: close the browser tab instead.', '不在面板里：关掉这个标签页即可。')}\x1b[0m\r\n`);
    },
    visible: () => active === tab,
  });
  // after the active one, as Safari and Ghostty do
  tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, tab);
  activate(tab);
  if (showPrompt) tab.prompt.show();
  return tab;
}

// Inside a panel: it hides the terminal (its sessions live on, the panel only hides its overlay).
function leave() {
  if (window.parent === window) return false;
  window.parent.postMessage('webmosh:close', '*');
  return true;
}
// Cmd+Shift+H: the panel shows or hides it, by what is on screen. A toggle, not a close: should a hidden page still
// hold the keys, the same key brings it back instead of doing nothing.
function togglePanel() {
  if (window.parent !== window) window.parent.postMessage('webmosh:toggle', '*');
}

// Clear the terminal in order with what is written: term.reset() takes effect at once, while term.write() is queued,
// so a prompt written just before a switch was drawn after the reset (2026-10-08: "webmosh> webmosh>" after a
// reload). ESC c (RIS) is the same full reset, parsed in turn.
const clearTerm = () => term.write('\x1bc');

function activate(tab) {
  if (!tab || tab.closed) return;
  const switching = active !== tab;
  active = tab;
  renderBar();
  document.title = tab.title || 'webmosh';
  focusTerm();
  if (!switching) return;
  clearTerm();
  if (tab.session) tab.session.client.repaint();
  else if (tab.restore || tab.opening) term.write(`\x1b[2m${L(`Connecting to ${tab.label}…`, `正在连接 ${tab.label}…`)}\x1b[0m`);
  else tab.prompt.repaint();
}

// Closing a tab ends its session the way mosh-client's Ctrl-^ . does: mosh-server is told to exit
// (its shell gets SIGHUP; a tmux session in it lives on), then the relay drops its side. That also
// works for targets whose mosh-server the relay cannot end itself (no end_via_ssh).
function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  const s = tab.session;
  tab.session = null;
  tab.closed = true;
  if (s) {
    s.closing = true;
    s.client.shutdown();
    setTimeout(() => release(s), 3000); // no answer (the data channel is down): drop it anyway
  }
  tabs.splice(i, 1);
  // the last one: a fresh prompt in its place, and inside a panel the terminal goes away, as
  // closing a window's last tab closes the window
  if (!tabs.length) { active = null; newTab(); leave(); return; }
  if (active === tab) { active = null; activate(tabs[Math.min(i, tabs.length - 1)]); } else renderBar();
}

// Photos and files into the active tab's computer, their paths pasted at the cursor (upload.mjs)
const uploader = createUploader({
  term,
  session: () => (active?.session ? { id: active.session.id, label: active.label } : null),
  badge: showBadge,
  focus: focusTerm,
  log: (line) => send({ t: 'keylog', lines: [`${Math.round(performance.now())} upload ${line}`] }),
});
window.webmosh.prepare = prepare; // for tests: HEIC to JPEG, big pictures shrunk

function pageAction(a) {
  if (hostsPage.isOpen && a.t !== 'ime') hostsPage.close(); // a tab or panel key goes back to the terminal
  const i = tabs.indexOf(active);
  if (a.t === 'kbbar') toggleKbBar();
  else if (a.t === 'pick') uploader.pick();
  else if (a.t === 'ime') openForSwitch();
  else if (a.t === 'panel') togglePanel();
  else if (a.t === 'new') newTab();
  else if (a.t === 'close') closeTab(active);
  else if (a.t === 'prev') activate(tabs[(i - 1 + tabs.length) % tabs.length]);
  else if (a.t === 'next') activate(tabs[(i + 1) % tabs.length]);
  else activate(a.n < 0 ? tabs[tabs.length - 1] : tabs[a.n]);
}
// A window capture listener, like fontsize.mjs: runs before xterm's key handling, so these never
// reach the remote. Not during ?keytest, which sweeps Cmd combinations itself.
if (!keytest) {
  window.addEventListener('keydown', (e) => {
    const a = pageShortcut(e);
    if (!a) return;
    // an input source switch stays unhandled, for iPadOS to act on after the page (see openForSwitch)
    if (a.t !== 'ime') e.preventDefault();
    e.stopImmediatePropagation();
    if (a.t === 'ime' && DIAG) send({ t: 'keylog', lines: [`${Math.round(performance.now())} ime ${e.key === ' ' ? 'Ctrl+Space' : e.key || e.code} bar=${kbBar ? 'on' : kbTemp ? 'temp' : 'off'}`] });
    if (!e.repeat || a.t === 'prev' || a.t === 'next') pageAction(a);
  }, true);
}

const tabOf = (id) => tabs.find((t) => t.session?.id === id);

// ---- signaling -------------------------------------------------------------------------------

function send(m) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// Page lifecycle lines for the relay's journal ("life"). iPadOS suspends a page in the background (Safari behind
// another app, the screen off): its sockets die and the relay sees the data channel go disconnected, then failed
// (2026-10-10, every 1-3 min on the M5 iPad). These say when the page was away and how long each session took to come
// back, which tells a suspended page from a network that dropped under a visible one. Kept until a socket is up.
const lifeLog = [];
let hiddenAt = 0;
let wsDownAt = 0;
let wsUpAt = 0;
function life(line) {
  lifeLog.push(`${Math.round(performance.now())} life ${line}`);
  if (lifeLog.length > 50) lifeLog.shift();
  flushLife();
}
function flushLife() {
  if (ws?.readyState === WebSocket.OPEN && lifeLog.length) send({ t: 'keylog', lines: lifeLog.splice(0) });
}
const short = (s) => s.id.slice(0, 6);
// A mosh session's first datagram from the server after its link opened: the screen is live again then ("Last contact"
// goes). The wait after "open in" is mosh's, not the network's.
function opened(s) {
  if (s.kind === 'mosh') s.openedAt = performance.now();
  s.client.opened?.();
}
function heard(s) {
  if (!s.openedAt) return;
  life(`${short(s)} heard the server ${Math.round(performance.now() - s.openedAt)} ms after open`);
  s.openedAt = 0;
}
const sessionStates = () => sessions().map((s) => `${short(s)} ${s.kind} dc=${s.dc?.readyState || '-'} pc=${s.pc?.connectionState || '-'}`).join(', ') || 'no sessions';

function connectWS() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { wsUpAt = Date.now(); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    life(`ws closed ${e.code}${document.hidden ? ' while hidden' : ''}`);
    if (!wsDownAt) wsDownAt = Date.now();
    ws = null;
    for (const t of tabs) t.opening = false; // an open in flight died with the socket
    // A socket that was up a while died under a visible page (frozen in the background without a visibilitychange, a
    // network that moved): straight back, the terminal waits on it. One that just came up or never did: once a second.
    const wait = wsUpAt && Date.now() - wsUpAt > 5000 ? 0 : 1000;
    wsUpAt = 0;
    setTimeout(() => { if (document.visibilityState === 'visible') connectWS(); }, wait);
  };
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      targets = m.targets || [];
      if (wsDownAt) { life(`ws back after ${Date.now() - wsDownAt} ms`); wsDownAt = 0; }
      flushLife();
      // back after a dropped WebSocket: these sessions are still this page's (a new connection is a new owner to the
      // relay), and reattach those whose data channel died too
      if (sessions().length) send({ t: 'own', ids: sessions().map((s) => s.id) });
      for (const s of sessions()) if (s.dc?.readyState !== 'open') attach(s, 'hello');
      if (!helloSeen) adoptSaved(m.saved); // the relay's copy of this device's tabs, if newer than the page's own
      helloSeen = true;
      if (autoTarget && !keytest && active) {
        const t = autoTarget;
        autoTarget = '';
        open(active, t, t);
      }
      reopenTabs();
      openPending();
      // the relay keeps this device's tabs, and whether the panel shows the terminal (relay/devices.go)
      syncTabs();
      if (window.parent !== window) send({ t: 'shown', shown });
      break;
    case 'hosts': // a computer was set up, renamed or went away (the hosts page)
      targets = m.targets || [];
      hostsPage.refresh();
      break;
    case 'session': {
      // m.ref: the tab that asked (the relay echoes it)
      const tab = tabs.find((t) => t.opening && (m.ref ? String(t.n) === m.ref : true));
      if (!tab) { send({ t: 'close', id: m.id }); break; } // its tab was closed meanwhile
      startSession(tab, m);
      break;
    }
    case 'answer': {
      const s = tabOf(m.id)?.session;
      // only the answer to the offer in flight: one to an offer since replaced would break the new connection
      if (!s?.pc || (m.ref && m.ref !== s.attachRef)) break;
      if (m.link) openLink(s, s.pc, m.link); // an attach over the WebSocket link (attachLink)
      else if (s.pc.setRemoteDescription) s.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e) => console.warn('webrtc', e));
      break;
    }
    case 'gone': { // the relay no longer has it (ended there, or lost)
      const resumed = m.ref && tabs.find((t) => String(t.n) === m.ref && t.opening && t.resume === m.id);
      if (resumed) {
        // its ssh session ended while the page was away (a relay restart ends them): a new one, back into tmux
        resumed.opening = false;
        resumed.resume = '';
        resumed.reattach = resumed.tmux;
        open(resumed, resumed.target, resumed.label, 'ssh');
        break;
      }
      const tab = tabOf(m.id);
      if (tab) end(tab, tab.kind === 'ssh' ? L('session ended', '会话已结束') : L('the session is no longer on the relay', '会话已不在中继上'));
      break;
    }
    case 'error': {
      // m.ref: an open that failed; m.id: an attach (the session stays, the page tries again)
      const tab = m.ref ? tabs.find((t) => String(t.n) === m.ref) : !m.id && tabs.find((t) => t.opening);
      if (tab) {
        tab.opening = false;
        tab.label = 'webmosh';
        tab.target = '';
        tab.reattach = '';
        tab.resume = '';
        renderBar();
        tab.prompt.show(m.msg);
        break;
      }
      const s = m.id && tabOf(m.id)?.session;
      if (s) s.attaching = false;
      console.warn(m.msg);
      break;
    }
  }
}

// ---- session ---------------------------------------------------------------------------------

function open(tab, target, name, kind = 'mosh') {
  if (tab.session || tab.opening) return;
  if (ws?.readyState !== WebSocket.OPEN) { tab.prompt.show(L('Not connected to the relay yet; try again in a moment.', '中继还没连上，稍等再试。')); return; }
  tab.opening = true;
  tab.label = name || target;
  tab.target = target;
  tab.kind = kind;
  tab.tmux = tab.reattach || ''; // a reopened tab keeps its tmux session saved until it is back in it
  renderBar();
  send({ t: 'open', target, kind, ref: String(tab.n), cols: term.cols, rows: term.rows });
}

async function startSession(tab, m) {
  const kind = m.kind === 'ssh' ? 'ssh' : 'mosh';
  const M = kind === 'mosh' ? await (await import('./webmosh.mjs')).default() : null;
  tab.opening = false;
  tab.resume = '';
  if (tab.closed) { send({ t: 'close', id: m.id }); return; }
  if (active === tab) clearTerm();
  /** @type {Session} */
  const s = { id: m.id, kind, target: m.target, ice: m.ice || [], tab };
  // a tab off screen draws nothing; switching to it repaints the whole screen
  const onScreen = (bytes, replay) => {
    s.onOutput?.();
    if (active === tab && tab.session === s) writeOut(bytes, replay);
  };
  const onClose = (why) => (s.closing ? release(s) : end(tab, why === 'ended' ? L('session ended', '会话已结束') : why));
  if (kind === 'ssh') {
    s.client = new PtyClient({
      onScreen,
      onReset: () => { if (active === tab && tab.session === s) clearTerm(); },
      send: (b) => { if (s.dc?.readyState !== 'open') return false; s.dc.send(b); return true; },
      control: (c) => send({ ...c, id: s.id }),
      onClose,
    });
  } else {
    s.client = new MoshClient(M, {
      key: m.key, port: m.port, cols: term.cols, rows: term.rows, predict: 'adaptive',
      onScreen,
      onDatagram: (d) => { if (s.dc?.readyState === 'open') s.dc.send(d); },
      onClose,
    });
  }
  tab.session = s;
  s.client.start();
  attach(s, 'start');
  // reopened after a reload: back into its tmux session (typed into the new shell). If that session is gone, plain
  // `tmux`. Typed once the shell has drawn its prompt: its output then stops for a moment (0.4 s; at most 4 s from the
  // start). Keys typed at the very start of a session were seen lost twice in tests (a login shell still starting up),
  // and this line must not be.
  if (tab.reattach) {
    const q = tab.reattach.replace(/'/g, `'\\''`);
    tab.tmux = tab.reattach;
    tab.reattach = '';
    let quiet = 0;
    const type = () => {
      if (!s.onOutput) return;
      s.onOutput = null;
      clearTimeout(quiet);
      clearTimeout(latest);
      s.client.input(` tmux attach -t '=${q}' 2>/dev/null || tmux\r`);
    };
    const latest = setTimeout(type, 4000);
    s.onOutput = () => { clearTimeout(quiet); quiet = setTimeout(type, 400); };
  }
  saveTabs();
  if (active === tab) focusTerm();
}

// How a session reaches the relay: WebRTC, a data channel that never resends, so mosh's datagrams keep UDP's manners; or,
// where the browser's WebRTC cannot reach the relay, a WebSocket of the session's own (relay/link.go), where a lost
// packet holds up the rest as with ssh but the rest of mosh stays. Firefox offers ICE no address on the Tailscale
// interface (2026-10-10), so it starts on the WebSocket; another browser moves there when no data channel has opened on
// this page yet and two attaches in a row got none. ?transport=ws or ?transport=webrtc decides (tests). Firefox on iOS is
// WebKit (FxiOS), whose WebRTC works.
const FIREFOX = /\bFirefox\//.test(navigator.userAgent);
const forcedTransport = params.get('transport');
let rtcWorked = false;
let rtcMisses = 0;
const viaLink = () => forcedTransport === 'ws' || (forcedTransport !== 'webrtc' && (FIREFOX || (!rtcWorked && rtcMisses >= 2)));
const missed = () => { if (!rtcWorked) rtcMisses++; };

// One attach at a time per session: an offer sent on the current socket gets its answer there, or the 6 s retry. A woken
// iPad page used to start three at once (the visibility handler, the relay's hello, the old channel closing), each
// closing the one before, and the relay answered offers the page had already dropped (2026-10-10 relay log: closed,
// connecting, closed, connecting, connected within a second). force: the attempt in flight is known dead.
let attachSeq = 0;
async function attach(s, why, force = false) {
  if (!s || s.released) return;
  if (s.attaching && !force && s.attachWs === ws) return;
  // no socket for the offer: the relay's hello attaches it again once one is up
  if (ws?.readyState !== WebSocket.OPEN) { s.attaching = false; return; }
  s.attaching = true;
  const sock = ws;
  const ref = String(++attachSeq);
  const t0 = performance.now();
  s.attachWs = sock;
  s.attachRef = ref;
  life(`${short(s)} attach (${why})`);
  if (viaLink()) { attachLink(s, ref, t0, why); return; }
  try {
    s.pc?.close();
    // TURN on the relay itself: Safari may hide every host address it has (see relay/turn.go)
    // ?relay=1 forces the TURN path, to test what Safari falls back to
    const relayOnly = params.has('relay');
    const pc = new RTCPeerConnection({ iceServers: s.ice, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    // mosh: unordered, no retransmits (mosh does its own); ssh: a reliable byte stream
    const dc = s.kind === 'ssh' ? pc.createDataChannel('pty') : pc.createDataChannel('mosh', { ordered: false, maxRetransmits: 0 });
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => { heard(s); s.client.datagram(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)); };
    dc.onopen = () => {
      rtcWorked = true;
      if (s.pc === pc) { s.attaching = false; life(`${short(s)} open in ${Math.round(performance.now() - t0)} ms (${why})`); }
      opened(s);
    };
    dc.onclose = () => { if (s.pc === pc && !s.released) setTimeout(() => { if (s.pc === pc) attach(s, 'channel closed', true); }, 500); };
    let down = false;
    pc.onconnectionstatechange = () => {
      if (s.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'disconnected' || st === 'failed') { down = true; life(`${short(s)} ${st}${document.hidden ? ' while hidden' : ''}`); }
      else if (st === 'connected' && down) { down = false; life(`${short(s)} connected again`); }
      if (st === 'failed') { missed(); attach(s, 'failed', true); }
    };
    s.pc = pc;
    s.dc = dc;
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 1500);
    if (s.pc !== pc) return; // a newer attach took over while this one gathered
    if (ws !== sock || sock.readyState !== WebSocket.OPEN) { s.attaching = false; return; } // the socket went: hello does it
    send({ t: 'attach', id: s.id, sdp: pc.localDescription.sdp, ref });
    setTimeout(() => { if (s.pc === pc && dc.readyState !== 'open') { missed(); attach(s, 'no answer in 6 s', true); } }, 6000);
  } catch (e) {
    s.attaching = false;
    console.warn('webrtc', e);
  }
}

// The WebSocket link (above): the attach goes over the page's socket, which claims the session for this page as an offer
// does, and is answered with a ticket for /link (openLink). To the rest of the page the link is the session's pc and dc
// at once: readyState and connectionState, send, close.
function attachLink(s, ref, t0, why) {
  s.pc?.close();
  const ch = {
    sock: null, t0, why, readyState: 'connecting', connectionState: 'connecting', closed: false,
    send(b) { if (this.readyState === 'open') this.sock.send(b); },
    close() { this.closed = true; this.readyState = this.connectionState = 'closed'; this.sock?.close(); },
  };
  s.pc = ch;
  s.dc = ch;
  send({ t: 'attach', id: s.id, ws: true, ref });
  setTimeout(() => { if (s.pc === ch && ch.readyState !== 'open') attach(s, 'no link in 6 s', true); }, 6000);
}
function openLink(s, ch, ticket) {
  if (ch.closed || ch.sock) return;
  const w = new WebSocket(`${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/link?id=${encodeURIComponent(s.id)}&t=${encodeURIComponent(ticket)}`);
  w.binaryType = 'arraybuffer';
  ch.sock = w;
  w.onopen = () => {
    if (s.pc !== ch || ch.closed) { w.close(); return; }
    ch.readyState = 'open';
    ch.connectionState = 'connected';
    s.attaching = false;
    life(`${short(s)} link open in ${Math.round(performance.now() - ch.t0)} ms (${ch.why})`);
    opened(s);
  };
  w.onmessage = (e) => { heard(s); s.client.datagram(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)); };
  w.onclose = () => {
    const was = ch.readyState;
    ch.readyState = ch.connectionState = 'closed';
    if (ch.closed || s.released || s.pc !== ch) return;
    if (was === 'open') life(`${short(s)} link closed${document.hidden ? ' while hidden' : ''}`);
    setTimeout(() => { if (s.pc === ch) attach(s, 'link closed', true); }, 500);
  };
}

function gathered(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, ms);
  });
}

// The relay forgets the session, the page lets go of its data channel and module.
function release(s) {
  if (s.released) return;
  s.released = true;
  send({ t: 'close', id: s.id });
  s.pc?.close();
  s.client.close('page');
}

// A session ended (exit, the server went away): its tab goes back to the prompt.
function end(tab, why) {
  const s = tab.session;
  if (!s) return;
  tab.session = null;
  release(s);
  tab.label = 'webmosh';
  tab.title = '';
  tab.target = '';
  tab.kind = 'mosh';
  tab.tmux = '';
  if (active === tab) document.title = 'webmosh';
  renderBar();
  tab.prompt.show(`[${why}]`);
}

// The page going away (tab closed, reloaded, a panel reloading the Kiosk): end the sessions now
// instead of leaving their mosh-servers to wait out the relay's 12 h. A page put in the back/forward
// cache (persisted) may come back, so that one keeps its sessions.
// An ssh session stays: the relay holds its terminal, and a reload takes it up again ('resume'); one that no page comes
// back to is dropped after the relay's detached_ttl.
window.addEventListener('pagehide', (e) => {
  if (e.persisted) { life('pagehide into the back/forward cache'); return; }
  for (const s of sessions()) {
    if (s.kind === 'ssh') continue;
    navigator.sendBeacon('/close', s.id);
    send({ t: 'close', id: s.id });
  }
});

// ---- clipboard -------------------------------------------------------------------------------

// tmux copies (set-clipboard on) arrive as OSC 52 through mosh. Safari writes the clipboard only
// inside a user gesture, and the copy lands a round trip after the key or mouse release that made
// it. So each gesture arms a write whose content is a promise the next OSC 52 fulfils (Safari and
// Chrome take a ClipboardItem holding a pending promise); no copy within 2 s and it is dropped.
//
// iPad Safari (2026-10-10 journal) refuses some arms on the spot, e.g. the pointerup ending a long
// touch drag with no other gesture in the seconds before. The copy was then lost for good, since mosh
// sends OSC 52 only when the clipboard changes: selecting the same text again sent nothing. Now a
// refused arm makes way for the next event of the press (iPadOS sends mousedown/mouseup after the
// pointerup), a copy no write took stays `unwritten` and goes into the next armed write that gets no
// copy of its own (at once on Cmd, a Cmd+V may follow), and Cmd+C with nothing selected in xterm.js
// copies the last OSC 52 again. Leaving the page drops `unwritten`: something else may be copied there.
let pendingCopy = null;
let unwritten = null; // { text, at }
let lastCopy = { text: '', at: 0 };
let clipNote = () => {}; // the pointer diagnostics' (at the end)
function stillUnwritten() {
  if (unwritten && performance.now() - unwritten.at > 60_000) unwritten = null;
  return unwritten;
}
function armClipboard(ev) {
  if (window.hbShell) return; // an iOS app embedding the page writes the clipboard itself, no gesture needed
  if (!window.ClipboardItem || !navigator.clipboard?.write) return;
  if (!pendingCopy) {
    const p = { text: null };
    let resolve, reject;
    const blob = new Promise((res, rej) => { resolve = res; reject = rej; });
    const end = () => { clearTimeout(p.timer); if (pendingCopy === p) pendingCopy = null; };
    p.fill = (text) => { end(); p.text = text; resolve(new Blob([text], { type: 'text/plain' })); };
    p.timer = setTimeout(() => {
      if (stillUnwritten()) { clipNote(`retry ${unwritten.text.length}`); p.fill(unwritten.text); }
      else { end(); reject(new Error('no copy')); }
    }, 2000);
    pendingCopy = p;
    clipNote(`arm(${ev?.type})`);
    navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(
      () => { if (unwritten?.text === p.text) unwritten = null; clipNote(`written ${p.text.length}`); },
      (e) => {
        if (p.text !== null) clipNote(`refused ${p.text.length} ${e?.name}`); // still unwritten
        else if (pendingCopy === p) { end(); clipNote(`refused before the copy ${e?.name}`); } // not a timeout
      });
  }
  if (ev?.type === 'keydown' && ev.key === 'Meta' && stillUnwritten()) pendingCopy?.fill(unwritten.text);
}
function deliverCopy(text) {
  window.webmosh.copied = text;
  if (window.hbShell) {
    window.hbShell.copy(text);
    clipNote(`osc52 ${text.length} shell`);
    return;
  }
  // Claude Code sends one copy up to three times within ~10 ms; a write started for the second could
  // cancel the armed write still holding the first (2026-10-10 journal: "refused" right after)
  const now = performance.now();
  if (text === lastCopy.text && now - lastCopy.at < 1000) return;
  lastCopy = { text, at: now };
  unwritten = { text, at: now };
  clipNote(`osc52 ${text.length}${pendingCopy ? '' : ' unarmed'}`);
  if (pendingCopy) pendingCopy.fill(text);
  else navigator.clipboard?.writeText(text).then(() => { if (unwritten?.text === text) unwritten = null; }, () => {}); // works where allowed
}
// Cmd+C when xterm.js has no selection (an app with the mouse, like tmux or Claude Code, selected and copied itself)
function copyAgain() {
  const text = window.webmosh.copied;
  if (!text) return false;
  clipNote(`again ${text.length}`);
  if (window.hbShell) window.hbShell.copy(text);
  else navigator.clipboard?.writeText(text).then(() => { if (unwritten?.text === text) unwritten = null; }, () => {});
  return true;
}
term.parser.registerOscHandler(52, (data) => {
  const b64 = data.slice(data.indexOf(';') + 1);
  if (!b64 || b64 === '?') return true;
  try {
    deliverCopy(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch { /* not base64 */ }
  return true;
});
for (const t of ['pointerup', 'mouseup', 'touchend']) $('#term').addEventListener(t, armClipboard, true);
term.textarea?.addEventListener('keydown', armClipboard, true);
window.addEventListener('blur', () => { unwritten = null; });
document.addEventListener('visibilitychange', () => { if (document.hidden) unwritten = null; });

// Copy on select. An app with the mouse (tmux) selects and copies itself; without one (a plain shell, less) xterm.js
// selects, and that selection is copied when the press that made it ends, as tmux and Ghostty do: in an iPad app
// embedding the page a drag in a plain shell selected text, copied nothing, and four Cmd+V pasted the old clipboard
// (2026-10-10).
let selectedInPress = false;
term.onSelectionChange(() => { if (term.hasSelection()) selectedInPress = true; });
$('#term').addEventListener('pointerdown', () => { selectedInPress = false; }, true);
window.addEventListener('pointerup', () => {
  setTimeout(() => { // after xterm's mouseup, which is when it reports the selection
    if (!selectedInPress) return;
    selectedInPress = false;
    const text = term.getSelection();
    if (text) deliverCopy(text);
  });
}, true);

// ---- trackpad presses: the Kiosk, an embedding app ---------------------------------------------

// The iPad Kiosk app hands the page a click of the iPad's trackpad (or Universal Control's pointer) as a TOUCH:
// pointerType 'touch' pointer and touch events while it is held, then mousedown + mouseup only after the release
// (2026-10-10 journal). xterm.js reports mouse events only, so tmux (mouse on) got a click at the end of a drag and
// never the drag. While the app in the terminal has mouse tracking on, the page reports such a press itself, through
// xterm's own mouse service (its protocol and encoding): the press, each new cell while held, and the release; xterm's
// reports from the late mousedown/mouseup are dropped. Two quick presses still make tmux's double click. #term has
// touch-action: none (index.html), or iPadOS would take the drag for a pan and cancel the pointer.
// A click wobbles the pointer a pixel or two; across a cell edge that made every click of a double click a tiny drag
// (tmux flashed a selection twice and selected no word). So a drag starts only past DRAG_SLOP px from the press, and a
// press that never got that far is released where it was pressed. The second press of a double click can also land a
// cell away from the first (2026-10-10: columns 65 then 64, inside Chinese text where a character is two cells wide, so
// Claude Code saw single clicks on two characters); a press within DOUBLE_CLICK_MS of the last click's release and
// DRAG_SLOP px of its press is reported where that press was.
// An iPad app embedding the page (window.hbShell) hands it the same press as a real mouse, which xterm reports itself,
// wobble and all: a click there crossed a cell edge, tmux took it for a drag and copied one character over the
// clipboard (2026-10-10). So a left-button mouse press goes the same way, minus the late mousedown/mouseup.
const OWN_PRESS = new Set(['touch', 'mouse']);
const DRAG_SLOP = 8;
const DOUBLE_CLICK_MS = 500;
const core = term._core;
let ownPress = null;        // { id, kind, down, last, dragging } of the press being reported
let ownReport = false;      // the mouse report going out now is the page's
let dropMouseUntil = 0;     // xterm's mouse reports are dropped until then: its own for a press the page reports
let mouseNote = () => {};   // the pointer diagnostics' (at the end)
let pressLog = () => {};    // the same, one line per press the page reports
let lastPressAt = 0;
let lastClick = null;       // { at, upAt }: where the last click (a press that was no drag) was reported, its release
function reportPress(e, action) {
  const c = core._mouseService?.getMouseReportCoords(e, core.screenElement);
  if (!c) return;
  ownReport = true;
  try {
    // the left button; action 1 = press, 32 = motion, 0 = release (xterm's CoreMouseAction)
    core.coreMouseService.triggerMouseEvent({ ...c, button: 0, action, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
  } finally {
    ownReport = false;
  }
}
core.screenElement?.addEventListener('pointerdown', (e) => {
  if (!OWN_PRESS.has(e.pointerType) || e.button !== 0 || !e.isPrimary || !core.coreMouseService?.areMouseEventsActive) return;
  const now = performance.now();
  const prev = lastClick;
  const apart = prev ? Math.hypot(e.clientX - prev.at.clientX, e.clientY - prev.at.clientY) : Infinity;
  const at = prev && now - prev.upAt < DOUBLE_CLICK_MS && apart < DRAG_SLOP ? prev.at : e; // where it is reported
  ownPress = { id: e.pointerId, kind: e.pointerType, down: e, at, last: e, dragging: false, t0: now, gap: now - lastPressAt, apart, far: 0, reports: [] };
  lastPressAt = now;
  dropMouseUntil = performance.now() + 60000;
  reportPress(at, 1);
}, true);
window.addEventListener('pointermove', (e) => {
  const p = ownPress;
  if (e.pointerId !== p?.id) return;
  const far = Math.hypot(e.clientX - p.down.clientX, e.clientY - p.down.clientY);
  p.far = Math.max(p.far, far);
  if (!p.dragging && far < DRAG_SLOP) return;
  p.dragging = true;
  p.last = e;
  reportPress(e, 32); // xterm sends one per new cell, and only if the app asked for drags
}, true);
for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(type, (e) => {
    const p = ownPress;
    if (e.pointerId !== p?.id) return;
    reportPress(!p.dragging ? p.at : type === 'pointerup' ? e : p.last, 0);
    ownPress = null;
    lastClick = p.dragging ? null : { at: p.at, upAt: performance.now() };
    const near = p.gap < 1000 && Number.isFinite(p.apart) ? `, ${p.apart.toFixed(1)} px from the last click${p.at !== p.down ? ' (reported there)' : ''}` : '';
    pressLog(`${p.kind} ${type} after ${Math.round(Math.min(p.gap, 99999))} ms${near}, held ${Math.round(performance.now() - p.t0)} ms, moved ${p.far.toFixed(1)} px: ${p.reports.join(' ')}`);
    // the Kiosk's touch gets its mousedown/mouseup only now; a mouse's mouseup follows the pointerup at once
    dropMouseUntil = performance.now() + (p.kind === 'touch' ? 800 : 50);
  }, true);
}

// ---- terminal wiring ------------------------------------------------------------------------

// everything typed goes through here (tests read window.webmosh.sent; ?keytest taps it)
const inputTaps = [];
let input = (d) => {
  if (keyRow && !MOUSE_RE.test(d)) d = keyRow.modify(d); // a Ctrl or Alt held on the key row
  window.webmosh.sent?.push(d);
  for (const f of inputTaps) f(d);
  if (active?.session) active.session.client.input(d);
  else if (!keytest) active?.prompt.handle(d);
};

// Keys with Ctrl, Option or Cmd, and special keys with any modifier, are sent from the physical
// key (event.code) through keys.mjs, never from what iPad Safari reports as key/keyCode. Plain and
// Shift typing stays with xterm.js, so input methods (Chinese etc.) keep working.
//
// Option as Meta. On an Apple keyboard Option+N, E, U, I and ` are dead keys (they put an accent
// on the next letter). iPad Safari reports such a keydown with keyCode 229, so xterm.js cannot
// tell which key it was, lets the composition run, and only the second press gets through as
// ESC n. Use the physical key instead, send ESC + its character at once, and cancel any
// composition Safari started for it, so no stray accent lands on the next letter.
// iPadOS keeps the dead key pending at the system level even after the page took the key: the
// next key then arrives folded into it (Option+N, Option+X gave key "˜≈"; Option+N, a gives "ã").
// So after a dead key the next printable key is taken by its physical position too, and whatever
// text the system makes of it is dropped.
const DEAD_CODES = new Set(['KeyN', 'KeyE', 'KeyU', 'KeyI', 'Backquote']);
// For when the dead key's keydown is missing or unusable and only a composition shows up:
// on the US layout each dead accent comes from one key.
const DEAD_ACCENTS = { '˜': 'n', '~': 'n', '´': 'e', '¨': 'u', 'ˆ': 'i', '^': 'i', '`': '`' };
const ACCENT_RE = /^[ˆ˜¨´`~^̀-ͯ]$/;
const MOUSE_RE = /^\x1b\[(<|M)/;

let altHeld = false;      // Option is down (its own keydown/keyup)
let deadPending = false;  // the system may still hold a dead key for the next key
let swallowUntil = 0;     // until the next keydown (and at most 500 ms): drop xterm's text for a key we sent
let dropAccent = false;   // a non-printable key resolved a dead key: its accent comes out as text
// keys (event.code) already sent: 'live' while that press may still send again (its composition
// events, its keyup), 'done' once another key or Option went down. iPadOS can leave out a dead key's
// keyup entirely (2026-10-08 keytest), so a press is also over when the next one starts.
const pressSent = new Map();
function pressesOver(except) {
  for (const c of pressSent.keys()) if (c !== except) pressSent.set(c, 'done');
}
const ACCENT_CODE = { n: 'KeyN', e: 'KeyE', u: 'KeyU', i: 'KeyI', '`': 'Backquote' };

function sendKey(bytes) {
  input(bytes);
  swallowUntil = performance.now() + 500;
}
// A dead-key composition we took stays open on iPad until the next key (blur/focus does not end
// it, and refocusing without a tap can leave the page deaf). Hide xterm's composition view, which
// would otherwise show the accent at the cursor as if it had been typed; its text is dropped.
const termEl = document.querySelector('#term');
function hideComposition() { termEl.classList.add('wm-hide-comp'); }
function showComposition() { termEl.classList.remove('wm-hide-comp'); }
term.textarea?.addEventListener('compositionend', () => setTimeout(showComposition, 0));
const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'CapsLock', 'OS', 'Fn', 'Hyper', 'Super']);

// iPad Safari (2026-10-08 keylog), Option+N: no usable keydown, then composition text "˜"
// (beforeinput/input, isComposing), compositionend "˜", and only then a complete keyup
// (key "˜", code KeyN, altKey). Three places can send the key; pressSent keeps it to once a press.
term.attachCustomKeyEventHandler((ev) => {
  if (ev.key === 'Alt') {
    altHeld = ev.type === 'keydown';
    pressesOver();
    return true;
  }
  if (MODIFIERS.has(ev.key)) return true; // Shift before the next letter must not end a pending dead key
  const pair = CHARS[ev.code];
  const mine = pair && !ev.metaKey && !ev.ctrlKey;
  const mods = { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey };
  if (ev.type === 'keyup') {
    if (mine && ev.altKey && DEAD_CODES.has(ev.code) && !pressSent.has(ev.code)) {
      // a dead key whose keydown never came through: send it now, on release
      sendKey(encode(ev.code, mods));
      deadPending = !ev.shiftKey;
    }
    pressSent.delete(ev.code);
    return !(mine && (ev.altKey || performance.now() < swallowUntil));
  }
  if (ev.type !== 'keydown') { // keypress of a key we took
    return !(mine && (ev.altKey || performance.now() < swallowUntil));
  }
  swallowUntil = 0;
  dropAccent = false;
  showComposition();
  pressesOver(ev.code);
  imeKey = null;
  const wasPending = deadPending;
  deadPending = false;
  // Cmd belongs to Safari and iPadOS (paste and copy arrive as their own events, not through here).
  // As in Ghostty only Cmd+Left/Right/Backspace send something; xterm.js would send Cmd+Return,
  // Cmd+Tab, Cmd+Esc... as if Cmd were not held. Cmd+A stays xterm's select-all; Cmd+C with no
  // xterm.js selection copies the last OSC 52 again (copyAgain).
  if (ev.metaKey) {
    if (ev.code === 'KeyC' && !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !term.hasSelection() && copyAgain()) {
      ev.preventDefault();
      return false;
    }
    const bytes = encode(ev.code, mods);
    if (wasPending) dropAccent = true;
    if (bytes) {
      ev.preventDefault();
      sendKey(bytes);
      return false;
    }
    return ev.code === 'KeyA' && !ev.shiftKey && !ev.altKey && !ev.ctrlKey;
  }
  // Other keyboards than Apple's: AltGr (Windows reports it as Ctrl+Alt) types its character, as xterm.js sends it; and
  // Ctrl+Shift+C / Ctrl+Shift+V copy and paste, as in terminals there (Ctrl+C and Ctrl+V are the remote's). C copies
  // xterm.js's selection, or else the last copy from the remote (copyAgain); V is left to the browser, whose paste
  // event xterm.js takes.
  if (!APPLE && ev.getModifierState?.('AltGraph')) return true;
  if (!APPLE && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.code === 'KeyC' || ev.code === 'KeyV')) {
    if (ev.code === 'KeyC') {
      ev.preventDefault();
      if (term.hasSelection()) deliverCopy(term.getSelection());
      else copyAgain();
    }
    return false;
  }
  // iPad Safari (2026-10-08 keylog): Ctrl+C arrives as key "c", code KeyC but keyCode 13, which
  // xterm.js maps to Enter and sends "\r". Ctrl with any character key goes by the physical key.
  if (pair && ev.ctrlKey && !ev.metaKey) {
    ev.preventDefault();
    sendKey(encode(ev.code, mods));
    return false;
  }
  if (mine && (ev.altKey || wasPending)) {
    ev.preventDefault();
    sendKey(encode(ev.code, mods));
    pressSent.set(ev.code, 'live');
    // a dead key starts a pending accent; one pressed while another was pending resolves it
    deadPending = ev.altKey && !ev.shiftKey && DEAD_CODES.has(ev.code) && !wasPending;
    return false;
  }
  // Special keys with a modifier, and Cmd+Left/Right/Backspace. xterm.js gets some of these wrong
  // for this setup: on Apple devices it turns Option+Left/Right into ESC b / ESC f (tmux reads M-b,
  // a new btop window, and M-f, zoom, instead of M-Left/M-Right), sends Option+Tab without the ESC,
  // drops Option on PageUp/PageDown, keeps Shift+PageUp/PageDown for its own (empty) scrollback, and
  // sends nothing for Cmd+arrows. An input method mid-composition keeps its Shift+arrows and Enter.
  const modified = ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey;
  const imeBusy = (ev.isComposing || ev.keyCode === 229) && !wasPending && !ev.altKey && !ev.ctrlKey && !ev.metaKey;
  if (!pair && modified && !imeBusy) {
    const bytes = encode(ev.code, mods, term.modes.applicationCursorKeysMode);
    if (bytes) {
      ev.preventDefault();
      sendKey(bytes);
      if (wasPending) dropAccent = true;
      return false;
    }
  }
  if (wasPending) dropAccent = true; // Enter, arrows, Backspace... let xterm send them
  if (pair && ev.keyCode === 229 && !ev.isComposing && !wasPending) imeKey = { until: performance.now() + 1000, sent: '' };
  return true;
});

// composition text that is a dead accent typed with Option held: that key, sent at once
function onCompositionText(data) {
  const key = DEAD_ACCENTS[data];
  if (!key || !altHeld) return; // not Option: a real composition (Chinese input etc.)
  const code = ACCENT_CODE[key];
  if (pressSent.get(code) === 'live') return;
  pressSent.set(code, 'live');
  sendKey('\x1b' + key);
  deadPending = true;
  hideComposition();
}
for (const type of ['compositionstart', 'compositionupdate', 'beforeinput', 'input']) {
  term.textarea?.addEventListener(type, (e) => { if (e.data && e.data.length === 1) onCompositionText(e.data); }, true);
}

// iPad Safari with Chinese (Pinyin) input on and nothing being composed (2026-10-08 keytest): a
// digit or punctuation key is a keydown with keyCode 229, and its text comes later in its own input
// event ("insertText"). xterm.js looks for the text in a setTimeout(0) after the keydown, before
// iPadOS has inserted it, and then ignores the input event, so "1" sent nothing. Send such text
// from the input event, unless xterm.js sent it after all (desktop browsers insert it at once).
let imeKey = null; // { until, sent }: armed by a keyCode-229 keydown outside a composition
term.textarea?.addEventListener('compositionstart', () => { imeKey = null; }, true);
term.textarea?.addEventListener('input', (e) => {
  const k = imeKey;
  if (!k || performance.now() > k.until || e.inputType !== 'insertText' || e.isComposing || !e.data) return;
  const text = e.data;
  setTimeout(() => {
    if (!k.sent.includes(text)) input(text);
    if (imeKey === k) imeKey = null;
  }, 0);
}, true);

// Output drawn a second time (an ssh tab's recent output, replayed after a tab switch or by the relay on a reattach)
// still holds the queries programs sent back then: yazi's DA1 and cell size, a shell's cursor position. xterm.js answers
// them again as it parses them, and the answers would be typed into whatever runs now ("62;4;9;22c" at a prompt). So
// while replayed bytes are being parsed, the terminal's reports are dropped. Reports go out from inside the parse, which
// runs between term.write() and its callback.
let replayParsing = 0;
const REPORT_RE = /^\x1b(\[[?>]?[\d;]*(c|n|R|t|S|\$y)|\][\d;]*[^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\)$/;
function writeOut(bytes, replay) {
  if (!replay) { term.write(bytes); return; }
  replayParsing++;
  term.write(bytes, () => { replayParsing--; });
}

term.onData((d) => {
  if (replayParsing && REPORT_RE.test(d)) return;
  if (MOUSE_RE.test(d)) { // a left press is reported by the page (trackpad presses, above), not from its mouse events
    const drop = !ownReport && performance.now() < dropMouseUntil;
    mouseNote(ownReport ? 'own' : drop ? 'dropped' : 'xterm', d);
    if (ownReport) ownPress?.reports.push(d.slice(3));
    if (drop) return;
  }
  if (!MOUSE_RE.test(d)) {
    if (performance.now() < swallowUntil) return;
    if (altHeld && ACCENT_RE.test(d)) return; // an accent made with Option is never text here
    // the accent of a dead key we sent, committed as text: after a non-printable key (dropAccent),
    // or by iPadOS itself when a key it keeps (Ctrl+I) ends the composition (2026-10-08 retest)
    if ((dropAccent || deadPending) && ACCENT_RE.test(d)) { dropAccent = false; deadPending = false; return; }
    if (imeKey) imeKey.sent += d;
  }
  input(d);
});
term.onBinary((d) => input(Uint8Array.from(d, (c) => c.charCodeAt(0))));
// ?keytest: the guided Magic Keyboard sweep (keytest.mjs), with no session behind it
if (params.has('keytest')) {
  import('./keytest.mjs').then(({ startKeyTest }) => startKeyTest({ term, send, ready: () => ws?.readyState === WebSocket.OPEN, tapInput: (f) => inputTaps.push(f) }));
}
term.onResize(({ cols, rows }) => { for (const s of sessions()) s.client.resize(cols, rows); });
// only the active tab draws, so a title is always its (tmux: set-titles-string '#S · #W')
term.onTitleChange((t) => {
  document.title = t || 'webmosh';
  if (active?.session && active.title !== t) {
    active.title = t;
    active.tmux = tmuxOf(t);
    bar.render(tabs, active);
    saveTabs();
  }
});
window.addEventListener('resize', () => fit.fit());
window.visualViewport?.addEventListener('resize', () => fit.fit());
// The screen stays put and full. While the keyboard or its bar is up (Cmd+Shift+K), iPadOS shrinks only the visual
// viewport and lets the page pan under it; it may also scroll the page to bring xterm's input into view (2026-10-08: the
// screen slid up and the first rows went off the top). A shorter terminal above the bar left a black strip under it
// (the user wants the full screen), so the terminal keeps its full height, the bar floats over its bottom, and it
// follows the visible area's top. Inside a panel the panel does that for the iframe, so here a scroll is
// only undone; on its own (Safari) the page does it itself.
// A touch screen's own keyboard is another matter: it covers half the screen, cursor and key row included. While it is
// up (the visible area more than 150 px short of the page) the page takes the visible height, so the terminal ends
// above the keyboard. Android does that itself (interactive-widget=resizes-content); iOS shrinks only the visible area.
{
  const vv = window.visualViewport;
  const standalone = window.parent === window;
  const pin = () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    if (!standalone || !vv || Math.abs(vv.scale - 1) > 0.01) return; // pinch zoom pans on purpose
    const top = `${Math.max(0, vv.offsetTop)}px`;
    if (document.body.style.top !== top) Object.assign(document.body.style, { position: 'fixed', left: '0', right: '0', top });
    const covered = document.documentElement.clientHeight - vv.height;
    const height = TOUCH && covered > 150 ? `${Math.floor(vv.height)}px` : '';
    if (document.body.style.height !== height) {
      document.body.style.height = height;
      document.body.classList.toggle('kb-up', !!height);
      fit.fit();
    }
  };
  window.addEventListener('scroll', pin);
  vv?.addEventListener('resize', pin);
  vv?.addEventListener('scroll', pin);
  pin();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    hiddenAt = Date.now();
    life(`hidden: ${sessionStates()}`);
    return;
  }
  // Date.now, not performance.now: the monotonic clock may stand still while the iPad sleeps
  life(`visible after ${hiddenAt ? Date.now() - hiddenAt : '?'} ms away, ws ${ws ? ['connecting', 'open', 'closing', 'closed'][ws.readyState] : 'none'}: ${sessionStates()}`);
  hiddenAt = 0;
  if (webglLost) startWebgl();
  connectWS();
  for (const s of sessions()) if (s.dc?.readyState !== 'open') attach(s, 'visible');
});
window.addEventListener('pageshow', (e) => { if (e.persisted) life('pageshow from the back/forward cache'); });


// Keyboard diagnostics, with DIAG (page.diagnostics, or ?keylog): Option, Ctrl and dead-key events go to the relay's
// journal (never plain letters or IME text, so typed passwords and messages stay out of it), and so does a line per
// pointer press; ?keylog also shows the last events on the page and records what was sent. Off by default since
// v0.4.1: a journal of someone's key presses is not something a relay should keep unasked.
if (DIAG) {
  const overlay = params.has('keylog');
  let box = null;
  const lines = [];
  if (overlay) {
    box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;bottom:8px;margin:0;padding:8px;max-width:60vw;background:#000c;color:#9fd;font:11px ui-monospace,monospace;z-index:9;pointer-events:none;white-space:pre-wrap';
    document.body.append(box);
    window.webmosh.sent = [];
  }
  const report = [];
  setInterval(() => { if (report.length) send({ t: 'keylog', lines: report.splice(0, 50) }); }, 1000);
  const add = (t, toRelay) => {
    if (box) { lines.push(t); if (lines.length > 14) lines.shift(); box.textContent = lines.join('\n'); }
    if (toRelay) report.push(t);
  };
  let optionWindow = 0; // events shortly after an Option or Ctrl key are reported too
  report.push(`page ${WM_BUILD} loaded`);
  for (const type of ['keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
    term.textarea?.addEventListener(type, (e) => {
      const now = performance.now();
      if (e.altKey || e.key === 'Alt' || e.ctrlKey) optionWindow = now + 1500;
      const accent = e.data && ACCENT_RE.test(e.data);
      const relevant = e.altKey || e.key === 'Alt' || e.ctrlKey || e.key === 'Dead' || accent || (now < optionWindow && (e.data === '' || accent || e.keyCode === 229));
      if (!relevant && !box) return;
      const line = `${Math.round(now)} ${type} key=${JSON.stringify(e.key ?? '')} code=${e.code ?? ''} kc=${e.keyCode ?? ''} alt=${e.altKey ? 1 : 0} ctrl=${e.ctrlKey ? 1 : 0} meta=${e.metaKey ? 1 : 0} comp=${e.isComposing ? 1 : 0} it=${e.inputType ?? ''} data=${JSON.stringify(relevant ? (e.data ?? '') : '…')}`;
      add(line, relevant);
    }, true);
  }
  // Pointer presses (2026-10-10, drag-select in the Kiosk): one line per press, or per run of quick presses: the
  // pointer kind and size, the events by type (moves split into (b) a button held and (0) none), the mouse reports
  // sent by the page (own) and by xterm, those dropped, and whether a copy came back. No text, only lengths.
  let press = null;
  const pressLine = () => {
    const p = press;
    press = null;
    const ev = Object.entries(p.ev).map(([k, n]) => (n > 1 ? `${k}*${n}` : k)).join(' ');
    const reps = (k) => `${k}=${p[k].length}${p[k].length ? ` ${p[k][0]}..${p[k].at(-1)}` : ''}`;
    report.push(`${Math.round(p.t0)} press ${p.kind} ${p.size} mode=${term.modes.mouseTrackingMode} [${ev}] ${reps('own')} ${reps('xterm')} ${reps('dropped')} copy=${p.copy.join(',') || '-'}`);
  };
  const seen = (e) => {
    if (!press) {
      if (!/down|start/.test(e.type)) return;
      press = { t0: performance.now(), kind: e.pointerType || e.type, size: e.width ? `${Math.round(e.width)}x${Math.round(e.height)}` : '', ev: {}, own: [], xterm: [], dropped: [], copy: [] };
    }
    if (/move$/.test(e.type) && !ownPress && !e.buttons && !e.touches) return; // hover
    const k = /move$/.test(e.type) && 'buttons' in e ? `${e.type}(${e.buttons ? 'b' : 0})` : e.type;
    press.ev[k] = (press.ev[k] ?? 0) + 1;
    clearTimeout(press.timer);
    press.timer = setTimeout(pressLine, 1500);
  };
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup',
    'touchstart', 'touchmove', 'touchend', 'touchcancel', 'dblclick', 'contextmenu', 'dragstart']) {
    window.addEventListener(t, seen, { capture: true, passive: true });
  }
  mouseNote = (k, d) => { if (press && press[k].length < 100) press[k].push(d.slice(2)); };
  pressLog = (line) => report.push(`${Math.round(performance.now())} ${line}`);
  clipNote = (what) => {
    if (!press) { if (!what.startsWith('arm(')) report.push(`${Math.round(performance.now())} clipboard ${what}`); } // not every key's arm
    else if (press.copy.length < 12) press.copy.push(`${what}@${Math.round(performance.now() - press.t0)}`);
  };
  const prevInput = input;
  input = (d) => {
    const meta = d.startsWith('\x1b') && (d.length === 2 || /^\x1b\[1;\d[A-D]$/.test(d)); // Option+key, Option+arrow
    const ctl = d.length === 1 && d < ' ' && performance.now() < optionWindow; // a control key just after Ctrl
    add(`${Math.round(performance.now())} SENT ${meta || ctl || box ? JSON.stringify(d) : '(text)'}`, meta || ctl || (d.length === 1 && ACCENT_RE.test(d)));
    prevInput(d);
  };
}


// Embedded in a panel (an iframe overlay): take the focus when the panel shows the terminal, let it go when the
// panel hides it, and tell the panel someone is typing (at most every 10 s), so it neither sleeps nor reloads under
// the shell.
if (window.parent !== window) {
  window.addEventListener('message', (e) => {
    // the relay remembers it for this device: at its next start the panel opens the terminal again if it was on screen
    if (e.data === 'webmosh:focus') { shown = true; focusTerm(); send({ t: 'shown', shown }); }
    if (e.data === 'webmosh:hide') { shown = false; term.blur(); send({ t: 'shown', shown }); }
    // the panel's hosts sheet: a new tab, connecting (frame-ancestors lets only the panel embed this page)
    if (e.data?.t === 'webmosh:open' && typeof e.data.target === 'string') {
      pendingOpen = { kind: e.data.kind === 'ssh' ? 'ssh' : 'mosh', target: e.data.target };
      openPending();
    }
  });
  let lastActive = 0;
  const active = () => {
    const now = Date.now();
    if (now - lastActive < 10000) return;
    lastActive = now;
    window.parent.postMessage('webmosh:active', '*');
  };
  term.textarea?.addEventListener('keydown', active, true);
  document.addEventListener('pointerdown', active, true);
}

// The tabs the page had before a reload, or a first tab: the page's own prompt (prompt.mjs), like Blink's local shell;
// with ?target= it opens that host at once instead. The relay's copy may still take their place at the first hello.
if (keytest || autoTarget || !restoreTabs(startTabs)) newTab(!keytest && !autoTarget);
if (params.has('hosts')) hostsPage.open();

connectWS();
