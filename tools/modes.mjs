// modes.mjs —— 验证：切到 Codex 时本插件完全让位；切回 Chat 后恢复。
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const shots = path.join(here, '..', 'shots');

const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
const target = list.find((t) => /index\.html$/.test(t.url)) || list[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
};

const snapshot = () =>
  evalJs(`(() => {
    const host = document.getElementById('chatgpt-nav-rail-host');
    const ss = host?.shadowRoot;
    return JSON.stringify({
      mode: document.querySelector('[aria-label^="切换模式"]')?.innerText?.trim?.() || null,
      hostDisplay: host ? getComputedStyle(host).display : 'no-host',
      rows: ss ? ss.querySelectorAll('.row').length : -1,
      debug: window.__chatgpt_nav_rail__?.debug() || null,
      chatTurns: document.querySelectorAll('[data-turn-key^="history-content:turn:"]').length,
      codexTurns: document.querySelectorAll('[data-turn-key^="turn-"]').length,
      nativeRail: (() => { const n = document.querySelector('[data-thread-user-message-navigation-rail-list]'); return n ? Math.round(n.getBoundingClientRect().height) : 0; })(),
    });
  })()`);

const rect = (sel) =>
  evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }); })()`);

console.log('before      :', await snapshot());

// 打开模式菜单
const modeBtn = JSON.parse(await rect('[aria-label^="切换模式"]'));
await clickAt(modeBtn.x, modeBtn.y);
await sleep(500);

// 点 Codex 项
const items = JSON.parse(
  await evalJs(`(() => {
    const all = [...document.querySelectorAll('[role="menuitem"]')].map(e => {
      const r = e.getBoundingClientRect();
      return { text: (e.innerText||'').trim().slice(0,20), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), h: Math.round(r.height) };
    }).filter(x => x.h > 20);
    return JSON.stringify(all);
  })()`)
);
console.log('menu items  :', JSON.stringify(items));
const codex = items.find((i) => i.text.startsWith('Codex'));
if (!codex) throw new Error('Codex 菜单项未找到');
await clickAt(codex.x, codex.y);
await sleep(4500);
console.log('codex mode  :', await snapshot());
let shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shots, 'mode-codex.png'), Buffer.from(shot.data, 'base64'));

// 切回 Chat
const modeBtn2 = JSON.parse(await rect('[aria-label^="切换模式"]'));
await clickAt(modeBtn2.x, modeBtn2.y);
await sleep(500);
const items2 = JSON.parse(
  await evalJs(`(() => {
    const all = [...document.querySelectorAll('[role="menuitem"]')].map(e => {
      const r = e.getBoundingClientRect();
      return { text: (e.innerText||'').trim().slice(0,20), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), h: Math.round(r.height) };
    }).filter(x => x.h > 20);
    return JSON.stringify(all);
  })()`)
);
const chat = items2.find((i) => i.text.startsWith('ChatGPT'));
if (!chat) throw new Error('ChatGPT 菜单项未找到');
await clickAt(chat.x, chat.y);
await sleep(4000);
console.log('back to chat:', await snapshot());
shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shots, 'mode-chat.png'), Buffer.from(shot.data, 'base64'));
ws.close();
