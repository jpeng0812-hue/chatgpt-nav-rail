// shot-wide.mjs —— 宽幅截图（含侧边栏边缘），用来核对导航栏与侧边栏的距离。
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

const info = JSON.parse(
  await evalJs(`(() => {
    const h = document.getElementById('chatgpt-nav-rail-host');
    const rows = [...h.shadowRoot.querySelectorAll('.row')];
    const sc = [...document.querySelectorAll('.thread-scroll-container')].find(s => s.getBoundingClientRect().height > 150);
    const r = rows[Math.min(2, rows.length - 1)].getBoundingClientRect();
    const hr = h.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      rail: { x: Math.round(hr.x), y: Math.round(hr.y), w: Math.round(hr.width), h: Math.round(hr.height) },
      scrollerLeft: Math.round(sr.left),
      gutter: window.__chatgpt_nav_rail__.debug().gutter,
      rows: rows.length,
    });
  })()`)
);
console.log('info:', JSON.stringify(info));

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y, buttons: 0 });
await sleep(400);
const clip = { x: Math.max(0, info.scrollerLeft - 120), y: Math.max(0, info.rail.y - 120), width: 900, height: 420, scale: 2 };
const shot = await send('Page.captureScreenshot', { format: 'png', clip });
fs.writeFileSync(path.join(shots, process.argv[2] || 'wide-check.png'), Buffer.from(shot.data, 'base64'));
console.log('saved', path.join(shots, process.argv[2] || 'wide-check.png'));
ws.close();
