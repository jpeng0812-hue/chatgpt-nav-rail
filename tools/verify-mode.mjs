// verify-mode.mjs —— 真实切换到 Codex / 切回 ChatGPT，测量本插件隐藏与恢复的延迟。
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
};
const state = () =>
  evalJs(`(() => {
    const h = document.getElementById('chatgpt-nav-rail-host');
    return JSON.stringify({
      mode: document.querySelector('[aria-label^="切换模式"]')?.getAttribute('aria-label') || null,
      display: h ? getComputedStyle(h).display : 'none',
    });
  })()`);

async function openMenu() {
  const btn = JSON.parse(
    await evalJs(`(() => { const e = document.querySelector('[aria-label^="切换模式"]'); const r = e.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}); })()`)
  );
  await click(btn.x, btn.y);
  for (let i = 0; i < 15; i++) {
    await sleep(120);
    const items = JSON.parse(
      await evalJs(`(() => JSON.stringify([...document.querySelectorAll('[role="menuitem"]')].map(e => { const r = e.getBoundingClientRect(); return { text: (e.innerText||'').trim().replace(/\\s+/g,' '), x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), h: Math.round(r.height) }; }).filter(x => x.h > 20)))()`)
    );
    const hit = items.find((x) => /^(Codex|ChatGPT)/.test(x.text));
    if (hit) return items;
  }
  return [];
}

async function switchTo(prefix) {
  const items = await openMenu();
  const hit = items.find((x) => x.text.startsWith(prefix));
  if (!hit) return { ok: false, items: items.map((i) => i.text) };
  await click(hit.x, hit.y);
  return { ok: true };
}

async function waitFor(predicate, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = JSON.parse(await state());
    if (predicate(s)) return { hit: true, ms: Date.now() - t0, s };
    await sleep(stepMs);
  }
  return { hit: false, ms: -1, s: JSON.parse(await state()) };
}

console.log('start:', await state());

// A. 切到 Codex，测"我们的轨道多久消失"
const toCodex = await switchTo('Codex');
console.log('switch request:', JSON.stringify(toCodex));
if (toCodex.ok) {
  const r = await waitFor((s) => s.display === 'none', 10000);
  console.log('codex -> hidden:', JSON.stringify({ hit: r.hit, ms: r.ms, state: r.s }));
  await sleep(1500);
  console.log('codex steady  :', await state());
}

// B. 切回 ChatGPT，测"多久恢复"
const back = await switchTo('ChatGPT');
console.log('switch back:', JSON.stringify(back));
if (back.ok) {
  const r = await waitFor((s) => s.display !== 'none', 10000);
  console.log('chat  -> visible:', JSON.stringify({ hit: r.hit, ms: r.ms, state: r.s }));
}
ws.close();
