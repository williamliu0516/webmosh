// The page's own prompt, like Blink's local shell: between sessions the terminal shows `webmosh>`
// and takes a few commands; `mosh <host>` then runs mosh from this page (the WASM client) straight
// to that host's mosh-server, with the relay only forwarding datagrams. `ssh <host>` is a terminal
// the relay holds (relay/pty.go): images and scrollback, and it survives a reload. The hosts are the
// relay's targets and the tailnet computers set up on the hosts page.
//
// createPrompt({ term, hosts, onMosh, onSsh, onExit, visible }) -> { show(), hide(), repaint(), handle(data), active }
//   hosts(): [{ id, name, aliases, mosh, ssh }] from the relay (hello, then 'hosts' updates)
//   onMosh(id, name) / onSsh(id, name): start a session (name as typed); the prompt is inactive until show()
//   onExit(): `exit` / Ctrl-D on an empty line (closes the tab, or the panel hides the terminal)
//   visible(): whether this prompt's tab is on screen (tabs.mjs); a hidden one keeps its state and
//     draws nothing until repaint()

import { L } from './i18n.mjs';

const PROMPT = '\x1b[1;32mwebmosh\x1b[0m> ';
const COMMANDS = ['mosh', 'ssh', 'hosts', 'help', 'clear', 'exit'];
const HISTORY_KEY = 'webmosh.history';
const HISTORY_MAX = 200;

// Modes a session may have left on (mosh puts the local terminal in application cursor mode;
// the remote may have turned on the mouse or bracketed paste): back to plain for the prompt.
const RESET_MODES = '\x1b[0m\x1b[?1l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l';

export function createPrompt({ term, hosts, onMosh, onSsh, onExit, visible = () => true }) {
  let line = '';
  let active = false;
  let notice = ''; // the last show() message, drawn again by repaint()
  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { /* storage off */ }
  let hpos = history.length; // == history.length: editing a new line
  let draft = '';

  const write = (s) => { if (visible()) term.write(s); };
  const redraw = () => write(`\r\x1b[K${PROMPT}${line}`);

  function show(message) {
    active = true;
    line = '';
    hpos = history.length;
    notice = message || '';
    write(RESET_MODES);
    if (visible() && term.buffer.active.cursorX !== 0) write('\r\n');
    if (message) write(`\x1b[2m${message}\x1b[0m\r\n`);
    write(PROMPT);
  }

  // The tab came back on screen (the terminal was just reset): the last message, the prompt and the line being typed.
  function repaint() {
    if (!active) return;
    write(RESET_MODES);
    if (notice) write(`\x1b[2m${notice}\x1b[0m\r\n`);
    write(PROMPT + line);
  }

  // Names are unique per protocol (`mosh box` and `ssh box` may be different hosts): the first host in the relay's
  // order that answers to the name and has that protocol, which is the one the relay resolves the name to.
  function find(name, kind) {
    const n = name.toLowerCase();
    const has = (h) => (kind === 'ssh' ? h.ssh : h.mosh !== false);
    return hosts().find((h) => has(h) && (h.id.toLowerCase() === n || (h.aliases || []).some((a) => a.toLowerCase() === n)));
  }

  function hostList() {
    const list = hosts();
    if (!list.length) return L('Not connected to the relay yet; try again in a moment.', '中继还没连上，稍等再试。');
    const kinds = (h) => [h.mosh !== false && 'mosh', h.ssh && 'ssh'].filter(Boolean).join(' ');
    return list.map((h) => `  ${[h.id, ...(h.aliases || [])].join(', ').padEnd(24)} ${kinds(h).padEnd(9)} ${h.name}`).join('\r\n');
  }

  function remember(cmd) {
    if (!cmd || history[history.length - 1] === cmd) return;
    history.push(cmd);
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* storage off */ }
  }

  function run(cmd) {
    notice = '';
    write('\r\n');
    remember(cmd);
    const [verb, arg, ...extra] = cmd.split(/\s+/).filter(Boolean);
    const out = (s) => write(s.replace(/\n/g, '\r\n') + '\r\n');
    switch (verb) {
      case undefined:
        break;
      case 'mosh': {
        const h = arg && find(arg, 'mosh');
        if (!arg) out(L('Usage: mosh <host>. The hosts: hosts.', '用法：mosh 主机。主机见 hosts。'));
        else if (!h && find(arg, 'ssh')) out(L(`${arg} has no mosh; use ssh ${arg}.`, `${arg} 没装 mosh，用 ssh ${arg}。`));
        else if (!h) out(L(`No host called ${arg}. The hosts:\n${hostList()}`, `没有叫 ${arg} 的主机。主机：\n${hostList()}`));
        else if (extra.length) out(L('mosh here takes a host name only (no options, no remote command).', '这里的 mosh 只接主机名（选项和远端命令都不支持）。'));
        else { active = false; onMosh(arg.toLowerCase(), arg); return; }
        break;
      }
      case 'ssh': {
        const name = arg ? arg.replace(/^[^@]*@/, '') : '';
        const h = name && find(name, 'ssh');
        if (!arg) out(L('Usage: ssh <host>. The hosts: hosts.', '用法：ssh 主机。主机见 hosts。'));
        else if (!h && find(name, 'mosh')) out(L(`${name} takes mosh only (its key may only start mosh-server). Set it up on the hosts page for ssh.`,
          `${name} 只能 mosh（它的密钥只许启动 mosh-server）。在终端主机页设置它，ssh 就能用。`));
        else if (!h) out(L(`No host called ${name}. The hosts:\n${hostList()}\nA new computer shows up here once it is set up on the hosts page.`,
          `没有叫 ${name} 的主机。主机：\n${hostList()}\n新电脑在终端主机页设置一次就会出现在这里。`));
        else if (extra.length || arg.includes('@')) out(L('ssh here takes a host name only (the user is set on the hosts page; no options, no remote command).',
          '这里的 ssh 只接主机名（用户在终端主机页设置，选项和远端命令都不支持）。'));
        else { active = false; onSsh(name.toLowerCase(), name); return; }
        break;
      }
      case 'hosts':
      case 'ls':
        out(hostList());
        break;
      case 'help':
      case '?':
        out(L('mosh <host>   connect with mosh (hosts lists them)\n'
          + 'ssh <host>    connect with ssh: images and scrollback, and it survives a page reload\n'
          + 'hosts         list the hosts (a new computer is set up on the hosts page)\nclear         clear the screen (also Ctrl-L)\n'
          + 'exit          close this tab; the last one goes back to the panel (also Ctrl-D on an empty line)\n'
          + 'Up / Down for history, Tab completes commands and host names.\n'
          + 'Tabs: Cmd+Shift+T new, Cmd+Shift+W close (Cmd+W closes the whole app in a kiosk), Cmd+Shift+Left / Right (or [ / ])\n'
          + '      previous / next, Cmd+1…8 that tab, Cmd+9 the last; or click the tab bar, with one tab the + in the corner.\n'
          + 'Panel: embedded in a panel, Cmd+Shift+H hides the terminal (tabs and connections stay); again on the panel brings it back.\n'
          + 'Photos and files: in a session, Cmd+Shift+I picks photos or files, Cmd+V pastes a picture, or drop them in;\n'
          + '      they go to ~/Downloads/webmosh/ on that computer and the path is pasted at the cursor (Claude Code attaches it).\n'
          + 'Keyboard bar: the iPad\'s bar at the bottom is off by default, Cmd+Shift+K turns it on or off. Ctrl+Space switches\n'
          + '      input sources (the bar shows for a moment; with the bar off the Globe key does nothing).',
        'mosh 主机   用 mosh 连到主机（主机见 hosts）\n'
          + 'ssh 主机    用 ssh 连到主机：能看图片和滚动历史，页面重新加载也不断\n'
          + 'hosts       列出主机（新电脑在终端主机页设置）\nclear       清屏（也可以 Ctrl-L）\n'
          + 'exit        关掉这个标签；只剩一个时回到面板（也可以在空行按 Ctrl-D）\n'
          + '上下键翻历史，Tab 补全命令和主机名。\n'
          + '标签：Cmd+Shift+T 新开，Cmd+Shift+W 关闭（Cmd+W 会关掉整个 app），Cmd+Shift+← / →（或 [ / ]）前后切换，Cmd+1…8 第几个，Cmd+9 最后一个；\n'
          + '      也可以点上面的标签栏，只有一个标签时点角上的 +。\n'
          + '面板：嵌在面板里时 Cmd+Shift+H 收起终端（标签和连接都留着），在面板上再按一次就回来。\n'
          + '照片和文件：连着主机时 Cmd+Shift+I 选照片或文件，Cmd+V 粘贴剪贴板里的图片，或者直接拖进来；\n'
          + '      文件存到那台电脑的 ~/Downloads/webmosh/，路径粘贴在光标处（Claude Code 会把它当成附图）。\n'
          + '键盘栏：iPad 底部那条栏默认关着，Cmd+Shift+K 开或关。Ctrl+空格 切换中英文（栏会亮一下再自己关掉；\n'
          + '      栏关着时地球仪键不起作用）。'));
        break;
      case 'clear':
        write('\x1b[H\x1b[2J');
        break;
      case 'exit':
      case 'logout':
        onExit();
        break;
      default:
        out(L(`webmosh: no command ${verb}. The commands: ${COMMANDS.join(', ')}.`, `webmosh: 没有 ${verb} 这个命令。可以用 ${COMMANDS.join('、')}。`));
    }
    line = '';
    hpos = history.length;
    write(PROMPT);
  }

  function complete() {
    const words = line.split(' ');
    const last = words[words.length - 1];
    let pool;
    if (words.length === 1) pool = COMMANDS;
    else if (words.length === 2 && (words[0] === 'mosh' || words[0] === 'ssh')) pool = hosts().flatMap((h) => [h.id, ...(h.aliases || [])]);
    else return;
    const hits = pool.filter((w) => w.startsWith(last));
    if (hits.length === 1) {
      const add = hits[0].slice(last.length) + ' ';
      line += add;
      write(add);
    } else if (hits.length > 1) {
      let common = hits[0];
      for (const h of hits) while (!h.startsWith(common)) common = common.slice(0, -1);
      if (common.length > last.length) {
        line += common.slice(last.length);
        redraw();
      } else {
        write(`\r\n${hits.join('  ')}\r\n`);
        redraw();
      }
    }
  }

  function recall(delta) {
    if (!history.length) return;
    if (hpos === history.length) draft = line;
    hpos = Math.max(0, Math.min(history.length, hpos + delta));
    line = hpos === history.length ? draft : history[hpos];
    redraw();
  }

  // Data from xterm (keys or a paste). Arrows may come as CSI or SS3 (application cursor mode).
  function handle(data) {
    if (!active) return;
    let s = data.replace(/\x1b\[20[01]~/g, ''); // bracketed paste markers
    while (s.length) {
      const esc = /^\x1b(?:\[|O)([0-9;]*)([A-Za-z~])/.exec(s);
      if (esc) {
        if (esc[2] === 'A') recall(-1);
        else if (esc[2] === 'B') recall(1);
        s = s.slice(esc[0].length);
        continue;
      }
      const ch = s[0];
      s = s.slice(1);
      if (ch === '\r' || ch === '\n') {
        const cmd = line.trim();
        run(cmd);
        if (!active) return; // a session took over; the rest of a paste is not for the prompt
      } else if (ch === '\x7f' || ch === '\b') {
        if (line.length) {
          const cut = [...line].slice(0, -1).join('');
          const gone = line.slice(cut.length);
          line = cut;
          // a wide character takes two cells
          write(/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(gone) ? '\b\b  \b\b' : '\b \b');
        }
      } else if (ch === '\t') {
        complete();
      } else if (ch === '\x03') { // Ctrl-C
        write('^C\r\n');
        line = '';
        hpos = history.length;
        write(PROMPT);
      } else if (ch === '\x15') { // Ctrl-U
        line = '';
        redraw();
      } else if (ch === '\x0c') { // Ctrl-L
        write('\x1b[H\x1b[2J');
        redraw();
      } else if (ch === '\x04') { // Ctrl-D
        if (!line) { write('\r\n'); onExit(); write(PROMPT); }
      } else if (ch === '\x1b') {
        // a lone Escape (or an Alt combination): nothing to do at the prompt
      } else if (ch >= ' ') {
        line += ch;
        write(ch);
      }
    }
  }

  // a session takes the tab without a typed command (the panel's hosts sheet): stop taking keys until show()
  function hide() { active = false; }

  // line: what is typed so far (the page leaves a tab with a half-typed command alone)
  return { show, hide, repaint, handle, get active() { return active; }, get line() { return line; } };
}
