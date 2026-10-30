// cdp-cmd.mjs —— 执行一串 CDP 命令（JSON 文件），支持键盘事件与裁剪截图。
// 用法: node cdp-cmd.mjs cmds.json [port]
import fs from 'node:fs';

const cmdsFile = process.argv[2];
const port = Number(process.argv[3] || 9333);
const cmds = JSON.parse(fs.readFileSync(cmdsFile, 'utf8').replace(/^\uFEFF/, ''));

const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
const target = list.find((t) => /index\.html$/.test(t.url)) || list[0];
if (!target) throw new Error('no target');

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

for (const cmd of cmds) {
  const { save, wait, ...rest } = cmd;
  const res = await send(rest.method, rest.params || {});
  if (save) {
    fs.writeFileSync(save, Buffer.from(res.data, 'base64'));
    console.log('saved', save);
  } else if (rest.method === 'Runtime.evaluate') {
    console.log(JSON.stringify(res.result?.value ?? res.result));
  } else {
    console.log(JSON.stringify({ ok: rest.method }));
  }
  if (wait) await new Promise((r) => setTimeout(r, wait));
}
ws.close();
