// regress.mjs —— 逐个打开侧边栏里的会话，比对「用户气泡数 vs 刻度数」，找漏识别/不显示。
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

const chats = JSON.parse(
  await evalJs(`(() => {
    const nav = document.querySelector('nav[aria-label="首页"]') || document.body;
    const rows = [...nav.querySelectorAll('[role="button"]')]
      .filter(e => { const t = (e.innerText||'').trim(); const r = e.getBoundingClientRect(); return t.length > 4 && r.width > 120 && r.height > 18; })
      .map(e => ({ label: (e.innerText||'').trim().replace(/\\s+/g,' ').slice(0, 28), idx: [...nav.querySelectorAll('[role="button"]')].indexOf(e) }));
    return JSON.stringify(rows.slice(0, 8));
  })()`)
);
console.log('候选会话:', chats.map((c) => c.label).join(' | '));

const clickChat = async (label) =>
  evalJs(`(() => {
    const nav = document.querySelector('nav[aria-label="首页"]') || document.body;
    const rows = [...nav.querySelectorAll('[role="button"]')]
      .filter(e => { const t=(e.innerText||'').trim(); const r=e.getBoundingClientRect(); return t.length > 4 && r.width > 120 && r.height > 18; });
    const hit = rows.find(e => (e.innerText||'').replace(/\\s+/g,' ').trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return 'missing';
    hit.click();
    return 'ok';
  })()`);

const probe = () =>
  evalJs(`(() => {
    const sc = [...document.querySelectorAll('.thread-scroll-container')].find(s => s.getBoundingClientRect().height > 150);
    const host = document.getElementById('chatgpt-nav-rail-host');
    const api = window.__chatgpt_nav_rail__;
    const bubbles = sc ? sc.querySelectorAll('[data-user-message-bubble]').length : 0;
    const rows = host ? host.shadowRoot.querySelectorAll('.row').length : 0;
    const d = api ? api.debug() : null;
    return JSON.stringify({ title: document.title.slice(0, 22), bubbles, rows, shown: host ? getComputedStyle(host).display !== 'none' : false, gutter: d && d.gutter, items: d && d.items });
  })()`);

const results = [];
for (const c of chats.slice(0, 6)) {
  const ok = await clickChat(c.label);
  if (ok !== 'ok') {
    results.push({ label: c.label, error: 'click-failed' });
    continue;
  }
  await sleep(2600);
  const p = JSON.parse(await probe());
  const verdict = p.bubbles === p.rows ? 'ok' : p.bubbles === 0 ? 'no-bubbles' : 'MISMATCH';
  results.push({ label: c.label, ...p, verdict });
  console.log(
    `${verdict.padEnd(10)} bubbles=${String(p.bubbles).padStart(2)} rows=${String(p.rows).padStart(2)} gutter=${String(p.gutter).padStart(3)} shown=${p.shown}  ${p.title}`
  );
}
fs.writeFileSync(path.join(shots, 'regress.json'), JSON.stringify(results, null, 2));
const bad = results.filter((r) => r.verdict === 'MISMATCH');
console.log(bad.length ? `\n不匹配 ${bad.length} 个` : '\n全部一致');
ws.close();
