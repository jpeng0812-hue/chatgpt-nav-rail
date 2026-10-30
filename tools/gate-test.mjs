// gate-test.mjs —— 点一下"固定摘要面板"，把正文左留白压到 48px 以下，验证导航栏自动隐藏。
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
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
};

const state = () =>
  evalJs(`(() => {
    const host = document.getElementById('chatgpt-nav-rail-host');
    const d = window.__chatgpt_nav_rail__?.debug();
    return JSON.stringify({ gutter: d?.gutter, rows: host?.shadowRoot?.querySelectorAll('.row').length ?? -1, shown: host ? getComputedStyle(host).display !== 'none' : false, items: d?.items });
  })()`);

const btn = JSON.parse(
  await evalJs(`(() => {
    const e = [...document.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label').includes('摘要面板'));
    if (!e) return 'null';
    const r = e.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), label: e.getAttribute('aria-label') });
  })()`)
);
console.log('pin button:', JSON.stringify(btn));
console.log('before   :', await state());

await click(btn.x, btn.y);
await sleep(1800);
console.log('pinned   :', await state());
let shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shots, 'gate-narrow.png'), Buffer.from(shot.data, 'base64'));

await click(btn.x, btn.y);
await sleep(1800);
console.log('unpinned :', await state());
shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shots, 'gate-wide.png'), Buffer.from(shot.data, 'base64'));
ws.close();
