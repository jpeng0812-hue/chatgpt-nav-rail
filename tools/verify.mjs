// verify.mjs —— 验证导航栏是否在线（可选用例：自动打开一个长会话），并截图。
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const shots = path.join(here, '..', 'shots');
fs.mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findMainTarget(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })).json()).filter(
        (t) => t.type === 'page' && /^app:\/\/-/.test(t.url)
      );
      if (list.length) return list;
    } catch {}
    await sleep(1000);
  }
  throw new Error('no app:// page target (CDP port closed?)');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
  const ready = new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  return { ws, send, ready };
}

const targets = await findMainTarget();
const main = targets.find((t) => /index\.html$/.test(t.url)) || targets[0];
const { ws, send, ready } = connect(main.webSocketDebuggerUrl);
await ready;

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

const status = async () =>
  JSON.parse(
    await evalJs(`(() => {
      const api = window.__chatgpt_nav_rail__;
      const host = document.getElementById('chatgpt-nav-rail-host');
      const ticks = host?.shadowRoot?.querySelectorAll('.row').length ?? -1;
      const conv = document.querySelector('[data-thread-find-target="conversation"]');
      return JSON.stringify({
        injected: !!api,
        version: api?.version ?? null,
        ticks,
        railVisible: host ? getComputedStyle(host).display !== 'none' : false,
        inConversation: !!conv,
        title: document.title.slice(0, 40),
      });
    })()`)
  );

let s = await status();
console.log('status:', JSON.stringify(s));

if (!s.inConversation || s.ticks < 2) {
  const opened = await evalJs(`(() => {
    const needle = '100轮';
    const all = [...document.querySelectorAll('body *')];
    const leaf = all.find(el => (el.textContent||'').includes(needle) && ![...el.children].some(c => (c.textContent||'').includes(needle)));
    if (!leaf) return 'no-chat-item';
    let cur = leaf, target = null;
    for (let i = 0; i < 14 && cur; i++) {
      const role = cur.getAttribute && cur.getAttribute('role');
      if (role === 'button' || role === 'link' || cur.tagName === 'A' || cur.tagName === 'BUTTON') { target = cur; break; }
      cur = cur.parentElement;
    }
    if (!target) return 'no-clickable';
    target.click();
    return 'clicked';
  })()`);
  console.log('open chat:', opened);
  await sleep(4000);
  s = await status();
  console.log('status:', JSON.stringify(s));
}

const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 260, y: 60, width: 900, height: 760, scale: 1.6 } });
const file = path.join(shots, process.argv[2] || 'verify.png');
fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
console.log('screenshot:', file);
ws.close();
