// cdp-eval.mjs —— 通过 CDP 在 ChatGPT 渲染进程里执行一段 JS 表达式并打印结果。
// 用法: node cdp-eval.mjs <exprFile> [port] [urlRegex]
import fs from 'node:fs';

const port = Number(process.argv[3] || 9333);
const exprFile = process.argv[2];
const urlRe = new RegExp(process.argv[4] || 'index\\.html');
const expr = fs.readFileSync(exprFile, 'utf8');

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && urlRe.test(t.url)) || list.find((t) => t.type === 'page');
if (!target) throw new Error('no page target');

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
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const res = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
if (res.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(res.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(res.result.value ?? res.result, null, 2));
}
ws.close();
