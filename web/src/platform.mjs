// What kind of keyboard and screen the page is on.
//
// The page's own keys (tabs, the keyboard switch, the file picker) are Cmd's on Apple keyboards (Mac, iPad, iPhone),
// as in other Apple apps. Elsewhere (Windows, Linux, ChromeOS, Android) the Windows/Super key belongs to the system and
// the browser keeps Ctrl+T, Ctrl+W, Ctrl+N and Ctrl+Tab for itself, so they take Alt+Shift there: a page may have
// those, and few programs bind them (tmux's M-1..9, often bound, stay with the remote). iPadOS reports "MacIntel".

export const APPLE = /^(Mac|iPhone|iPad|iPod)/.test(globalThis.navigator?.platform || '');

/** Whether the page's modifier is down: Cmd (and no Option, no Ctrl) on Apple keyboards, else Alt+Shift (no Ctrl). */
export const pageModifier = (e) => !e.ctrlKey && (APPLE ? e.metaKey && !e.altKey : e.altKey && e.shiftKey && !e.metaKey);

/** A page key's name for help and tooltips: Cmd+Shift+T / Alt+Shift+T. */
export const pageKey = (k) => `${APPLE ? 'Cmd' : 'Alt'}+Shift+${k}`;

/** The key for tab n (1-9): Cmd+1 / Alt+Shift+1. */
export const tabKey = (n) => (APPLE ? `Cmd+${n}` : `Alt+Shift+${n}`);

// A touch screen as the main pointer (a phone, an iPad; not a laptop that also has one): the on-screen keyboard's
// switch and the row of keys that keyboard lacks (keyrow.mjs).
export const TOUCH = !!globalThis.matchMedia?.('(pointer: coarse)').matches; // false in Node (harness/keys-all.mjs imports tabs.mjs)

// A phone: a touch screen whose short side is under 600 px. It has no keyboard of its own, so the on-screen one is on
// whatever the relay's page.keyboard says (app.mjs).
export const PHONE = TOUCH && Math.min(globalThis.screen?.width || 0, globalThis.screen?.height || 0) < 600;
