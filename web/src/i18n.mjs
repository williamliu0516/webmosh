// The page's language: English, or Chinese when the relay's config says "lang": "zh" (site.json, read by app.mjs before
// anything is drawn). Each message is written in both, side by side: L('English', '中文'). Call L when the text is
// shown, never at a module's top level (that runs before setLang).
let zh = false;

export function setLang(lang) {
  zh = lang === 'zh';
  document.documentElement.lang = zh ? 'zh' : 'en';
}

export const L = (en, zhText) => (zh ? zhText : en);
