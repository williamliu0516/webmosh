// Tabs, as in Ghostty: each tab is its own prompt or mosh session, all sharing the one xterm.js
// terminal. Only the tab on screen draws; the others keep their sessions running, and switching to
// one has its mosh client redraw the whole screen from the state it already holds (no round trip).
//
// The bar shows from two tabs on (Ghostty's window-show-tab-bar = auto). With one tab there is a
// faint + in the corner, for the pointer (Universal Control) and for touch.
//
// Keys: Cmd+Shift+T new tab, Cmd+Shift+W close, Cmd+Shift+[ / ] or Cmd+Shift+Left / Right previous /
// next, Cmd+1..8 that tab, Cmd+9 the last; on other keyboards Alt+Shift in place of Cmd and of Cmd+Shift (platform.mjs).
// New and close take Shift (the user's choice): on the iPad
// Cmd+W never reaches the page and closes the whole Kiosk app (2026-10-08), and Cmd+T moved to match.
// keys.mjs sends nothing for any of these, so the remote loses no key. A page gets them only where the
// browser lets it: the Kiosk app's web view does (as it does Cmd = / - / 0); Safari keeps some for
// its own tabs. Four keys here are not tab keys: Cmd+Shift+K turns iPadOS's keyboard bar on and off,
// Ctrl+Space (Shift too) turns keyboard UI on for iPadOS's input source switch (app.mjs), inside
// a panel Cmd+Shift+H shows and hides the terminal (on the panel the same key opens it again), and
// Cmd+Shift+I opens iPadOS's picker for photos and files to send to the tab's computer (upload.mjs). iPadOS may
// take Cmd+Shift+H for itself (Home Screen), as it does Cmd+W; the user asked for it anyway (2026-10-10).

import { L } from './i18n.mjs';
import { APPLE, pageModifier, pageKey, tabKey } from './platform.mjs';

/**
 * The page's own action for a key (tabs, the keyboard bar), or null. By physical key (event.code), as
 * everywhere on this page: iPad Safari's key values are unreliable with modifiers.
 * @returns {null | {t: 'new' | 'close' | 'prev' | 'next' | 'kbbar' | 'ime' | 'panel' | 'pick'} | {t: 'goto', n: number}}  n = -1: the last
 */
export function pageShortcut(e) {
  if (APPLE && e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Space') return { t: 'ime' };
  if (!pageModifier(e)) return null;
  const c = e.code;
  const d = /^Digit([1-9])$/.exec(c);
  if (d && !(APPLE && e.shiftKey)) return { t: 'goto', n: d[1] === '9' ? -1 : Number(d[1]) - 1 };
  if (e.shiftKey) {
    if (c === 'KeyT') return { t: 'new' };
    if (c === 'KeyW') return { t: 'close' };
    if (c === 'KeyK') return { t: 'kbbar' };
    if (c === 'KeyH') return { t: 'panel' };
    if (c === 'KeyI') return { t: 'pick' };
    if (c === 'BracketLeft' || c === 'ArrowLeft') return { t: 'prev' };
    if (c === 'BracketRight' || c === 'ArrowRight') return { t: 'next' };
    return null;
  }
  return null;
}

/**
 * The bar (#tabs) and the single-tab + (#newtab).
 * @param {{onSelect: (tab) => void, onClose: (tab) => void, onNew: () => void}} handlers
 * @returns {{render(tabs: Array<{label: string, title?: string}>, active: object): boolean}}
 *   render returns whether the bar is showing (the terminal's size depends on it)
 */
export function createTabBar({ onSelect, onClose, onNew }) {
  const bar = document.createElement('nav');
  bar.id = 'tabs';
  bar.hidden = true;
  const plus = document.createElement('div');
  plus.id = 'newtab';
  plus.title = L(`New tab (${pageKey('T')})`, `新标签（${pageKey('T')}）`);
  plus.textContent = '+';
  document.body.prepend(bar);
  document.body.append(plus);

  // Keep the keyboard focus in the terminal: a tap or click on the bar must not move it.
  const keepFocus = (el) => el.addEventListener('pointerdown', (e) => e.preventDefault());
  keepFocus(bar);
  keepFocus(plus);
  plus.addEventListener('click', onNew);

  return {
    render(tabs, active) {
      const show = tabs.length > 1;
      bar.hidden = !show;
      plus.hidden = show;
      document.body.classList.toggle('has-tabs', show);
      if (!show) return false;
      bar.replaceChildren();
      tabs.forEach((tab, i) => {
        const el = document.createElement('div');
        el.className = 'tab' + (tab === active ? ' active' : '');
        el.title = [tab.label, tab.title].filter(Boolean).join(' · ');
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.title = L(`Close (${pageKey('W')})`, `关闭（${pageKey('W')}）`);
        x.addEventListener('click', (e) => { e.stopPropagation(); onClose(tab); });
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = tab.label;
        if (tab.kind === 'ssh' && tab.target) {
          const kind = document.createElement('span');
          kind.className = 'kind';
          kind.textContent = 'ssh';
          name.append(kind);
        }
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = tab.title || '';
        const key = document.createElement('span');
        key.className = 'key';
        const n = i < 8 ? i + 1 : i === tabs.length - 1 ? 9 : 0;
        key.textContent = !n ? '' : APPLE ? `⌘${n}` : `Alt⇧${n}`;
        if (n) key.title = tabKey(n);
        el.append(x, name, sub, key);
        el.addEventListener('click', () => onSelect(tab));
        bar.append(el);
      });
      const add = document.createElement('div');
      add.className = 'add';
      add.title = L(`New tab (${pageKey('T')})`, `新标签（${pageKey('T')}）`);
      add.textContent = '+';
      add.addEventListener('click', onNew);
      bar.append(add);
      return true;
    },
  };
}
