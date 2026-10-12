// On a touch screen (a phone, an iPad without a keyboard): the keys its on-screen keyboard lacks, in a row under the
// terminal while that keyboard is on: Esc, Ctrl, Alt, Tab, the arrows, and | ~ / - from the keyboard's second page.
// Ctrl and Alt hold for the next key, typed or tapped (Ctrl, then c: ^C). A key acts when the finger lifts, as on the
// keyboard itself, so a swipe that scrolls the row (pointercancel) types nothing; a held arrow repeats from 0.4 s. A
// press never takes the focus from the terminal, or the on-screen keyboard would go down. The row's last key puts the keyboard away
// (as Cmd+Shift+K does); a keyboard button in the corner then brings it back. Left of either, a paperclip opens the
// picker for photos and files (Cmd+Shift+I's, upload.mjs): a touch screen without a keyboard has no other way to it.

import { encode, ctrlOf } from './keys.mjs';
import { L } from './i18n.mjs';
import { pageKey } from './platform.mjs';

const KEYS = [
  { label: 'Esc', code: 'Escape' },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt', mod: 'alt' },
  { label: 'Tab', code: 'Tab' },
  { label: '←', code: 'ArrowLeft', repeat: true },
  { label: '↑', code: 'ArrowUp', repeat: true },
  { label: '↓', code: 'ArrowDown', repeat: true },
  { label: '→', code: 'ArrowRight', repeat: true },
  { label: '|', code: 'Backslash', shift: true },
  { label: '~', code: 'Backquote', shift: true },
  { label: '/', code: 'Slash' },
  { label: '-', code: 'Minus' },
];

// a keyboard; with a chevron under it, "put it away"
const ICON = (away) => '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="11" rx="2"/>'
  + '<path d="M6 8h.01M9.5 8h.01M13 8h.01M16.5 8h.01M6 11.5h.01M18 11.5h.01M9 11.5h6"/>'
  + (away ? '<path d="M9 19l3 2.5 3-2.5"/>' : '') + '</svg>';
// a paperclip
const CLIP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path transform="rotate(45 12 12)" d="M16 7v9a4 4 0 0 1-8 0V5.5a2.5 2.5 0 0 1 5 0V15a1 1 0 0 1-2 0V8"/></svg>';

/**
 * @param {{term: import('@xterm/xterm').Terminal, send: (bytes: string) => void, onToggle: () => void, onPick: () => void}} o
 *   send: bytes as if typed; onToggle: the keyboard switch (Cmd+Shift+K's); onPick: the file picker (Cmd+Shift+I's)
 * @returns {{show(on: boolean): void, modify(d: string): string}}
 *   show: the row (on) or the corner buttons (off); modify: typed data with a held Ctrl or Alt applied
 */
export function createKeyRow({ term, send, onToggle, onPick }) {
  const row = document.createElement('div');
  row.id = 'keys';
  row.hidden = true;
  // the keys scroll sideways on a narrow phone; the away key stays at the right end, always in sight
  const strip = document.createElement('div');
  strip.className = 'strip';
  row.append(strip);
  const held = { ctrl: false, alt: false };
  const modKeys = {};
  const press = (el, act, repeat) => {
    let timer = 0;
    let down = false;  // a press is on
    let fired = false; // it repeated already: the lift adds nothing
    // the press's default (the focus moving to the button) prevented
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      down = true;
      fired = false;
      if (repeat) {
        const again = (ms) => { timer = setTimeout(() => { fired = true; act(); again(60); }, ms); };
        again(400);
      }
    });
    el.addEventListener('pointerup', () => { clearTimeout(timer); if (down && !fired) act(); down = false; });
    el.addEventListener('pointercancel', () => { clearTimeout(timer); down = false; });
  };
  const paint = () => { for (const [m, el] of Object.entries(modKeys)) el.classList.toggle('held', held[m]); };
  for (const k of KEYS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.tabIndex = -1;
    el.textContent = k.label;
    if (k.mod) {
      modKeys[k.mod] = el;
      press(el, () => { held[k.mod] = !held[k.mod]; paint(); });
    } else {
      press(el, () => {
        const bytes = encode(k.code, { shift: !!k.shift, ctrl: held.ctrl, alt: held.alt }, term.modes.applicationCursorKeysMode);
        held.ctrl = held.alt = false;
        paint();
        send(bytes);
      }, k.repeat);
    }
    strip.append(el);
  }
  // A button that acts on its click and keeps the focus where it is. The click, not the press: iOS opens a file picker
  // and raises the on-screen keyboard only inside a tap's click; and the away key's row goes away with it, so its
  // click would land on what is then under the finger (the + moving down into the corner opened a tab).
  const button = (props, icon, act) => {
    const el = Object.assign(document.createElement('button'), { type: 'button', tabIndex: -1, ...props });
    el.innerHTML = icon;
    el.addEventListener('pointerdown', (e) => e.preventDefault());
    el.addEventListener('click', act);
    return el;
  };
  const pickTitle = L(`Photos and files (${pageKey('I')})`, `照片和文件（${pageKey('I')}）`);
  row.append(button({ className: 'attach', title: pickTitle }, CLIP, onPick),
    button({ className: 'away', title: L('Put the keyboard away', '收起键盘') }, ICON(true), onToggle));
  document.querySelector('#term').after(row);

  // the focus the keyboard button gives the terminal raises the on-screen keyboard
  const corner = [button({ id: 'kbtoggle', title: L('Keyboard', '键盘'), hidden: true }, ICON(false), onToggle),
    button({ id: 'attach', title: pickTitle, hidden: true }, CLIP, onPick)];
  document.body.append(...corner);

  return {
    show(on) {
      row.hidden = !on;
      for (const el of corner) el.hidden = on;
      document.body.classList.toggle('has-keys', on);
      if (!on && (held.ctrl || held.alt)) { held.ctrl = held.alt = false; paint(); }
    },
    modify(d) {
      if (!held.ctrl && !held.alt) return d;
      const one = [...d].length === 1;
      if (one && held.ctrl) d = d === '\x7f' ? '\x08' : d >= ' ' ? ctrlOf(d) : d;
      if (one && held.alt) d = '\x1b' + d;
      held.ctrl = held.alt = false;
      paint();
      return d;
    },
  };
}
