// cdp-eval-all.mjs —— 对所有 page target 逐个执行同一个表达式，便于区分主窗口/浮层窗口。
import fs from 'node:fs';

const port = Number(process.argv[3] || 9333);
const expr = fs.readFileSync(process.argv[2], 'utf8');

const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');

async function runOn(target, idx) {
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
  try {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return { idx, url: target.url, ok: !res.exceptionDetails, value: res.result?.value, exception: res.exceptionDetails?.text };
  } catch (e) {
    return { idx, url: target.url, ok: false, error: String(e) };
  } finally {
    ws.close();
  }
}

const results = await Promise.all(list.map(runOn));
for (const r of results) {
  console.log(`--- target[${r.idx}] ${r.url}`);
  console.log(JSON.stringify(r.ok ? r.value : r.exception || r.error, null, 2));
}
