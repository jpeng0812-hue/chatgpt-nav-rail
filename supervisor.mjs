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

const CFG_PATH = path.join(HERE, 'config.json');
let CFG = { port: 9333, autoRestart: true, restartGraceSec: 2, restartCooldownSec: 120 };
try {
  Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')));
} catch {}

const PORT = Number(CFG.port) || 9333;
const TICK_MS = 2000;
const FRESH_MS = 90 * 1000; // 90 秒内出现的应用视为"刚启动"

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

const readNum = (f) => {
  try { return Number(fs.readFileSync(f, 'utf8').trim()) || 0; } catch { return 0; }
};

let misses = 0;

async function tick() {
  const open = await portOpen(PORT);

  if (open) {
    misses = 0;
    if (!daemonAlive()) startDaemon();
    return;
  }

  // 端口不在：应用关了 -> 注入器跟着关
  misses++;
  if (misses >= 2 && daemonAlive()) stopDaemon();

  if (!(await appRunning())) {
    try { fs.unlinkSync(SEEN_AT); } catch {}
    return;
  }

  // 应用在跑但没有端口
  const now = Date.now();
  let seenAt = readNum(SEEN_AT);
  if (!seenAt) {
    seenAt = now;
    try { fs.writeFileSync(SEEN_AT, String(seenAt)); } catch {}
    log('app appeared without the debug port');
  }

  if (!CFG.autoRestart) return;
  const fresh = now - seenAt < FRESH_MS;
  if (!fresh) return; // 老实例不打扰

  const cooldown = Number(CFG.restartCooldownSec) * 1000;
  if (now - readNum(LAST_SWAP) < cooldown) return;

  try { fs.writeFileSync(LAST_SWAP, String(now)); } catch {}
  log(`app is fresh (${Math.round((now - seenAt) / 1000)}s) -> switching it to a debug-port launch`);
  try { fs.unlinkSync(SEEN_AT); } catch {}
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'launch.ps1'), '-Quiet'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  p.unref();
}

log(`supervisor started (node ${process.versions.node}, port=${PORT}, autoRestart=${!!CFG.autoRestart})`);
tick();
setInterval(tick, TICK_MS);
