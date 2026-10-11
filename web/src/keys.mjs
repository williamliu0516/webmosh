// What each key on the iPad's Magic Keyboard (US layout) sends, by physical key (event.code).
//
// The reference is Ghostty as the user runs it on the Mac (macos-option-as-alt = true, the alt+arrow
// keybinds unbound) in legacy mode, i.e. no kitty keyboard protocol (tmux has extended-keys off):
//   - Option is Meta: ESC before what the key sends without it.
//   - Ctrl with a character key: the C0 control from kitty's legacy table (Ghostty uses the same);
//     Shift is ignored for letters (Ctrl+Shift+A is ^A), and keys with no control code send their
//     character (Ctrl+1 is "1").
//   - Cursor, editing and function keys: xterm's CSI forms; any modifier switches to CSI 1;m X or
//     CSI n;m ~ with m = 1 + Shift + 2*Option + 4*Ctrl.
//   - Cmd+Left/Right/Backspace: ^A / ^E / ^U, Ghostty's macOS "natural text editing" defaults.
//     Every other Cmd combination belongs to Safari or iPadOS and sends nothing.
// Every key and modifier set is tested against this table in a real browser, and each sequence against tmux's
// reading of it as the intended key.

/** Character keys: event.code -> [unshifted, shifted]. */
export const CHARS = {};
for (let i = 0; i < 26; i++) {
  const c = String.fromCharCode(97 + i);
  CHARS['Key' + c.toUpperCase()] = [c, c.toUpperCase()];
}
')!@#$%^&*('.split('').forEach((sh, i) => { CHARS['Digit' + i] = [String(i), sh]; });
Object.assign(CHARS, {
  Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'],
  Backquote: ['`', '~'], Space: [' ', ' '],
});

// kitty's legacy Ctrl table (kitty/keys.c ctrled_key); letters are handled before it
const CTRL = {
  ' ': '\x00', '@': '\x00', '2': '\x00', '3': '\x1b', '[': '\x1b', '4': '\x1c', '\\': '\x1c', '5': '\x1d', ']': '\x1d',
  '6': '\x1e', '^': '\x1e', '~': '\x1e', '7': '\x1f', '/': '\x1f', '_': '\x1f', '8': '\x7f', '?': '\x7f',
};
export function ctrlOf(ch) {
  const lower = ch.toLowerCase();
  if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
  return CTRL[ch] ?? ch;
}

const CSI = '\x1b[';
const CURSOR = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
const SS3_F = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };
const TILDE = { Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const CMD = { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' };

/** The keys this table covers, beyond CHARS. */
export const SPECIAL_CODES = ['Escape', 'Backspace', 'Tab', 'Enter', ...Object.keys(CURSOR), ...Object.keys(SS3_F), ...Object.keys(TILDE)];

/**
 * Bytes for one key press; '' when the key sends nothing (unknown key, or Cmd outside CMD).
 * @param {string} code  KeyboardEvent.code
 * @param {{shift?: boolean, alt?: boolean, ctrl?: boolean, meta?: boolean}} mods  alt = Option, meta = Cmd
 * @param {boolean} appCursor  DECCKM (application cursor keys) is on
 */
export function encode(code, { shift = false, alt = false, ctrl = false, meta = false } = {}, appCursor = false) {
  if (meta) return (!shift && !alt && !ctrl && CMD[code]) || '';
  const esc = alt ? '\x1b' : '';
  const pair = CHARS[code];
  if (pair) {
    const ch = pair[shift ? 1 : 0];
    return esc + (ctrl ? ctrlOf(ch) : ch);
  }
  switch (code) {
    case 'Escape': return esc + '\x1b';
    case 'Backspace': return esc + (ctrl ? '\x08' : '\x7f');
    case 'Tab': return esc + (shift ? CSI + 'Z' : '\t');
    case 'Enter': return esc + '\r';
  }
  const m = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  if (CURSOR[code]) return m > 1 ? `${CSI}1;${m}${CURSOR[code]}` : (appCursor ? '\x1bO' : CSI) + CURSOR[code];
  if (SS3_F[code]) return m > 1 ? `${CSI}1;${m}${SS3_F[code]}` : '\x1bO' + SS3_F[code];
  if (TILDE[code]) return m > 1 ? `${CSI}${TILDE[code]};${m}~` : `${CSI}${TILDE[code]}~`;
  return '';
}
