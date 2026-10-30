// perf-probe.mjs —— 用「外部轮询」测页面内反应时间。
// 页面被遮挡时 setTimeout/rAF 会被 Chromium 节流到分钟级，所以时间必须从 node 侧量。
// 用法: node perf-probe.mjs [port]
const port = Number(process.argv[2] || 9333);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url) && !/avatar-overlay|detached/.test(t.url));
if (!target) throw new Error('no page target');
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
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = {};

// ---- 1. 切换会话：点另一个会话，轮询到刻度出现 ----
const before = JSON.parse(await evalJs('JSON.stringify(window.__chatgpt_nav_rail__.debug())'));
const target0 = await evalJs(`(() => {
  const nav = document.querySelector('nav[aria-label="首页"]') || document.body;
  const rows = [...nav.querySelectorAll('[role="button"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 16; });
  const names = rows.map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12));
  const pick = rows.find((e) => (e.innerText || '').indexOf('提取作业信息') >= 0 && '${before.chatKey}' !== '提取作业信息')
    || rows.find((e) => (e.innerText || '').indexOf('傅里叶光学') >= 0 && '${before.chatKey}' !== '傅里叶光学');
  if (!pick) return 'none';
  pick.click();
  return (pick.innerText || '').slice(0, 12);
})()`);
const t0 = Date.now();
let switchMs = -1;
for (let i = 0; i < 150; i++) {
  await sleep(20);
  const d = JSON.parse(await evalJs('JSON.stringify(window.__chatgpt_nav_rail__.debug())'));
  if (d.items > 0 && d.chatKey && d.chatKey !== before.chatKey) {
    switchMs = Date.now() - t0;
    result.rowsAfter = d.items;
    break;
  }
}
result.from = before.chatKey;
result.to = target0;
result.switchMs = switchMs;
await sleep(500);

// ---- 2. Codex 结构特征出现 -> 让位 ----
await evalJs(`(() => {
  window.__probe_w = document.createElement('div');
  window.__probe_w.setAttribute('data-thread-find-target', 'conversation');
  const t = document.createElement('div');
  t.setAttribute('data-turn-key', 'turn-999');
  window.__probe_w.appendChild(t);
  document.body.appendChild(window.__probe_w);
  return 1;
})()`);
const t1 = Date.now();
let codexHideMs = -1;
for (let i = 0; i < 150; i++) {
  await sleep(20);
  const w = await evalJs(`Math.round((document.getElementById('chatgpt-nav-rail-host') || {getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width)`);
  if (!w) { codexHideMs = Date.now() - t1; break; }
}
result.codexHideMs = codexHideMs;
await evalJs('window.__probe_w.remove(); 1');
const t2 = Date.now();
let restoreMs = -1;
for (let i = 0; i < 200; i++) {
  await sleep(20);
  const w = await evalJs(`Math.round((document.getElementById('chatgpt-nav-rail-host') || {getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width)`);
  if (w > 4) { restoreMs = Date.now() - t2; break; }
}
result.restoreMs = restoreMs;

// ---- 3. 官方轨道出现 -> 让位 ----
await evalJs(`(() => {
  window.__probe_n = document.createElement('div');
  window.__probe_n.setAttribute('data-thread-user-message-navigation-rail-list', '1');
  window.__probe_n.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:180px;';
  document.body.appendChild(window.__probe_n);
  return 1;
})()`);
const t3 = Date.now();
let nativeHideMs = -1;
for (let i = 0; i < 150; i++) {
  await sleep(20);
  const w = await evalJs(`Math.round((document.getElementById('chatgpt-nav-rail-host') || {getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width)`);
  if (!w) { nativeHideMs = Date.now() - t3; break; }
}
result.nativeHideMs = nativeHideMs;
await evalJs('window.__probe_n.remove(); 1');
await sleep(800);
result.finalWidth = await evalJs(`Math.round((document.getElementById('chatgpt-nav-rail-host') || {getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width)`);
result.version = await evalJs('window.__chatgpt_nav_rail__.version');

console.log(JSON.stringify(result, null, 2));
ws.close();
