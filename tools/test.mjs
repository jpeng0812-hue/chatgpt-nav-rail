// test.mjs —— 端到端验证：注入 → 悬停出预览卡 → 点击跳转 → 校验落点 → 截图。
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const payload = fs.readFileSync(path.join(here, '..', 'injector', 'payload.js'), 'utf8');
const shots = path.join(here, '..', 'shots');
fs.mkdirSync(shots, { recursive: true });

const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
const target = list.find((t) => /index\.html$/.test(t.url)) || list[0];

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

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name, clip) => {
  const p = { format: 'png' };
  if (clip) p.clip = { ...clip, scale: clip.scale || 2 };
  const res = await send('Page.captureScreenshot', p);
  const file = path.join(shots, name);
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  return file;
};

// 1) 重装
await evalJs('window.__chatgpt_nav_rail__ && window.__chatgpt_nav_rail__.destroy()');
await sleep(120);
await evalJs(payload);
await sleep(800);

const dbg = await evalJs('JSON.stringify(window.__chatgpt_nav_rail__.debug())');
console.log('debug:', dbg);

// 2) 刻度几何
const ticks = JSON.parse(
  await evalJs(`(() => {
    const host = document.getElementById('chatgpt-nav-rail-host');
    const sr = host.shadowRoot;
    const els = [...sr.querySelectorAll('.tick')];
    return JSON.stringify(els.map((t, i) => {
      const r = t.getBoundingClientRect();
      return { i, kind: t.className.replace('tick ', ''), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }));
  })()`)
);
console.log('ticks:', JSON.stringify(ticks));

// 3) 悬停第 2 个刻度 → 预览卡
const hoverTarget = ticks[1];
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverTarget.x, y: hoverTarget.y, buttons: 0 });
await sleep(400);
const cardInfo = await evalJs(`(() => {
  const sr = document.getElementById('chatgpt-nav-rail-host').shadowRoot;
  const card = sr.querySelector('.card');
  return JSON.stringify({ shown: card.classList.contains('show'), who: card.querySelector('.who').textContent, idx: card.querySelector('.idx').textContent, body: card.querySelector('.body').textContent.slice(0, 80) });
})()`);
console.log('card:', cardInfo);
console.log('hover shot:', await shot('hover.png', { x: 280, y: 80, width: 620, height: 700 }));

// 4) 点击第 3 个刻度 → 跳转
const clickTarget = ticks[2];
const before = await evalJs(`JSON.stringify({ top: Math.round(document.querySelector('.thread-scroll-container').scrollTop) })`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickTarget.x, y: clickTarget.y, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickTarget.x, y: clickTarget.y, button: 'left', clickCount: 1, buttons: 0 });
await sleep(1200);

const after = await evalJs(`(() => {
  const sc = document.querySelector('.thread-scroll-container');
  const rail = window.__chatgpt_nav_rail__;
  const items = rail.debug().items;
  const probe = document.elementFromPoint(400, 150);
  const turn = probe && probe.closest('[data-turn-key]');
  return JSON.stringify({ scrollTop: Math.round(sc.scrollTop), expect: Math.round(rail.__lastJump || -1), turnAtTop: turn ? turn.getAttribute('data-turn-key') : null, items });
})()`);
console.log('before:', before);
console.log('after:', after);
console.log('jump shot:', await shot('jump.png', { x: 280, y: 80, width: 900, height: 700 }));

ws.close();
