// The terminal's default colors (Tomorrow Night). A deployment brings its own in the relay config's "page" (served as
// site.json): "theme" is an xterm.js ITheme laid over this one, "terminal" any xterm.js options (lineHeight,
// cursorStyle, minimumContrastRatio...). A transparent background (alpha 00, with "allowTransparency": true) shows
// the page's own background behind the cells, e.g. a picture from custom.css; its RGB still matters, as
// minimumContrastRatio measures against it.
export const DEFAULT_THEME = {
  background: '#1d1f21',
  foreground: '#c5c8c6',
  cursor: '#c5c8c6',
  cursorAccent: '#1d1f21',
  selectionBackground: '#373b41',
  black: '#282a2e', red: '#cc6666', green: '#b5bd68', yellow: '#f0c674',
  blue: '#81a2be', magenta: '#b294bb', cyan: '#8abeb7', white: '#c5c8c6',
  brightBlack: '#969896', brightRed: '#d54e53', brightGreen: '#b9ca4a', brightYellow: '#e7c547',
  brightBlue: '#7aa6da', brightMagenta: '#c397d8', brightCyan: '#70c0b1', brightWhite: '#eaeaea',
};
