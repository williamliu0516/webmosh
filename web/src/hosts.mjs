// The hosts page, over the terminal: the computers on the tailnet as hosts for `mosh <name>` and `ssh <name>`
// (relay/hosts.go). The relay finds them in `tailscale status`; one is set up by running the line shown here on it, as
// the user the terminal should log in as, which installs webmosh-gate and the relay key's one authorized_keys line; the
// relay then logs in to check, and the row turns ready. Here too: names and aliases, the SSH port, a test, turning a
// host off, forgetting it. A computer off the tailnet (a VPS, say) is added by its address; its line is run on a
// tailnet computer that can ssh to it, and its row turns ready the same way. The prompt's `setup` opens it, and so does
// ?hosts in the address (the link in the relay's ntfy announcement of a new computer). The tabs underneath carry on; it
// talks to the relay's /api/hosts.
//
// createHostsPage({ onOpen, onClose }) -> { open(), close(), refresh(), isOpen }
//   onOpen(kind, name): a new tab to that host, 'ssh' or 'mosh' (the page has closed itself first)
//   onClose(): the page went away; the terminal may take the focus back

import { L } from './i18n.mjs';

const POLL_MS = 4000; // while open: a computer whose setup line just ran turns ready within this
const ARM_MS = 4000;  // Forget asks again for this long

// el('div', { class, onclick, value, disabled, ...attributes }, ...children): text children are text, never HTML
// (computer names come from Tailscale)
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'disabled') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  return put(e, ...kids);
}
// parent's children become kids, leaving out the false, null and empty ones that conditions leave behind
function put(parent, ...kids) {
  parent.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false && c !== ''));
  return parent;
}
const code = (s) => el('code', null, s);
function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}

async function api(path, body) {
  const r = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const text = await r.text();
  if (!r.ok) throw new Error(text.trim() || `HTTP ${r.status}`);
  return JSON.parse(text);
}

// an iPad app embedding the page writes the clipboard itself (window.hbShell, as for OSC 52)
async function copyText(text) {
  if (window.hbShell) window.hbShell.copy(text);
  else await navigator.clipboard.writeText(text);
}

function ago(iso, now) {
  if (!iso || iso.startsWith('0001')) return '';
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 2) return L('just now', '刚刚');
  if (m < 60) return L(`${m} min ago`, `${m} 分钟前`);
  if (m < 1440) return L(`${Math.floor(m / 60)} h ago`, `${Math.floor(m / 60)} 小时前`);
  return L(`${Math.floor(m / 1440)} days ago`, `${Math.floor(m / 1440)} 天前`);
}

// a host the relay found in `tailscale status`; the others (kind "wan") were added here by their address
const onTailnet = (h) => !h.kind || h.kind === 'tailnet';
// a wan host's address as ssh and the user write it: host, host:port, [v6]:port
const hostPort = (h) => (h.port ? `${h.ip.includes(':') ? `[${h.ip}]` : h.ip}:${h.port}` : h.ip);

const stateOf = (h) => (h.gone ? ['', L('Left the tailnet', '已不在')] : {
  ready: ['ok', L('Ready', '可用')],
  error: ['bad', L('Needs a look', '有问题')],
  pending: ['info', L('Waiting for its setup line', '等你运行设置命令')],
  new: ['warn', L('Not set up', '还没设置')],
  off: ['', L('Off', '已停用')],
}[h.state] || ['', h.state]);

export function createHostsPage({ onOpen, onClose }) {
  let root = null;
  let sub, statusEl, loading, noticeBox, targetsSec, targetsList, liveList, emptyNote, goneSec, goneList, wanSec, wanList, foot;
  let addAddress, addName, addBtn;
  let info = null;      // GET /api/hosts: { hosts, targets, relay, undo }
  let readError = '';   // the last GET failed
  let busy = '';        // '<node>:<action>' while a POST runs
  let notice = null;    // after Forget: what to run on that computer
  let timer = 0;
  let statusTimer = 0;
  let targetsDrawn = '';
  const rows = new Map(); // node -> hostRow

  // The page's parts are made once; each refresh fills them in and keeps the rows in place, so a name being typed
  // keeps its focus and a button being pressed is not swapped for another under the finger.
  function build() {
    sub = el('div', { class: 'sub' });
    statusEl = el('div', { class: 'status', role: 'status' });
    loading = el('p', { class: 'note' });
    noticeBox = el('div', { class: 'notice', hidden: true });
    targetsList = el('div');
    targetsSec = el('section', { hidden: true }, el('h3', null, L("In the relay's config", '中继配置里的主机')), targetsList);
    liveList = el('div');
    emptyNote = el('p', { class: 'note', hidden: true }, L(
      'No other computers on the tailnet yet (phones and tablets are not listed). Install Tailscale on one, signed in with the same account, and it shows up here within a minute.',
      'tailnet 上还没有别的电脑（手机和平板不算）。在一台电脑上装好 Tailscale、登录同一个账号，一分钟内就会出现在这里。'));
    goneList = el('div');
    goneSec = el('section', { class: 'gone', hidden: true }, el('h3', null, L('No longer on the tailnet', '已不在 tailnet 上')), goneList);
    // computers off the tailnet: added by their address
    const typing = { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' };
    addAddress = el('input', { ...typing, placeholder: 'you@vps.example.com:2222' });
    addName = el('input', { ...typing, placeholder: L('e.g. vps', '比如 vps') });
    addBtn = el('button', { class: 'btn primary', onclick: add }, L('Add', '添加'));
    for (const i of [addAddress, addName]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    wanList = el('div');
    wanSec = el('section', { class: 'wan' }, el('h3', null, L('Off the tailnet', '不在 tailnet 上的电脑')), wanList,
      el('div', { class: 'edit add' },
        el('div', { class: 'fields two' },
          el('label', null, L('Address (user@host, port if not 22)', '地址（用户@主机，端口不是 22 时加上）'), addAddress),
          el('label', null, L('Name', '名字'), addName)),
        el('div', { class: 'acts' }, addBtn),
        el('p', { class: 'note' }, L(
          'A computer the relay reaches by its public address, such as a VPS. The user is the one the terminal logs in as (not root). Its setup line runs on a computer of the tailnet that can already ssh to it. Its firewall must let in its SSH port, and UDP 60000–61000 for mosh.',
          '中继按公网地址连的电脑，比如 VPS。用户就是终端登录用的那个（不能是 root）。它的设置命令在一台已经能 ssh 到它的 tailnet 电脑上运行。它的防火墙要放行 SSH 端口，以及 mosh 用的 UDP 60000–61000。'))));
    foot = el('p', { class: 'note foot' }, L(
      "The relay logs in with a key of its own. On each computer that key's one line in authorized_keys allows no forwarding and runs only webmosh-gate: a shell, mosh-server, ending its own mosh-server, and keeping a file you send. On the tailnet's computers the line takes connections from the relay only; on one off the tailnet it takes them from anywhere, since the relay's public address may change, so there the relay's key alone keeps others out. In the terminal, hosts lists every host you can reach.",
      '中继用自己的一把密钥登录。每台电脑的 authorized_keys 里，这把密钥那一行不许任何转发，而且只能运行 webmosh-gate：打开 shell、启动 mosh-server、结束自己的 mosh-server、存下你传的文件。tailnet 上的电脑只接受来自中继的连接；不在 tailnet 上的电脑不限来源（中继的公网地址会变），只靠中继的密钥把别人挡在外面。终端里 hosts 列出所有能连的主机。'));
    const card = el('div', { class: 'card', tabindex: '-1' },
      el('div', { class: 'head' },
        el('div', null, el('h2', null, L('Hosts', '终端主机')), sub),
        el('button', { class: 'btn ghost close', 'aria-label': L('Close', '关闭'), onclick: close }, '×')),
      statusEl,
      el('div', { class: 'body' }, loading, noticeBox, targetsSec,
        el('section', null, el('h3', null, L('Computers on your tailnet', 'tailnet 上的电脑')), liveList, emptyNote),
        wanSec, goneSec, foot));
    root = el('div', {
      id: 'hosts', role: 'dialog', 'aria-modal': 'true', 'aria-label': L('Hosts', '终端主机'), hidden: true,
      onclick: (e) => { if (e.target === root) close(); },
      onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } },
    }, card);
    document.body.append(root);
  }

  function say(text) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    if (text) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 10000);
  }

  async function refresh() {
    if (!root || root.hidden) return;
    try {
      info = await api('api/hosts');
      readError = '';
    } catch (e) {
      readError = e instanceof TypeError ? L('Cannot reach the relay.', '连不上中继。') : e.message;
    }
    render();
  }

  // a POST to the hosts API; the list comes back (or is read again) and the page redraws
  async function run(key, path, payload, what) {
    if (busy) return null;
    busy = key;
    render();
    let reply = null;
    try {
      reply = await api(path, payload);
      if (reply.hosts && info) info.hosts = reply.hosts;
      say('');
    } catch (e) {
      say(L(`${what} failed: `, `${what}失败：`) + (e instanceof TypeError ? L('cannot reach the relay', '连不上中继') : e.message));
    }
    busy = '';
    await refresh();
    return reply;
  }

  const go = (kind, name) => { close(); onOpen(kind, name); };

  // a computer off the tailnet: the relay adds it with a setup line at once, which its row then shows
  async function add() {
    const address = addAddress.value.trim();
    if (!address) { say(L('Type its address first.', '先填地址。')); addAddress.focus(); return; }
    const reply = await run('add', 'api/hosts/add', { address, name: addName.value.trim().toLowerCase() }, L('Adding', '添加'));
    // the button was disabled while it ran, which drops the focus out of the page (and Escape with it)
    if (reply) { addAddress.value = ''; addName.value = ''; root.querySelector('.card').focus({ preventScroll: true }); }
    else addAddress.focus();
  }
  function setNotice(n) { notice = n; noticeBox.replaceChildren(); render(); }

  // parent's element children become nodes, in order, moving only what is out of place
  function place(parent, nodes) {
    nodes.forEach((n, i) => { if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] || null); });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  }

  function render() {
    if (!root) return;
    const now = Date.now();
    loading.hidden = !!info;
    for (const part of [targetsSec, goneSec, wanSec, foot, noticeBox, emptyNote, liveList.parentElement]) part.hidden = !info;
    if (!info) {
      sub.textContent = '';
      loading.textContent = readError || L('Reading the hosts…', '正在读取主机…');
      return;
    }
    const all = info.hosts || [];
    const hosts = all.filter(onTailnet);
    const wan = all.filter((h) => h.kind === 'wan');
    const live = hosts.filter((h) => !h.gone);
    const gone = hosts.filter((h) => h.gone);
    const ready = live.filter((h) => h.state === 'ready').length;
    const unset = live.filter((h) => ['new', 'pending', 'error'].includes(h.state)).length;
    sub.textContent = [
      L(`${live.length} ${live.length === 1 ? 'computer' : 'computers'} on the tailnet`, `tailnet 上 ${live.length} 台电脑`),
      L(`${ready} ready`, `${ready} 台可用`),
      unset && L(`${unset} not set up`, `${unset} 台还没设置好`),
      wan.length && L(`${wan.length} off the tailnet`, `另有 ${wan.length} 台不在 tailnet 上`),
      readError,
    ].filter(Boolean).join(' · ');

    noticeBox.hidden = !notice;
    if (notice && !noticeBox.firstChild) {
      put(noticeBox, el('p', null, notice.text), setupLine(notice.command, null),
        el('button', { class: 'btn ghost', onclick: () => setNotice(null) }, L('Done', '知道了')));
    }

    const targets = info.targets || [];
    const drawn = JSON.stringify(targets);
    if (drawn !== targetsDrawn) { targetsDrawn = drawn; targetsList.replaceChildren(...targets.map(targetRow)); }
    targetsSec.hidden = !targets.length;

    for (const node of [...rows.keys()]) if (!all.some((h) => h.node === node)) rows.delete(node);
    const rowOf = (h) => {
      let r = rows.get(h.node);
      if (!r) rows.set(h.node, (r = hostRow(h.node, h.kind === 'wan')));
      r.update(h, now);
      return r.root;
    };
    place(liveList, live.map(rowOf));
    emptyNote.hidden = live.length > 0;
    place(goneList, gone.map(rowOf));
    goneSec.hidden = !gone.length;
    place(wanList, wan.map(rowOf));
    addBtn.disabled = !!busy;
    addBtn.textContent = busy === 'add' ? '…' : L('Add', '添加');
  }

  function targetRow(t) {
    const names = [t.id, ...(t.aliases || [])].join(', ');
    return el('div', { class: 'row' },
      el('div', { class: 'top' },
        el('span', { class: 'name' }, el('b', null, t.name || t.id)),
        el('span', { class: 'acts' },
          t.ssh && el('button', { class: 'btn primary', onclick: () => go('ssh', t.id) }, 'ssh'),
          t.mosh && el('button', { class: t.ssh ? 'btn' : 'btn primary', onclick: () => go('mosh', t.id) }, 'mosh'))),
      el('div', { class: 'meta' }, L('Names: ', '名字：'), code(names), ' · ', [t.mosh && 'mosh', t.ssh && 'ssh'].filter(Boolean).join(' / ')));
  }

  // the setup line (or an undo line) with a copy button; expiry: when the line stops working
  function setupLine(command, expiry, copied = { until: 0 }) {
    const btn = el('button', { class: 'btn' }, Date.now() < copied.until ? L('Copied', '已复制') : L('Copy', '复制'));
    const text = code(command);
    btn.addEventListener('click', async () => {
      try {
        await copyText(command);
        copied.until = Date.now() + 1500;
        btn.textContent = L('Copied', '已复制');
        setTimeout(() => { btn.textContent = L('Copy', '复制'); }, 1500);
      } catch {
        // Safari may refuse: select the line for the system's own copy
        getSelection()?.selectAllChildren(text);
        say(L('Copying was refused: the line is selected, copy it yourself.', '复制被拒绝：命令已选中，请手动复制。'));
      }
    });
    return el('div', { class: 'cmd' }, text, btn,
      expiry && el('span', { class: 'until' }, L(`valid until ${expiry}`, `${expiry} 前有效`)));
  }

  // One computer, of the tailnet or (wan) off it. The view is drawn again on each update; the edit box below it (name,
  // aliases, port, a wan host's address) is built once, so an update every few seconds leaves what is being typed there
  // alone.
  function hostRow(node, wan) {
    let h = null;
    let more = false;
    let armedUntil = 0;
    const copied = { until: 0 };
    const view = el('div');
    const name = el('input', { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    const aliases = el('input', { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: L('e.g. studio mac', '比如 studio mac') });
    const port = el('input', { inputmode: 'numeric', placeholder: '22' });
    const address = el('input', { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    let dirty = false;
    for (const i of [name, aliases, port, address]) {
      i.addEventListener('input', () => { dirty = true; });
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    }
    const acts = el('div', { class: 'acts' });
    const notes = el('div');
    const box = el('div', { class: 'edit', hidden: true },
      el('div', { class: 'fields' },
        wan && el('label', { class: 'address' }, L('Address', '地址'), address),
        el('label', null, L('Name', '名字'), name),
        el('label', null, L('Aliases', '别名'), aliases),
        el('label', { class: 'port' }, L('SSH port', 'SSH 端口'), port)),
      acts, notes);
    const root = el('div', { class: 'row' }, view, box);
    const b = () => busy.startsWith(node + ':');
    const act = (what, path, payload, label) => run(`${node}:${what}`, path, { node, ...payload }, label);

    async function save() {
      if (b()) return;
      const p = port.value.trim();
      if (p && !/^\d+$/.test(p)) { say(L('The SSH port is a number.', 'SSH 端口要填数字。')); return; }
      const reply = await act('save', 'api/hosts/update', {
        name: name.value.trim().toLowerCase(),
        aliases: aliases.value.split(/[\s,，]+/).filter(Boolean).map((a) => a.toLowerCase()),
        port: p ? Number(p) : 0,
        ...(wan && { address: address.value.trim() }),
      }, L('Saving', '保存'));
      if (reply) { dirty = false; if (h) fill(); }
    }
    function fill() {
      name.value = h.name;
      aliases.value = (h.aliases || []).join(' ');
      port.value = h.port ? String(h.port) : '';
      address.value = h.ip;
    }

    let drawn = '';
    function update(next, now) {
      h = next;
      if (!dirty) fill();
      // drawn again only when something shown changed (the minute: "5 min ago")
      const key = JSON.stringify([h, busy.startsWith(node + ':') && busy, more, Date.now() < armedUntil, Date.now() < copied.until, Math.floor(now / 60000)]);
      if (key === drawn) return;
      drawn = key;
      const [dot, word] = stateOf(h);
      const short = h.aliases?.[0] || h.name; // what to type: the first alias if it has one
      const setupBtn = !h.gone && ['new', 'error', 'pending'].includes(h.state) &&
        el('button', { class: h.state === 'pending' ? 'btn' : 'btn primary', disabled: b(), onclick: () => act('setup', 'api/hosts/setup', {}, L('Getting a setup line', '获取设置命令')) },
          busy === `${node}:setup` ? '…' : h.state === 'pending' ? L('New line', '新的命令') : L('Set up', '设置'));
      put(view,
        el('div', { class: 'top' },
          // a wan host's display is its address, which the line under it shows: its title is the name it was given
          el('span', { class: 'name' }, el('b', null, wan ? h.name : h.display || h.name), h.state === 'new' && !h.gone && !wan && el('span', { class: 'badge' }, L('new', '新'))),
          el('span', { class: 'state' }, el('i', { class: `dot ${dot}` }), word),
          el('span', { class: 'acts' },
            h.state === 'ready' && !h.gone && [
              el('button', { class: 'btn primary', onclick: () => go('ssh', h.name) }, 'ssh'),
              h.mosh_server && el('button', { class: 'btn', onclick: () => go('mosh', h.name) }, 'mosh'),
            ],
            setupBtn,
            h.state === 'off' && !h.gone && el('button', { class: 'btn', disabled: b(), onclick: () => act('on', 'api/hosts/update', { off: false }, L('Turning on', '启用')) }, L('Turn on', '启用')),
            el('button', {
              class: `btn ghost more${more ? ' open' : ''}`, 'aria-expanded': String(more), 'aria-label': L('More', '更多'),
              onclick: () => { more = !more; update(h, Date.now()); },
            }, chevron()))),
        el('div', { class: 'meta' },
          wan ? [hostPort(h), ago(h.checked, now) && L(`checked ${ago(h.checked, now)}`, `${ago(h.checked, now)}检查过`)].filter(Boolean).join(' · ')
            : [h.os, h.ip, h.gone ? '' : h.online ? L('online', '在线') : [L('offline', '离线'), ago(h.last_seen, now)].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
          h.state === 'ready' && [
            L(' · logs in as ', ' · 登录为 '), el('b', null, h.user),
            L(' · type ', ' · 终端里 '), code(`ssh ${short}`),
            h.mosh_server ? [' / ', code(`mosh ${short}`)] : L(' (no mosh there)', '（没装 mosh）'),
          ]),
        h.shadowed?.length > 0 && el('div', { class: 'meta' }, L('Names count per protocol: ', '名字按协议分开算：'),
          h.shadowed.map((x, i) => {
            const [cmd, who] = x.split(' → ');
            return [i ? L('; ', '；') : '', code(cmd), L(' reaches ', ' 连的是 '), who];
          })),
        h.state === 'error' && h.error && el('div', { class: 'err' }, h.error),
        h.setup && el('div', { class: 'setup' },
          setupLine(h.setup, h.setup_expiry && new Date(h.setup_expiry).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), copied),
          el('p', { class: 'note' }, wan ? L(
            `Run it in a terminal on a computer of the tailnet that can ssh to ${hostPort(h)} (the relay's, your laptop). The script goes there through your own ssh, so your known_hosts vouches for the SSH host key it reports, and changes only that user's ~/.ssh/authorized_keys (one line, taking connections from anywhere: the relay's public address may change; the old file is kept as authorized_keys.webmosh-bak) and ~/.local/bin/webmosh-gate. What it finds comes back through the same pipe, and the relay logs in to check. Its firewall must let in the SSH port, and UDP 60000–61000 for mosh.`,
            `在一台能 ssh 到 ${hostPort(h)} 的 tailnet 电脑（中继这台、你的笔记本）的终端里运行。脚本经你自己的 ssh 过去，它报告的 SSH 主机密钥由你的 known_hosts 担保；它只改那个用户的 ~/.ssh/authorized_keys（加一行，不限来源，因为中继的公网地址会变；旧文件备份为 authorized_keys.webmosh-bak）和 ~/.local/bin/webmosh-gate。结果经同一条管道交回中继，中继随即登录检查。它的防火墙要放行 SSH 端口，以及 mosh 用的 UDP 60000–61000。`) : L(
            `Run it in a terminal on ${h.display || h.name}, as the user the terminal should log in as. It changes only that user's ~/.ssh/authorized_keys (one line; the old file is kept as authorized_keys.webmosh-bak) and ~/.local/bin/webmosh-gate, tells the relay the computer's SSH host key and where mosh-server is, and the relay logs in to check. On a Mac, turn on Remote Login first (System Settings › General › Sharing).`,
            `在 ${h.display || h.name} 的终端里，用终端要登录的那个用户运行。它只改这个用户的 ~/.ssh/authorized_keys（加一行，旧文件备份为 authorized_keys.webmosh-bak）和 ~/.local/bin/webmosh-gate，把这台电脑的 SSH 主机密钥和 mosh-server 的位置告诉中继，中继随即登录检查。Mac 要先打开「远程登录」（系统设置 › 通用 › 共享）。`))),
      );

      box.hidden = !more;
      if (!more) return;
      const armed = Date.now() < armedUntil;
      put(acts,
        el('button', { class: 'btn primary', disabled: b(), onclick: save }, busy === `${node}:save` ? '…' : L('Save', '保存')),
        h.host_key && el('button', { class: 'btn', disabled: b(), onclick: () => act('test', 'api/hosts/test', {}, L('Testing', '测试')) },
          busy === `${node}:test` ? L('Logging in…', '正在登录…') : L('Test', '测试')),
        h.state === 'ready' && el('button', { class: 'btn', disabled: b(), onclick: () => act('setup', 'api/hosts/setup', {}, L('Getting a setup line', '获取设置命令')) }, L('Set up again', '重新设置')),
        h.state !== 'off' && !h.gone && el('button', { class: 'btn', disabled: b(), onclick: () => act('off', 'api/hosts/update', { off: true }, L('Turning off', '停用')) },
          h.state === 'new' && !wan ? L("Don't set up", '不设置') : L('Turn off', '停用')),
        (h.state !== 'new' || h.gone || wan) && el('button', {
          class: `btn${armed ? ' danger' : ''}`, disabled: b(),
          onclick: async () => {
            if (Date.now() >= armedUntil) {
              armedUntil = Date.now() + ARM_MS;
              update(h, Date.now());
              setTimeout(() => { if (h) update(h, Date.now()); }, ARM_MS);
              return;
            }
            armedUntil = 0;
            const reply = await act('forget', 'api/hosts/forget', {}, L('Forgetting', '忘掉'));
            if (reply?.undo) {
              more = false;
              setNotice({
                text: L(`The relay no longer uses ${h.display || h.name}. To take its key off that computer too, run this there:`,
                  `中继不再用 ${h.display || h.name} 了。要把它的密钥也从那台电脑上删掉，在那里运行：`),
                command: reply.undo,
              });
            }
          },
        }, armed ? L('Forget? Press again', '确认忘掉？再按一次') : L('Forget', '忘掉')),
      );
      put(notes,
        h.mosh_version && el('p', { class: 'note' }, [h.system, h.shell, h.mosh_version].filter(Boolean).join(' · ')),
        h.state === 'new' && !h.gone && !wan && el('p', { class: 'note' }, L(
          "Not a computer for the terminal (a family member's, say)? Don't set up, and it no longer counts as new.",
          '不打算让终端连这台电脑（比如家人的）：点「不设置」，它就不再算作新电脑。')),
        wan ? el('p', { class: 'note' }, L(
          'Forget: the relay takes it off this list (add it again to use it). The key stays on the computer until you run this there:',
          '忘掉：中继把它从列表里删掉（要再用就重新添加）。密钥还留在那台电脑上，要删掉就在那里运行：'))
          : h.state !== 'new' && el('p', { class: 'note' }, L(
            'Forget: the relay stops using it and drops its setup (it counts as new again). The key stays on the computer until you run this there:',
            '忘掉：中继不再用它，也丢掉它的设置（它又算作新电脑）。密钥还留在那台电脑上，要删掉就在那里运行：')),
        (h.state !== 'new' || wan) && info?.undo && setupLine(info.undo, null),
      );
    }
    return { root, update };
  }

  function open() {
    if (!root) build();
    if (!root.hidden) return;
    root.hidden = false;
    render();
    root.querySelector('.card').focus();
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    clearInterval(timer);
    notice = null;
    noticeBox.replaceChildren();
    // opened again, it starts afresh: edit boxes shut, what was typed and not saved gone
    rows.clear();
    addAddress.value = '';
    addName.value = '';
    liveList.replaceChildren();
    goneList.replaceChildren();
    wanList.replaceChildren();
    // a reload should not open it again
    const url = new URL(location.href);
    if (url.searchParams.has('hosts')) {
      url.searchParams.delete('hosts');
      history.replaceState(history.state, '', url);
    }
    onClose();
  }

  return { open, close, refresh, get isOpen() { return !!root && !root.hidden; } };
}
