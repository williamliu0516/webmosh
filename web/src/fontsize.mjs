// Cmd = / Cmd - / Cmd 0: the terminal's font size, as in Blink. Remembered in localStorage; each
// change refits the terminal, so mosh (and tmux on the far end) get the new size. The default (Cmd 0) is the size the
// terminal starts with: the deployment's page.terminal.fontSize, else app.mjs's 15. Back at it, nothing is stored, so
// a later change of the deployment's size reaches the device.
//
// A window capture listener: it runs before xterm's own key handling (app.mjs, keys.mjs), so these
// three never reach the remote, and preventDefault keeps Safari from zooming the page where Safari
// lets a page have the key (the Kiosk app's web view does; Safari itself may keep Cmd = for its zoom).
// On other keyboards Ctrl = / - / 0 stay the browser's zoom, which does the same: the terminal refits to the new size.

import { L } from './i18n.mjs';
import { APPLE } from './platform.mjs';

const KEY = 'webmosh.fontSize';
const MIN = 9;
const MAX = 36;

// A short notice in the middle of the screen (font size, the keyboard bar switch).
let badge = null;
let badgeTimer = 0;
export function showBadge(text, ms = 900) {
  if (!badge) {
    badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);padding:10px 18px;border-radius:12px;'
      + 'background:rgba(30,32,36,.92);color:#d7dae0;font:600 15px -apple-system,system-ui,sans-serif;z-index:20;pointer-events:none;transition:opacity .25s';
    document.body.append(badge);
  }
  badge.textContent = text;
  badge.style.opacity = '1';
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => { badge.style.opacity = '0'; }, ms);
}

export function fontSizeControls({ term, fit }) {
  const DEFAULT_SIZE = clamp(term.options.fontSize);
  let size = DEFAULT_SIZE;
  try { size = clamp(Number(localStorage.getItem(KEY)) || DEFAULT_SIZE); } catch { /* storage off */ }

  const show = () => showBadge(size === DEFAULT_SIZE ? L(`Font size ${size} (default)`, `字号 ${size}（默认）`) : L(`Font size ${size}`, `字号 ${size}`));

  function apply(announce) {
    term.options.fontSize = size;
    fit.fit();
    if (announce) show();
  }

  function set(next) {
    next = clamp(next);
    if (next === size) { show(); return; }
    size = next;
    try {
      if (size === DEFAULT_SIZE) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(size));
    } catch { /* storage off */ }
    apply(true);
  }

  if (APPLE) window.addEventListener('keydown', (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    let next;
    if (e.code === 'Equal' || e.key === '=' || e.key === '+') next = size + 1;
    else if (e.code === 'Minus' || e.key === '-' || e.key === '_') next = size - 1;
    else if (e.code === 'Digit0' || e.key === '0') next = DEFAULT_SIZE;
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    set(next);
  }, true);

  if (size !== DEFAULT_SIZE) apply(false);
  return { get size() { return size; }, set };
}

function clamp(n) {
  return Math.max(MIN, Math.min(MAX, Math.round(n)));
}
