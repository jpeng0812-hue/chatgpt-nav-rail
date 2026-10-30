// test2.mjs —— 交互验证：Alt+↓/↑ 跳转、Alt+N 折叠、切换会话后自动重算。
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

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (k, code, vk, mods = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};

const state = () =>
  evalJs(`(() => {
    const sc = document.querySelector('.thread-scroll-container');
    const host = document.getElementById('chatgpt-nav-rail-host');
    return JSON.stringify({
      scrollTop: Math.round(sc?.scrollTop ?? -1),
      ticks: host?.shadowRoot?.querySelectorAll('.tick').length ?? -1,
      width: host ? Math.round(host.getBoundingClientRect().width) : -1,
      active: [...(host?.shadowRoot?.querySelectorAll('.tick.active') ?? [])].map(t => t.dataset.index),
      outlined: [...document.querySelectorAll('[data-turn-key]')].filter(e => e.style.outline).length,
    });
  })()`);

console.log('before      :', await state());

// Alt+ArrowUp => 上一条（会往回滚）
await key('ArrowUp', 'ArrowUp', 38, 1);
await sleep(1100);
console.log('alt+up      :', await state());

// Alt+ArrowDown => 下一条
await key('ArrowDown', 'ArrowDown', 40, 1);
await sleep(1100);
console.log('alt+down    :', await state());

// Alt+N => 折叠
await key('n', 'KeyN', 78, 1);
await sleep(400);
console.log('alt+n       :', await state());
const collapsedShot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 280, y: 120, width: 160, height: 560, scale: 2 } });
fs.writeFileSync(path.join(shots, 'collapsed.png'), Buffer.from(collapsedShot.data, 'base64'));

// Alt+N => 展开
await key('n', 'KeyN', 78, 1);
await sleep(400);
console.log('alt+n again :', await state());

// 切换会话：点侧边栏另一个会话，看刻度是否重算
const switched = await evalJs(`(() => {
  const needle = 'GPT Navigator';
  const all = [...document.querySelectorAll('body *')];
  const leaf = all.find(el => (el.textContent||'').includes(needle) && ![...el.children].some(c => (c.textContent||'').includes(needle)));
  if (!leaf) return 'not-found';
  let cur = leaf, t = null;
  for (let i = 0; i < 14 && cur; i++) {
    const role = cur.getAttribute && cur.getAttribute('role');
    if (role === 'button' || role === 'link' || cur.tagName === 'A' || cur.tagName === 'BUTTON') { t = cur; break; }
    cur = cur.parentElement;
  }
  if (!t) return 'no-clickable';
  t.click();
  return 'clicked';
})()`);
console.log('switch chat :', switched);
await sleep(3500);
console.log('after switch:', await state());
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 260, y: 60, width: 760, height: 720, scale: 1.6 } });
fs.writeFileSync(path.join(shots, 'after-switch.png'), Buffer.from(shot.data, 'base64'));
ws.close();
