// switch-probe.mjs —— 切换会话时，分别测量「DOM 里消息就绪」与「导航刻度就绪」的时间点，
// 用来判断慢在应用渲染还是慢在我们的调度。
const port = Number(process.argv[2] || 9333);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url) && !/avatar-overlay|detached/.test(t.url));
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = async () =>
  JSON.parse(
    await evalJs(`JSON.stringify({
      title: (document.title || '').slice(0, 12),
      bubbles: document.querySelectorAll('[data-user-message-bubble]').length,
      items: window.__chatgpt_nav_rail__.debug().items,
      key: window.__chatgpt_nav_rail__.debug().chatKey,
      width: Math.round((document.getElementById('chatgpt-nav-rail-host') || {getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width)
    })`)
  );

const before = await state();
const who = await evalJs(`(() => {
  const CURRENT = ${JSON.stringify(before.key)};
  const nav = document.querySelector('nav[aria-label="首页"]') || document.body;
  const rows = [...nav.querySelectorAll('[role="button"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 16; });
  const known = ['傅里叶光学', '提取作业信息', '问候交流', '卷积', '傅里叶级数', '傅里叶变换'];
  for (const k of known) {
    if (k === CURRENT) continue;
    const hit = rows.find((e) => (e.innerText || '').trim().indexOf(k) === 0);
    if (hit) { hit.click(); return k; }
  }
  return 'none';
})()`);

const t0 = Date.now();
const timeline = [];
let domMs = -1;
let railMs = -1;
for (let i = 0; i < 200; i++) {
  const s = await state();
  const took = Date.now() - t0;
  if (domMs < 0 && s.bubbles > 0) domMs = took;
  if (railMs < 0 && s.items > 0 && s.key && s.key !== before.key) railMs = took;
  if (i % 3 === 0 || (domMs === took) || (railMs === took)) timeline.push({ t: took, ...s });
  if (domMs >= 0 && railMs >= 0) break;
  await sleep(25);
}
console.log(JSON.stringify({ from: before.key, to: who, domMs, railMs, timeline: timeline.slice(0, 14) }, null, 2));
ws.close();
