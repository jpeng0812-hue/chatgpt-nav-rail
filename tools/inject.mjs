// inject.mjs —— 把 payload.js 注入主窗口，打印自检信息并截图。
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const payload = fs.readFileSync(path.join(here, '..', 'injector', 'payload.js'), 'utf8');
const outDir = path.join(here, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
const target = list.find((t) => /index\.html$/.test(t.url)) || list.find((t) => /index\.html/.test(t.url));
if (!target) throw new Error('找不到主窗口 target');

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const ev = await send('Runtime.evaluate', { expression: payload, awaitPromise: true, returnByValue: true });
if (ev.exceptionDetails) console.error('inject exception:', JSON.stringify(ev.exceptionDetails).slice(0, 500));

await new Promise((r) => setTimeout(r, 900));

const dbg = await send('Runtime.evaluate', {
  expression: 'JSON.stringify(window.__chatgpt_nav_rail__ ? window.__chatgpt_nav_rail__.debug() : null)',
  returnByValue: true,
});
console.log('debug:', dbg.result.value);

const info = await send('Runtime.evaluate', {
  expression: `(() => {
    const h = document.getElementById('chatgpt-nav-rail-host');
    const ticks = h?.shadowRoot?.querySelectorAll('.tick').length ?? -1;
    const r = h?.getBoundingClientRect();
    return JSON.stringify({ ticks, rect: r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  })()`,
  returnByValue: true,
});
console.log('dom:', info.result.value);

const shot = await send('Page.captureScreenshot', { format: 'png' });
const file = path.join(outDir, process.argv[2] || 'shot.png');
fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
console.log('screenshot:', file);
ws.close();
