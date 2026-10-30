// cdp-click.mjs —— 在主窗口内按屏幕坐标派发真实鼠标事件（pointerdown/up 序列）。
import fs from 'node:fs';

const port = Number(process.argv[2] || 9333);
const x = Number(process.argv[3]);
const y = Number(process.argv[4]);
const urlRe = new RegExp(process.argv[5] || 'index\\.html$');

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && urlRe.test(t.url));
if (!target) throw new Error('no target');

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

const base = { x, y, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' };
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
console.log(JSON.stringify({ clicked: { x, y } }));
ws.close();
