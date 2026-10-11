// ?keytest: a guided sweep of the iPad's Magic Keyboard, on the device itself.
//
// The page opens no session in this mode. A panel asks for one key (with its modifiers) at a time,
// in keyboard order, and grades what the page would have sent against keys.mjs. Each graded press
// goes to the relay's journal as a "keytest" line (through the keylog message), with the raw
// events for anything that failed, so the results can be read on the relay's computer:
//   journalctl -u webmosh-relay | grep keytest
// A press with the wrong key or wrong modifiers is not graded (it is most likely a slip); it is
// reported as MISS and the step waits. Keys iPadOS keeps for itself never reach the page: Skip.
// The keyboard has no fn key (the Globe key's arrows are iPadOS shortcuts), so there is no fn group.
import { encode } from './keys.mjs';
// imported by app.mjs after the language is set, so L works at this module's top level too
import { L } from './i18n.mjs';

const ROWS = [
  [['Escape', 'esc']],
  [['Backquote', '`'], ...'1234567890'.split('').map((d) => ['Digit' + d, d]), ['Minus', '-'], ['Equal', '='], ['Backspace', 'delete']],
  [['Tab', 'tab'], ...'QWERTYUIOP'.split('').map((c) => ['Key' + c, c]), ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\']],
  [...'ASDFGHJKL'.split('').map((c) => ['Key' + c, c]), ['Semicolon', ';'], ['Quote', "'"], ['Enter', 'return']],
  [...'ZXCVBNM'.split('').map((c) => ['Key' + c, c]), ['Comma', ','], ['Period', '.'], ['Slash', '/']],
  [['Space', 'space'], ['ArrowLeft', '←'], ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowRight', '→']],
];
const LABEL = Object.fromEntries(ROWS.flat());
const ALL = ROWS.flat().map(([code]) => code);
const GROUPS = [
  { id: 'plain', name: L('No modifier', '无修饰'), mods: {} },
  { id: 'shift', name: 'Shift', mods: { shift: true } },
  { id: 'opt', name: 'Option', mods: { alt: true } },
  { id: 'optshift', name: 'Option+Shift', mods: { alt: true, shift: true } },
  { id: 'ctrl', name: 'Control', mods: { ctrl: true } },
  { id: 'ctrlshift', name: 'Control+Shift', mods: { ctrl: true, shift: true } },
  { id: 'ctrlopt', name: 'Control+Option', mods: { ctrl: true, alt: true } },
  // not Cmd+Tab (app switcher) or Cmd+W/T/L/R (Safari); the rest of Cmd should send nothing
  { id: 'cmd', name: 'Command', mods: { meta: true }, codes: ['ArrowLeft', 'ArrowRight', 'Backspace', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'KeyK', 'KeyJ'] },
];
// What the 2026-10-08 run found: Pinyin-mode digits sent nothing, and a dead key that iPadOS sends
// as a bare composition (no keydown, no keyup) worked once and then never again. The dead keys come
// several times in a row on purpose. Ctrl+I and Ctrl+Return never reached the page then.
const IME_NOTE = L('Switch to Pinyin input, type no letters, just press this key', '切到拼音输入法，不打字母，直接按这个键');
const ABC_NOTE = L('Switch back to ABC (English) input', '切回 ABC（英文）输入法');
const NO_REACTION = L('If nothing happens, press Skip', '没反应就点跳过');
GROUPS.unshift({ id: 'retest', name: L('Retest', '复测'), steps: [
  ...['Digit1', 'Digit2', 'Digit3', 'Backquote', 'Comma', 'Period'].map((code) => ({ code, label: L(`${LABEL[code]} in Pinyin`, `拼音下 ${LABEL[code]}`), ime: true, note: IME_NOTE })),
  { code: 'Space', label: L('Pinyin ni, then space', '拼音打 ni 再按空格'), anyText: true, note: L('In Pinyin input type ni, then space to commit 你', '拼音输入法下打 ni，按空格上屏「你」') },
  ...[['Backquote', 3], ['KeyU', 3], ['KeyE', 2], ['KeyI', 2], ['KeyN', 2]].flatMap(([code, n]) => Array.from({ length: n }, () => (
    { code, mods: { alt: true }, label: `Option + ${LABEL[code]}`, want: encode(code, { alt: true }), note: ABC_NOTE }))),
  { code: 'KeyH', mods: { alt: true }, label: 'Option + H', want: encode('KeyH', { alt: true }), note: NO_REACTION },
  { code: 'KeyI', mods: { ctrl: true }, label: 'Control + I', want: encode('KeyI', { ctrl: true }), note: NO_REACTION },
  { code: 'Enter', mods: { ctrl: true }, label: 'Control + return', want: encode('Enter', { ctrl: true }), note: NO_REACTION },
] });
const MODNAME = [['ctrl', 'Control'], ['alt', 'Option'], ['shift', 'Shift'], ['meta', 'Command']];
const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Control', 'Meta', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);
const MOUSE_RE = /^\x1b\[(<|M)/;
const BARE_DEAD = { '`': 'Backquote', '¨': 'KeyU', '´': 'KeyE', 'ˆ': 'KeyI', '˜': 'KeyN' };
const STORE = 'webmosh-keytest';

for (const g of GROUPS) {
  g.steps ??= (g.codes || ALL).map((code) => ({
    code,
    label: [...MODNAME.filter(([k]) => g.mods[k]).map(([, n]) => n), LABEL[code]].join(' + '),
    want: encode(code, g.mods),
  }));
  g.steps.forEach((s, i) => { s.id = `${g.id}:${i}`; s.mods ??= g.mods || {}; });
}

const show = (s) => JSON.stringify(s).slice(1, -1) || L('(nothing)', '(无)');
// what a step should send: input-method steps take whatever text the input method inserted
const wantOf = (step, p) => (step.ime ? p?.inserted || '' : step.anyText ? L('(Chinese)', '(中文)') : step.want);
const flagsOf = (e) => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
const sameMods = (a, b) => MODNAME.every(([k]) => !!a[k] === !!b[k]);

export function startKeyTest({ term, send, ready, tapInput }) {
  const results = JSON.parse(localStorage.getItem(STORE) || '{}');
  const save = () => localStorage.setItem(STORE, JSON.stringify(results));
  // to the relay's journal; held until the WebSocket is up (the first lines come before it is)
  const queue = [];
  const report = (line) => queue.push(line.slice(0, 300));
  setInterval(() => { if (queue.length && ready()) send({ t: 'keylog', lines: queue.splice(0, 50) }); }, 500);
  let gi = Math.max(0, GROUPS.findIndex((g) => g.steps.some((s) => !results[s.id])));
  let si = firstOpen(gi);
  let last = null; // { cls, text } shown under the prompt

  function firstOpen(g) {
    const i = GROUPS[g].steps.findIndex((s) => !results[s.id]);
    return i < 0 ? 0 : i;
  }

  // ---- panel ----------------------------------------------------------------------------------
  const css = document.createElement('style');
  css.textContent = `
    #kt { position: fixed; top: max(8px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); width: min(980px, 96vw);
      z-index: 20; background: #15181ccc; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid #2c3138;
      border-radius: 12px; padding: 12px 14px; color: #d7dae0; font: 13px -apple-system, system-ui, sans-serif; user-select: none; -webkit-user-select: none; }
    #kt .groups { display: flex; flex-wrap: wrap; gap: 6px; }
    #kt button { font: inherit; color: inherit; background: #23282f; border: 1px solid #343a42; border-radius: 7px; padding: 5px 9px; }
    #kt button.on { border-color: #6ea8fe; background: #1d2a3d; }
    #kt button .n { color: #7d8590; margin-left: 4px; }
    #kt button .bad { color: #e0675f; margin-left: 4px; }
    #kt .prompt { margin: 12px 0 2px; font: 600 26px -apple-system, system-ui, sans-serif; }
    #kt .sub { color: #7d8590; }
    #kt .sub code { color: #d7dae0; font: 12px ui-monospace, Menlo, monospace; }
    #kt .last { margin-top: 6px; font: 12px ui-monospace, Menlo, monospace; min-height: 1.4em; white-space: pre-wrap; }
    #kt .last.ok { color: #4fb477; } #kt .last.bad { color: #e0675f; } #kt .last.warn { color: #d9a441; }
    #kt .kb { margin-top: 10px; display: grid; gap: 4px; }
    #kt .row { display: flex; gap: 4px; }
    #kt .key { min-width: 30px; padding: 5px 6px; text-align: center; border-radius: 5px; background: #1c2026; border: 1px solid #2c3138;
      font: 12px ui-monospace, Menlo, monospace; color: #9aa3ad; }
    #kt .key.ok { background: #1f3a2a; color: #b9e6c9; } #kt .key.bad { background: #4a2523; color: #f3c2bd; }
    #kt .key.skip { opacity: .45; } #kt .key.cur { outline: 2px solid #6ea8fe; color: #fff; }
    #kt .actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    #kt .actions .sp { flex: 1; }`;
  document.head.append(css);
  const panel = document.createElement('div');
  panel.id = 'kt';
  document.body.append(panel);
  // tapping the panel must not take focus from the terminal's textarea (the keys go there)
  for (const t of ['pointerdown', 'mousedown', 'touchstart']) panel.addEventListener(t, (e) => { if (e.target.closest('button')) e.preventDefault(); }, { passive: false });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'group') { gi = +b.dataset.g; si = firstOpen(gi); last = null; }
    if (a === 'skip') grade(null, 'SKIP');
    if (a === 'fail' && pending) grade(pending, 'FAIL');
    if (a === 'back' && si > 0) { si--; last = null; }
    if (a === 'redo') { for (const s of GROUPS[gi].steps) delete results[s.id]; save(); si = 0; last = null; }
    term.focus();
    render();
  });

  let pending = null; // the last MISS, which the fail button turns into a FAIL

  function render() {
    const g = GROUPS[gi];
    const step = g.steps[si];
    const count = (gr) => {
      const r = gr.steps.map((s) => results[s.id]?.status);
      return { done: r.filter(Boolean).length, ok: r.filter((x) => x === 'PASS').length, bad: r.filter((x) => x === 'FAIL').length, skip: r.filter((x) => x === 'SKIP').length };
    };
    const groups = GROUPS.map((gr, i) => {
      const c = count(gr);
      return `<button data-a="group" data-g="${i}" class="${i === gi ? 'on' : ''}">${gr.name}<span class="n">${c.done}/${gr.steps.length}</span>${c.bad ? `<span class="bad">${L('failed', '失败')} ${c.bad}</span>` : ''}</button>`;
    }).join('');
    const status = (code) => {
      const s = g.steps.find((x) => x.code === code);
      return s ? results[s.id]?.status : undefined;
    };
    const kb = ROWS.map((row) => `<div class="row">${row.map(([code, l]) => {
      const st = status(code);
      const cls = ['key', st === 'PASS' ? 'ok' : st === 'FAIL' ? 'bad' : st === 'SKIP' ? 'skip' : '', step && step.code === code ? 'cur' : ''].join(' ');
      return `<span class="${cls}">${l.replace(/</g, '&lt;')}</span>`;
    }).join('')}</div>`).join('');
    const c = count(g);
    panel.innerHTML = `
      <div class="groups">${groups}</div>
      <div class="prompt">${step ? L(`Press ${step.label}`, `按 ${step.label}`) : L(`${g.name}: done`, `${g.name} 这组测完了`)}</div>
      <div class="sub">${step ? `${step.note ? `${step.note}${L('. ', '。')}` : ''}${L(`${si + 1} of ${g.steps.length}, should send `, `第 ${si + 1} / ${g.steps.length} 个，应发送 `)}${step.ime || step.anyText ? L('what the input method gives', '输入法给出的字') : `<code>${show(step.want).replace(/</g, '&lt;')}</code>`}` : L(`passed ${c.ok}, failed ${c.bad}, skipped ${c.skip}; pick the next group above`, `通过 ${c.ok}，失败 ${c.bad}，跳过 ${c.skip}；点上面的下一组继续`)}</div>
      <div class="last ${last?.cls || ''}">${(last?.text || '').replace(/</g, '&lt;')}</div>
      <div class="kb">${kb}</div>
      <div class="actions">
        <button data-a="skip">${L('Skip (the system keeps it / nothing happens)', '跳过（系统拦截 / 没反应）')}</button>
        <button data-a="fail">${L('Right key: count it as failed', '按的是对的，记为失败')}</button>
        <button data-a="back">${L('Back', '上一个')}</button>
        <span class="sp"></span>
        <button data-a="redo">${L('Redo this group', '重测本组')}</button>
      </div>`;
  }

  // ---- presses --------------------------------------------------------------------------------
  // A press runs from its first event (keydown, or a composition when iPadOS sends no keydown) to
  // 150 ms after its key's keyup; a new keydown closes the one before.
  let press = null;
  const ev = (e) => {
    const t = { keydown: 'kd', keyup: 'ku', compositionstart: 'cs', compositionupdate: 'cu', compositionend: 'ce', beforeinput: 'bi', input: 'in' }[e.type];
    const f = flagsOf(e);
    const mods = MODNAME.filter(([k]) => f[k]).map(([k]) => k[0]).join('');
    return [t, e.code, e.key === undefined ? '' : JSON.stringify(e.key), e.keyCode ?? '', mods, e.isComposing ? 'c' : '', e.inputType || '', e.data != null ? JSON.stringify(e.data) : '']
      .filter((x, i) => i < 2 || x !== '').join('/');
  };
  function open() {
    // kd: the code of the press's keydown; a keyup for another key belongs to an earlier press
    // (rolled-over typing), and a keydown for another key starts the next one
    press = { events: [], bytes: [], inserted: '', kd: null, code: null, flags: null, up: false, timer: 0 };
    press.max = setTimeout(close, 1500);
  }
  function close() {
    const p = press;
    if (!p) return;
    press = null;
    clearTimeout(p.timer);
    clearTimeout(p.max);
    judge(p);
  }
  function settle() {
    clearTimeout(press.timer);
    press.timer = setTimeout(close, 150);
  }
  const onEvent = (e) => {
    if (e.target !== term.textarea) return;
    const mod = e.key && MODIFIER_KEYS.has(e.key);
    if (e.type === 'keydown') {
      if (mod) return;
      if (press && (press.up || press.kd !== e.code)) close();
    }
    if (e.type === 'keyup' && mod) return;
    if (!press) open();
    press.events.push(ev(e));
    if (e.type === 'keyup' && press.kd && e.code !== press.kd) return;
    if (e.type === 'keydown') press.kd ??= e.code;
    if ((e.type === 'keydown' || e.type === 'keyup') && e.code) {
      press.code = e.code;
      press.flags = flagsOf(e);
    }
    if (e.type === 'input' && e.inputType === 'insertText' && !e.isComposing && e.data) press.inserted += e.data;
    // a dead key iPadOS sent as a bare composition has no keydown or keyup: its accent names the key
    if (e.type === 'compositionupdate' && !press.code && BARE_DEAD[e.data]) {
      press.code = BARE_DEAD[e.data];
      press.flags = { alt: true };
    }
    if (e.type === 'keyup') { press.up = true; settle(); }
  };
  for (const t of ['keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
    document.addEventListener(t, onEvent, true); // capture on the document: before xterm's own listeners
  }
  tapInput((d) => {
    if (typeof d !== 'string' || MOUSE_RE.test(d)) return;
    if (!press) open();
    press.bytes.push(d);
    if (press.up) settle();
  });

  function judge(p) {
    const g = GROUPS[gi];
    const step = g.steps[si];
    if (!step) return;
    const got = p.bytes.join('');
    if (step.anyText) { // a composition: its letters send nothing until the text is committed
      if (got) grade({ p, got }, /[^\x00-\x7f]/.test(got) ? 'PASS' : 'FAIL');
      return;
    }
    const codeOk = !p.code || p.code === step.code;
    const modsOk = !p.flags || sameMods(p.flags, step.mods);
    if (!codeOk || !modsOk) {
      pending = { p, got };
      const what = [...MODNAME.filter(([k]) => p.flags?.[k]).map(([, n]) => n), LABEL[p.code] || p.code].join(' + ');
      last = { cls: 'warn', text: L(`Got ${what} (${show(got)}), not this step's key; press again, or count it as failed`,
        `收到的是 ${what}（${show(got)}），不是这一步要的键；再按一次，或者点「记为失败」`) };
      report(`keytest ${g.id} ${step.label} MISS want=${show(wantOf(step, p))} got=${show(got)} ev=${p.events.join(' ')}`);
      render();
      return;
    }
    const want = wantOf(step, p);
    grade({ p, got }, got === want && (got !== '' || !step.ime) ? 'PASS' : 'FAIL');
  }

  function grade(r, status) {
    const g = GROUPS[gi];
    const step = g.steps[si];
    if (!step) return;
    pending = null;
    results[step.id] = { status, got: r?.got ?? null };
    save();
    const evs = status === 'PASS' || !r ? '' : ` ev=${r.p.events.join(' ')}`;
    const want = wantOf(step, r?.p);
    report(`keytest ${g.id} ${step.label} ${status} want=${show(want)} got=${r ? show(r.got) : '-'}${evs}`);
    last = status === 'PASS' ? { cls: 'ok', text: L(`${step.label}: ${show(r.got)}, right`, `${step.label}：${show(r.got)}，对`) }
      : status === 'SKIP' ? { cls: 'warn', text: L(`${step.label}: skipped`, `${step.label}：跳过`) }
      : { cls: 'bad', text: L(`${step.label}: sent ${show(r.got)}, should be ${show(want)}`, `${step.label}：发出 ${show(r.got)}，应为 ${show(want)}`) };
    si++;
    if (si >= g.steps.length) {
      const r2 = g.steps.map((s) => results[s.id]?.status);
      report(`keytest ${g.id} done pass=${r2.filter((x) => x === 'PASS').length} fail=${r2.filter((x) => x === 'FAIL').length} skip=${r2.filter((x) => x === 'SKIP').length} of ${g.steps.length}`);
    }
    render();
  }

  report(`keytest start ${navigator.userAgent}`);
  render();
  term.focus();
}
