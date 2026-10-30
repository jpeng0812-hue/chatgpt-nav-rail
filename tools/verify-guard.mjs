// verify-guard.mjs —— 验证：Codex 模式 / 官方轨道出现时，本插件 300ms 级隐藏；撤掉后恢复。
const port = Number(process.env.CDP_PORT || 9333);

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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const visible = () => evalJs(`getComputedStyle(document.getElementById('chatgpt-nav-rail-host')).display !== 'none'`);
const label = () => evalJs(`document.querySelector('[aria-label^="切换模式"]')?.getAttribute('aria-label') || null`);

console.log('payload :', await evalJs('JSON.stringify(window.__chatgpt_nav_rail__?.debug())'));
console.log('mode    :', await label());
console.log('visible :', await visible());

// --- A. 模拟 Codex 模式：把模式按钮的 aria-label 改掉 ---
const original = await label();
const stubbed = (original || '').replace('ChatGPT', 'Codex');
await evalJs(`(() => { const b = document.querySelector('[aria-label^="切换模式"]'); if (b) b.setAttribute('aria-label', ${JSON.stringify(stubbed)}); return 'ok'; })()`);
await sleep(350);
const hiddenInCodex = !(await visible());
console.log('codex stub -> hidden within 350ms:', hiddenInCodex);

await evalJs(`(() => { const b = document.querySelector('[aria-label^="切换模式"]'); if (b) b.setAttribute('aria-label', ${JSON.stringify(original || '切换模式，当前模式：ChatGPT')}); return 'ok'; })()`);
await sleep(500);
const backVisible = await visible();
console.log('restore    -> visible again       :', backVisible);

// --- B. 伪造官方导航轨 ---
await evalJs(`(() => {
  const d = document.createElement('div');
  d.id = '__fake_native_rail__';
  d.setAttribute('data-thread-user-message-navigation-rail-list', '');
  d.style.cssText = 'position:fixed;left:8px;top:200px;width:36px;height:200px;';
  document.body.appendChild(d);
  return 'ok';
})()`);
await sleep(350);
const hiddenOnNative = !(await visible());
console.log('fake native -> hidden within 350ms:', hiddenOnNative);

await evalJs(`(() => { document.getElementById('__fake_native_rail__')?.remove(); return 'ok'; })()`);
await sleep(500);
const back2 = await visible();
console.log('remove fake -> visible again      :', back2);

console.log(
  'RESULT:',
  hiddenInCodex && backVisible && hiddenOnNative && back2 ? 'PASS' : 'FAIL',
  JSON.stringify({ hiddenInCodex, backVisible, hiddenOnNative, back2 })
);
ws.close();
