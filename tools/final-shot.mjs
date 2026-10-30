// final-shot.mjs —— 命中一条带长摘要的消息就立刻截图（避免悬停中途重排导致错位）。
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const shots = path.join(here, '..', 'shots');
fs.mkdirSync(shots, { recursive: true });

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

const snap = () =>
  evalJs(`(() => {
    const host = document.getElementById('chatgpt-nav-rail-host');
    const ss = host?.shadowRoot;
    const rows = [...(ss?.querySelectorAll('.row') ?? [])].map((r, i) => {
      const b = r.getBoundingClientRect();
      return { i, kind: r.className.replace('row ', ''), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    });
    const c = ss?.querySelector('.card');
    const hr = host?.getBoundingClientRect();
    return JSON.stringify({
      rows,
      card: c && { show: c.classList.contains('show'), t: c.querySelector('.title').textContent, b: c.querySelector('.body').textContent },
      rail: hr && { x: Math.round(hr.x), y: Math.round(hr.y), w: Math.round(hr.width), h: Math.round(hr.height) },
      debug: window.__chatgpt_nav_rail__?.debug(),
      vp: { w: innerWidth, h: innerHeight },
    });
  })()`);

async function capture(name) {
  const s = JSON.parse(await snap());
  const x = Math.max(0, s.rail.x - 26);
  const y = Math.max(0, s.rail.y - 34);
  const clip = {
    x,
    y,
    width: Math.max(320, Math.min(900, s.vp.w - x - 8)),
    height: Math.max(200, Math.min(430, s.vp.h - y - 8)),
    scale: 2,
  };
  const shot = await send('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(path.join(shots, name), Buffer.from(shot.data, 'base64'));
  return s;
}

let s = JSON.parse(await snap());
console.log('debug:', JSON.stringify(s.debug), 'rows:', s.rows.length);
if (!s.rows.length) throw new Error('导航轨未显示');

const order = s.rows.slice().sort((a, b) => (a.kind === 'assistant' ? -1 : 1));
let done = false;
for (const candidate of order) {
  const fresh = JSON.parse(await snap());
  const row = fresh.rows.find((x) => x.i === candidate.i && x.kind === candidate.kind);
  if (!row) continue;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y, buttons: 0 });
  await sleep(260);
  const now = JSON.parse(await snap());
  if (now.card && now.card.show && (now.card.b || '').length >= 120) {
    console.log('hit row', candidate.i, candidate.kind, '| title:', now.card.t.slice(0, 36), '| body:', now.card.b.length);
    const finalState = await capture(process.argv[2] || 'final-hover.png');
    console.log('rail:', JSON.stringify(finalState.rail), 'gutter:', finalState.debug.gutter);
    done = true;
    break;
  }
}
if (!done) {
  console.log('没有足够长的摘要，用当前悬停结果截图');
  await capture(process.argv[2] || 'final-hover.png');
}

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
await sleep(320);
await capture('final-rest.png');
console.log('done');
ws.close();
