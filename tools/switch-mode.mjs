// switch-mode.mjs —— 稳妥地切回指定模式（ChatGPT），轮询菜单项而不是盲等。
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const want = process.argv[2] || 'ChatGPT';
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
const mode = () => evalJs(`document.querySelector('[aria-label^="切换模式"]')?.innerText?.trim() || null`);

const itemsScript = `JSON.stringify([...document.querySelectorAll('[role="menuitem"]')].map(e => {
  const r = e.getBoundingClientRect();
  return { text: (e.innerText||'').trim().replace(/\\s+/g,' '), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), h: Math.round(r.height) };
}).filter(x => x.h > 20))`;

console.log('current mode:', await mode());
const btn = JSON.parse(
  await evalJs(`(() => { const e = document.querySelector('[aria-label^="切换模式"]'); const r = e.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}); })()`)
);
await click(btn.x, btn.y);

let items = [];
for (let i = 0; i < 20; i++) {
  await sleep(120);
  items = JSON.parse(await evalJs(itemsScript));
  if (items.length) break;
}
console.log('menu:', JSON.stringify(items.map((i) => i.text)));

const pick = items.find((i) => i.text.startsWith(want));
if (!pick) throw new Error('未找到菜单项: ' + want);
await click(pick.x, pick.y);

for (let i = 0; i < 40; i++) {
  await sleep(250);
  const m = await mode();
  if (m && m.includes(want)) {
    console.log('switched ->', m);
    break;
  }
}
await sleep(2500);
console.log(
  'final:',
  await evalJs(`JSON.stringify({
    mode: document.querySelector('[aria-label^="切换模式"]')?.innerText?.trim(),
    chatTurns: document.querySelectorAll('[data-turn-key^="history-content:turn:"]').length,
    codexTurns: document.querySelectorAll('[data-turn-key^="turn-"]').length,
    rail: window.__chatgpt_nav_rail__?.debug(),
    rows: document.getElementById('chatgpt-nav-rail-host')?.shadowRoot?.querySelectorAll('.row').length ?? -1,
  })`)
);
ws.close();
