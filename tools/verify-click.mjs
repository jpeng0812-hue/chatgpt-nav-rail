// verify-click.mjs —— 验证"不挡点击"：命中测试 + 真实点击。
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('payload:', await evalJs('JSON.stringify(window.__chatgpt_nav_rail__?.debug())'));

// 1) 命中测试：网格采样，判断是否命中我们的宿主
const grid = JSON.parse(
  await evalJs(`(() => {
    const host = document.getElementById('chatgpt-nav-rail-host');
    const hr = host?.getBoundingClientRect();
    const sc = [...document.querySelectorAll('.thread-scroll-container')].find(s => s.getBoundingClientRect().height > 150);
    if (!sc) return JSON.stringify({ err: 'no scroller' });
    const sr = sc.getBoundingClientRect();
    const hits = [];
    for (let xi = 0; xi <= 8; xi++) {
      for (let yi = 0; yi <= 8; yi++) {
        const x = Math.round(sr.left + 8 + (sr.width - 16) * xi / 8);
        const y = Math.round(sr.top + 8 + (sr.height - 16) * yi / 8);
        const el = document.elementFromPoint(x, y);
        const mine = !!el && (el.id === 'chatgpt-nav-rail-host' || el.closest?.('#chatgpt-nav-rail-host'));
        hits.push({ x, y, mine, tag: el ? el.tagName.toLowerCase() : null });
      }
    }
    return JSON.stringify({ total: hits.length, mine: hits.filter(h => h.mine), rect: hr && { x: Math.round(hr.x), y: Math.round(hr.y), w: Math.round(hr.width), h: Math.round(hr.height) } });
  })()`)
);
console.log('grid:', JSON.stringify({ total: grid.total, mineHits: grid.mine.length, rail: grid.rect }));

// 2) 打开预览卡后再测：卡片区域除书签外都应穿透
const cardProbe = JSON.parse(
  await evalJs(`(() => {
    const host = document.getElementById('chatgpt-nav-rail-host');
    if (!host) return JSON.stringify({ err: 'no host' });
    const rows = [...host.shadowRoot.querySelectorAll('.row')];
    if (!rows.length) return JSON.stringify({ err: 'no rows' });
    const r = rows[0].getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`)
);
if (cardProbe.x) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardProbe.x, y: cardProbe.y, buttons: 0 });
  await sleep(400);
  const cardGrid = JSON.parse(
    await evalJs(`(() => {
      const host = document.getElementById('chatgpt-nav-rail-host');
      const card = host.shadowRoot.querySelector('.card');
      const cr = card.getBoundingClientRect();
      const out = { open: card.classList.contains('show'), w: Math.round(cr.width), h: Math.round(cr.height), mine: [], passThrough: 0, total: 0 };
      if (!out.open) return JSON.stringify(out);
      for (let xi = 1; xi <= 6; xi++) {
        for (let yi = 1; yi <= 4; yi++) {
          const x = Math.round(cr.left + cr.width * xi / 7);
          const y = Math.round(cr.top + cr.height * yi / 5);
          const el = document.elementFromPoint(x, y);
          out.total++;
          const mine = !!el && (el.id === 'chatgpt-nav-rail-host' || el.closest?.('#chatgpt-nav-rail-host'));
          if (mine) out.mine.push({ x, y, tag: el.tagName.toLowerCase() });
          else out.passThrough++;
        }
      }
      return JSON.stringify(out);
    })()`)
  );
  console.log('card:', JSON.stringify({ open: cardGrid.open, total: cardGrid.total, pass: cardGrid.passThrough, mine: cardGrid.mine.length }));
}

// 3) 真实点击：点"回到底部"按钮，看 scrollTop 是否变化
const clickTest = JSON.parse(
  await evalJs(`(() => {
    const sc = [...document.querySelectorAll('.thread-scroll-container')].find(s => s.getBoundingClientRect().height > 150);
    if (!sc) return JSON.stringify({ err: 'no scroller' });
    sc.scrollTo({ top: 0, behavior: 'instant' });
    return JSON.stringify({ top: Math.round(sc.scrollTop), sh: sc.scrollHeight });
  })()`)
);
await sleep(600);
const btn = JSON.parse(
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /回到底部|滚动到底部|scroll to bottom/i.test(x.getAttribute('aria-label')||''));
    if (!b) return JSON.stringify({ err: 'no-button' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), label: b.getAttribute('aria-label') });
  })()`)
);
console.log('button:', JSON.stringify(btn));
if (btn.x) {
  const before = JSON.parse(await evalJs(`JSON.stringify({top: Math.round([...document.querySelectorAll('.thread-scroll-container')].find(s=>s.getBoundingClientRect().height>150).scrollTop)})`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(900);
  const after = JSON.parse(await evalJs(`JSON.stringify({top: Math.round([...document.querySelectorAll('.thread-scroll-container')].find(s=>s.getBoundingClientRect().height>150).scrollTop)})`));
  console.log('click effect:', JSON.stringify({ before: before.top, after: after.top, worked: after.top > before.top }));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shots, 'click-check.png'), Buffer.from(shot.data, 'base64'));
console.log('screenshot saved');
ws.close();
