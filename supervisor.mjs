#!/usr/bin/env node
/**
 * supervisor.mjs —— 进程联动看护（GPT 起 → 导航起；GPT 关 → 导航关）
 *
 * 关键约束：Chromium 的 --remote-debugging-port 只能在启动那一刻给。
 * 所以"随 GPT 启动"的实现是：检测到 ChatGPT 刚被拉起（90s 内），
 * 立刻用带端口的启动器把它换掉（发生得很早，约 1-2 秒内）。
 * 对已经在跑很久的实例不做任何动作，绝不无缘无故杀进程。
 *
 * 廉价：2s 一次 TCP 探测；只有端口不在时才去问"应用在不在"。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STATE = path.join(process.env.LOCALAPPDATA || HERE, 'ChatGPTNavRail');
fs.mkdirSync(STATE, { recursive: true });

const LOG = path.join(STATE, 'supervisor.log');
const PIDFILE = path.join(STATE, 'daemon.pid');
const SEEN_AT = path.join(STATE, 'app-seen-at.txt');
const LAST_SWAP = path.join(STATE, 'last-restart.txt');
const ATTEMPTED = path.join(STATE, 'attempted-instance.txt');

const CFG_PATH = path.join(HERE, 'config.json');
let CFG = { port: 9333, autoRestart: true, restartGraceSec: 2, restartCooldownSec: 120 };
try {
  Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')));
} catch {}

const PORT = Number(CFG.port) || 9333;
const TICK_MS = 2000;
const FRESH_MS = 5 * 60 * 1000; // 5 分钟内出现的应用仍可尝试接管

const log = (...a) => {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch {}
};

function portOpen(port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeout, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

function daemonAlive() {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function startDaemon() {
  const daemon = path.join(HERE, 'injector', 'daemon.mjs');
  if (!fs.existsSync(daemon)) return log('missing daemon.mjs');
  const child = spawn(process.execPath, [daemon, '--port', String(PORT), '--log', path.join(STATE, 'injector.log')], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch {}
  log(`injector started pid=${child.pid}`);
}

function stopDaemon() {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (pid) { process.kill(pid); log(`injector stopped pid=${pid}`); }
  } catch {}
  try { fs.unlinkSync(PIDFILE); } catch {}
}

/**
 * 应用是否"真的在跑"：只数进程不够 —— 系统里可能残留 1-2 个杀不掉的 ChatGPT.exe。
 * 真实实例通常有 10+ 个进程（主进程 + GPU + 多个渲染器），据此判定。
 */
function appRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err || !out) return resolve(false);
      const count = (out.match(/ChatGPT\.exe/gi) || []).length;
      resolve(count >= 5);
    });
  });
}

/**
 * 事件驱动的启动检测：应用启动时会在 profile 目录里创建 lockfile。
 * 用 fs.watch 监听它，比每 6 秒一次 tasklist 快一个数量级（~50ms 级），
 * 也让"接管"发生在窗口还没画出来的时候 —— 闪退感几乎消失。
 */
let profileWatcher = null;
function startProfileWatcher() {
  if (profileWatcher) return;
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    const pkgs = fs.readdirSync(base).filter((d) => d.startsWith('OpenAI.Codex_'));
    for (const pkg of pkgs) {
      const dir = path.join(base, pkg, 'LocalCache', 'Roaming', 'Codex', 'web', 'Codex');
      if (!fs.existsSync(dir)) continue;
      const lockPath = path.join(dir, 'lockfile');
      profileWatcher = fs.watch(dir, { persistent: true }, async (_ev, name) => {
        const n = String(name || '').toLowerCase();
        if (n.indexOf('lock') < 0) return;
        if (!fs.existsSync(lockPath)) return;        // 删除事件 = 正在退出，忽略
        if (await portOpen(PORT)) return;            // 已经带端口，无需动作
        if (!CFG.autoRestart) return;
        attach('lockfile appeared (app booting)');
      });
      log('profile watcher on ' + dir);
      return;
    }
    log('profile watcher: no Codex profile dir found');
  } catch (e) {
    log('profile watcher failed: ' + e.message);
  }
}
const readNum = (f) => {
  try { return Number(fs.readFileSync(f, 'utf8').trim()) || 0; } catch { return 0; }
};

let misses = 0;
let lastAppCheck = 0;   // 应用存在性检查（tasklist）的最小间隔，降低空闲开销

const LAUNCHER_LOG = path.join(STATE, 'launcher.log');

/** 发起一次"换成带端口启动"的接管：节流 + 记录 + 拉起启动器 */
function attach(reason) {
  const now = Date.now();
  // 刚尝试过就歇 20 秒：应用重启过程中状态会抖动，否则会被误判成"新实例"而反复杀
  if (now - readNum(LAST_SWAP) < 20000) return false;
  try {
    fs.writeFileSync(LAST_SWAP, String(now));
  } catch {}
  log(`attach (${reason}) -> debug-port launch`);

  // 注意：不要用 detached:true —— Windows 上它是 DETACHED_PROCESS（无控制台），
  // 在这种进程里做 AUMID 激活会静默失败（表现为"拉了启动器但应用没带端口"）。
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = fs.openSync(LAUNCHER_LOG, 'a');
  const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'launch.ps1')], {
    detached: false,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('error', (e) => log('spawn launcher failed:', e.message));
  child.on('exit', (code) => log(`launcher exited code=${code}`));
  child.unref();
  return true;
}
async function tick() {
  const now = Date.now();
  const open = await portOpen(PORT);

  if (open) {
    misses = 0;
    if (!daemonAlive()) startDaemon();
    return;
  }

  // 端口不在：应用关了 -> 注入器跟着关
  misses++;
  if (misses >= 2 && daemonAlive()) stopDaemon();

  // 端口不在时才需要问"应用在不在"；tasklist 会起子进程，所以最多每 6 秒问一次
  if (now - lastAppCheck < 6000) return;
  lastAppCheck = now;
  if (!(await appRunning())) {
    try { fs.unlinkSync(SEEN_AT); } catch {}
    return;
  }

  // 应用在跑但没有端口
  let seenAt = readNum(SEEN_AT);
  if (!seenAt) {
    seenAt = now;
    try { fs.writeFileSync(SEEN_AT, String(seenAt)); } catch {}
    log('app appeared without the debug port');
  }

  if (!CFG.autoRestart) return;
  if (now - seenAt >= FRESH_MS) return; // 跑了很久的老实例不打扰

  // 关键：每个"实例"只尝试一次，而不是按时间冷却。
  // 否则冷却期正好覆盖了"刚启动"窗口，就会永久错过（这正是之前又失效的原因）。
  if (readNum(ATTEMPTED) === seenAt) return;
  // 刚尝试过就歇 20 秒：应用重启过程中进程数会抖动（<5），否则会被误判成"又出现了"而反复杀。
  if (now - readNum(LAST_SWAP) < 20000) return;
  try { fs.writeFileSync(ATTEMPTED, String(seenAt)); } catch {}
  attach(`fresh instance (${Math.round((now - seenAt) / 1000)}s)`);
  return;
}

log(`supervisor started (node ${process.versions.node}, port=${PORT}, autoRestart=${!!CFG.autoRestart})`);
startProfileWatcher();
tick();
setInterval(tick, TICK_MS);
