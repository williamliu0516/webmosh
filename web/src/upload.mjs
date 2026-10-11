// Photos and files from the iPad into the terminal, for Claude Code on the Mac above all: its Ctrl+V reads the
// clipboard of the computer it runs on, which never has the iPad's pictures. Three ways in, one way through:
//   Cmd+Shift+I   iPadOS's picker (photo library, camera, files), several at once
//   Cmd+V         when the clipboard holds a picture or a file (a screenshot, a photo copied in Photos); text pastes
//                 as before
//   drop          a photo or file dragged onto the terminal (Split View, Slide Over)
// Each file goes to the computer the tab is connected to: the relay (POST /upload) hands it to that computer's
// webmosh-gate, which keeps it in ~/Downloads/webmosh/ (on the relay's own computer, the relay writes it there itself). Its path is
// then pasted at the cursor, as a file dropped on Ghostty is, and Claude Code turns a pasted image path into an
// attached image ([Image #1]). HEIC photos become JPEG first: Claude Code reads PNG, JPEG, GIF and WebP.

import { L } from './i18n.mjs';

const MAX = 50 << 20; // the relay's limit too

/**
 * @param {object} o
 * @param {import('@xterm/xterm').Terminal} o.term
 * @param {() => ({id: string, label: string} | null)} o.session   the active tab's session, if it has one
 * @param {(text: string, ms?: number) => void} o.badge
 * @param {() => void} o.focus   back to the terminal (after the picker)
 * @param {(line: string) => void} o.log   to the relay journal
 */
export function createUploader({ term, session, badge, focus, log }) {
  // The picker's input stays in the page, out of sight but not display:none (iPadOS may not open a hidden one).
  // No accept filter: iPadOS then offers the photo library, the camera and Files.
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(input);
  let picking = null; // the session the picker was opened for
  input.addEventListener('change', () => {
    const files = [...input.files];
    const s = picking;
    picking = null;
    input.value = '';
    focus();
    if (files.length && s) upload(files, s);
  });
  input.addEventListener('cancel', () => { picking = null; focus(); });

  /** Cmd+Shift+I. Runs inside the keydown: iPadOS opens a file picker only for a user's own key or tap. */
  function pick() {
    const s = session();
    log(`pick ${s ? 'session' : 'no-session'}`);
    if (!s) { badge(L('This tab is not connected: ssh or mosh to a host first', '这个标签没连主机：先 ssh 或 mosh 一台'), 1800); return; }
    picking = s;
    input.click();
  }

  // Cmd+V with a picture: the paste event carries it as a file. Before xterm's own paste listener (window capture),
  // so a picture never arrives as text; a text paste is left to xterm.
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    log(`paste files=${files.length} types=${[...(e.clipboardData?.types || [])].join(',')}`);
    if (!files.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const s = session();
    if (!s) { badge(L('This tab is not connected: ssh or mosh to a host first', '这个标签没连主机：先 ssh 或 mosh 一台'), 1800); return; }
    upload(files, s);
  }, true);

  const term$ = document.querySelector('#term');
  term$.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  term$.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const s = session();
    if (!s) { badge(L('This tab is not connected: ssh or mosh to a host first', '这个标签没连主机：先 ssh 或 mosh 一台'), 1800); return; }
    upload(files, s);
  });

  let busy = Promise.resolve();
  /** In order, one at a time; each path is pasted as its file arrives. */
  function upload(files, s) {
    busy = busy.then(async () => {
      const paths = [];
      for (let i = 0; i < files.length; i++) {
        badge(files.length > 1 ? L(`Uploading ${i + 1}/${files.length}…`, `上传 ${i + 1}/${files.length}…`) : L('Uploading…', '上传中…'), 60000);
        try {
          const f = await prepare(files[i]);
          if (f.blob.size > MAX) throw new Error(L(`${f.name} is over 50 MB`, `${f.name} 超过 50 MB`));
          const r = await fetch(`/upload?session=${encodeURIComponent(s.id)}&name=${encodeURIComponent(f.name)}`,
            { method: 'POST', body: f.blob, headers: { 'Content-Type': 'application/octet-stream' } });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.path) throw new Error(j.error || L(`Upload failed (${r.status})`, `上传失败（${r.status}）`));
          paths.push(j.path);
          pasteInto(s, j.path, paths.length > 1);
        } catch (err) {
          badge(err.message || String(err), 4000);
          log(`upload failed: ${err.message || err}`);
          return;
        }
      }
      badge(paths.length > 1 ? L(`Uploaded ${paths.length} files`, `已上传 ${paths.length} 个文件`)
        : L(`Uploaded: ${paths[0].replace(/^.*\//, '')}`, `已上传：${paths[0].replace(/^.*\//, '')}`), 1600);
    });
  }

  // Into the tab it was meant for, while that tab is on screen (the terminal is shared); else only shown.
  function pasteInto(s, path, more) {
    const now = session();
    if (!now || now.id !== s.id) { badge(L(`Uploaded to ${path} (another tab is on screen now, so it was not pasted)`, `已上传到 ${path}（标签已切走，没粘贴）`), 4000); return; }
    // Each path as its own paste (bracketed when the program asked for it): Claude Code takes a paste that is one
    // image path as that image.
    if (more) term.input(' ', true);
    term.paste(path);
  }

  return { pick };
}

/**
 * The file as it will be sent: HEIC/HEIF as JPEG (Safari decodes HEIC), anything else as it is.
 * @param {File} file
 * @returns {Promise<{name: string, blob: Blob}>}
 */
export async function prepare(file) {
  const name = file.name || (file.type === 'image/png' ? 'image.png' : file.type === 'image/jpeg' ? 'image.jpg' : 'file');
  if (!/^image\/hei[cf]/.test(file.type) && !/\.hei[cf]$/i.test(name)) return { name, blob: file };
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.9));
    return { name: name.replace(/\.hei[cf]$/i, '') + '.jpg', blob };
  } catch {
    return { name, blob: file }; // could not decode: as it is
  }
}
