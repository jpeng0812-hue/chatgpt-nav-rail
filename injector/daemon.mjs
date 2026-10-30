#!/usr/bin/env node
/**
 * injector/daemon.mjs —— ChatGPT 桌面端导航栏注入守护进程（无扫描逻辑）
 *
 * 职责很窄：
 *   - 连上 CDP 端口，给每个 app:// 窗口注入 payload.js
 *   - Page.addScriptToEvaluateOnNewDocument：刷新/导航后仍在
 *   - Runtime.executionContextCreated：新上下文立刻补注入
 *   - 每 3 秒扫一次 /json/list：新窗口自动接管；断线自动重连
 *   - 单实例锁（127.0.0.1:port+1），避免看护与手动启动撞车
 *
 * 刻意不做的事：不主动滚动、不改布局、不隐藏任何内容 —— 那些会干扰点击。
 * 只监听 127.0.0.1。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg('port', process.env.NAV_CDP_PORT || 9333));
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PAYLOAD_PATH = arg('payload', path.join(HERE, 'payload.js'));
const LOG_PATH = arg('log', path.join(HERE, '..', 'nav-injector.log'));
const PAYLOAD = fs.readFileSync(PAYLOAD_PATH, 'utf8');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
  if (process.env.NAV_DEBUG) console.log(line);
}

const attached = new Map();

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2500) });
  const all = await res.json();
  return all.filter((t) => t.type === 'page' && /^app:\/\/-/.test(t.url));
}

async function attach(target) {
  const url = target.webSocketDebuggerUrl;
  if (!url) return;

  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });

  const inject = async (why) => {
    try {
      const r = await send('Runtime.evaluate', {
        expression: PAYLOAD,
        awaitPromise: true,
        returnByValue: false,
        userGesture: false,
      });
      if (r.exceptionDetails) log(`inject(${why}) error:`, JSON.stringify(r.exceptionDetails).slice(0, 300));
      else log(`inject(${why}) ok <- ${target.url}`);
    } catch (e) {
      log(`inject(${why}) failed:`, String(e).slice(0, 200));
    }
  };

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.executionContextCreated') {
      if (msg.params?.context?.auxData?.isDefault) inject('new-context');
      return;
    }
    if (msg.method === 'Page.frameNavigated' && msg.params?.frame?.parentId == null) {
      inject('frame-navigated');
      return;
    }
    if (msg.method === 'Page.loadEventFired') inject('load');
  });

  ws.addEventListener('close', () => {
    attached.delete(target.id);
    log(`detach ${target.url}`);
  });
  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {}
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
    setTimeout(() => reject(new Error('open timeout')), 5000);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  try {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PAYLOAD, runImmediately: true });
  } catch (e) {
    log('addScriptToEvaluateOnNewDocument failed (ignored):', String(e).slice(0, 120));
  }
  await inject('initial');

  attached.set(target.id, { close: () => ws.close() });
  log(`attach ${target.url} (windows: ${attached.size})`);
}

let emptyTicks = 0;

async function tick() {
  let targets = [];
  try {
    targets = await listTargets();
  } catch {
    targets = [];
  }
  // ChatGPT 关掉（或调试端口没了）时，注入器跟着退出：与应有"同生共死"
  if (targets.length === 0) {
    emptyTicks++;
    if (emptyTicks >= 5) {
      log(`no CDP targets for ${emptyTicks * 3}s, exiting (app closed?)`);
      process.exit(0);
    }
  } else {
    emptyTicks = 0;
  }
  const alive = new Set(targets.map((t) => t.id));
  for (const [id, h] of attached) {
    if (!alive.has(id)) {
      h.close();
      attached.delete(id);
    }
  }
  for (const t of targets) {
    if (attached.has(t.id)) continue;
    try {
      await attach(t);
    } catch (e) {
      log(`attach failed ${t.url}:`, String(e).slice(0, 160));
    }
  }
}

// ---- 单实例锁 ----
async function acquireLock() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(PORT + 1, '127.0.0.1', () => resolve(srv));
  });
}

let lockServer;
try {
  lockServer = await acquireLock();
} catch (e) {
  log(`another injector already holds 127.0.0.1:${PORT + 1} (${e.code || e.message}); exiting`);
  process.exit(0);
}

log(
  `daemon started - port=${PORT} - lock=${PORT + 1} - payload=${PAYLOAD_PATH} - v=${
    PAYLOAD.match(/VERSION = '([^']+)'/)?.[1] ?? '?'
  }`
);
await tick();
setInterval(tick, 3000);

process.on('SIGINT', () => {
  log('daemon stopping');
  try {
    if (lockServer) lockServer.close();
  } catch {}
  process.exit(0);
});
