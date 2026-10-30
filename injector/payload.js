/**
 * ChatGPT 桌面端 · Chat 模式「提问导航」（左侧横向短线）
 * ---------------------------------------------------------------
 * v3.1 = **回退到上一轮（v3.0.2）的架构** + 点击穿透硬化
 *
 * 明确去掉 v4 这些会吞点击/改布局的东西：
 *   ✗ 全量扫描（把 transcript 设 visibility:hidden）
 *   ✗ 给会话容器加 paddingLeft 改布局
 *   ✗ 跨窗口累计索引 / 定点寻址
 *
 * 点击穿透按 AI-MarkDone 的做法：
 *   - :host 与卡片都是 pointer-events:none，只有 28px 轨道条 + 22px 书签按钮接事件；
 *   - 文档级 capture pointerdown：点在轨道/卡片之外立即收起预览，且绝不 preventDefault；
 *   - 滚轮/滚动/按键/Escape 都会收起预览，卡片不会停留盖在正文上。
 *
 * 其余规格沿用上一轮：只给"你的提问"刻度、留白 < 48px 不显示、
 * 官方轨道任一可见即让位、Work/Codex（turn-N）完全不介入、收藏按会话本地保存。
 */
(() => {
  const GLOBAL_KEY = '__chatgpt_nav_rail__';
  const VERSION = '3.3.0';

  if (window[GLOBAL_KEY]) {
    if (window[GLOBAL_KEY].version === VERSION) {
      window[GLOBAL_KEY].refresh();
      return;
    }
    try {
      window[GLOBAL_KEY].destroy();
    } catch {}
  }
  document.querySelectorAll('#chatgpt-nav-rail-host').forEach((n) => n.remove());

  // 清掉旧版本可能留下的副作用：扫描时隐藏的内容、给容器加的 padding
  try {
    document.querySelectorAll('.thread-scroll-container').forEach((el) => {
      if (el.style && el.style.visibility === 'hidden') el.style.visibility = '';
    });
    document
      .querySelectorAll('[data-thread-find-target="conversation"], [data-thread-user-message-navigation-content]')
      .forEach((el) => {
        if (el.style && el.style.paddingLeft) el.style.paddingLeft = '';
      });
  } catch {}

  const SELECTORS = {
    scrollContainer: ['.thread-scroll-container', '[data-pip-anchor-host="codex-main-thread"]'],
    transcriptRoot: ['[data-thread-find-target="conversation"]', '[data-thread-user-message-navigation-content]'],
    userMessage: ['[data-user-message-bubble]', '[data-local-conversation-user-anchor]'],
    userRole: ['[data-conversation-role="user"]'],
    nativeRail: ['[data-thread-user-message-navigation-rail-list]'],
  };

  const CFG = {
    minMessages: 2,
    minGutter: 48,
    railWidth: 28,
    sideOffset: 12,
    barUser: 20,
    barActive: 26,
    rowMin: 3,
    rowMax: 11,
    maxRailHeight: 620,
    cardWidth: 384,
    cardGap: 18,
    hoverDelay: 90,
    hideDelay: 200,
    rescanDebounce: 140,
  };

  const q1 = (root, list) => {
    for (const sel of list) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  const qAll = (root, list) => {
    for (const sel of list) {
      const found = root.querySelectorAll(sel);
      if (found.length) return Array.from(found);
    }
    return [];
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const state = {
    host: null,
    rail: null,
    card: null,
    cardTitle: null,
    cardBody: null,
    cardMark: null,
    scroller: null,
    items: [],
    activeIndex: -1,
    hoverIndex: -1,
    collapsed: false,
    raf: 0,
    timer: 0,
    watchdog: 0,
    hoverTimer: 0,
    hideTimer: 0,
    lastKey: '',
    railH: 0,
    rowH: 0,
    gutter: 0,
    io: null,
    archive: new Map(),
    scrollerEl: null,
    suppressed: false,
    ticks: 0,
    guards: 0,
    guardTimer: 0,
    modeMo: null,
    chatKey: '',
    marks: {},
    keyEvents: 0,
    toggles: 0,
  };

  try {
    state.collapsed = localStorage.getItem('chatgpt-nav-rail:collapsed') === '1';
    state.marks = JSON.parse(localStorage.getItem('chatgpt-nav-rail:marks') || '{}') || {};
  } catch {}

  // ---------------------------------------------------------------- 样式
  const CSS = `
    :host { all: initial; }

    /* 只有这条窄轨接事件，其余一律穿透 */
    .rail { position: relative; width: ${CFG.railWidth}px; display: flex; flex-direction: column;
      align-items: flex-end; justify-content: center; pointer-events: auto;
      font: 500 12px/1.4 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: var(--color-text, #1a1c1f); }
    .rail.collapsed { width: 8px; opacity: .55; }
    .rail.collapsed:hover { opacity: 1; }

    .row { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center;
      justify-content: flex-end; cursor: pointer; border-radius: 2px; position: relative; }
    .row:focus-visible { outline: 1px solid color-mix(in srgb, currentColor 45%, transparent); outline-offset: 2px; }
    .bar { display: block; width: ${CFG.barUser}px; height: 2px; border-radius: 999px;
      background: color-mix(in srgb, currentColor 32%, transparent);
      transition: width .12s ease, height .12s ease, background .12s ease; }
    .row:hover .bar, .row.hover .bar { width: ${CFG.barActive - 4}px; height: 3px;
      background: color-mix(in srgb, currentColor 60%, transparent); }
    .row.active .bar { width: ${CFG.barActive}px; height: 3px;
      background: color-mix(in srgb, currentColor 92%, transparent); }
    .rail.collapsed .row .bar { width: 6px; }
    .row.marked::before { content: ''; position: absolute; left: 0; top: 50%; width: 4px; height: 4px;
      margin-top: -2px; border-radius: 999px; background: color-mix(in srgb, currentColor 55%, transparent); }

    .handle { all: unset; position: absolute; right: 1px; top: -17px; width: 15px; height: 15px;
      display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer;
      color: color-mix(in srgb, currentColor 45%, transparent); opacity: 0;
      transition: opacity .15s ease, color .15s ease; font-size: 11px; line-height: 1; }
    .rail:hover .handle { opacity: .8; }
    .handle:hover { color: color-mix(in srgb, currentColor 85%, transparent); }

    /* 预览卡：永远不接事件（不会挡住正文点击），只有里面的书签按钮例外 */
    .card { position: absolute; width: ${CFG.cardWidth}px; max-width: 46vw;
      padding: 12px 14px 13px; border-radius: 14px;
      background: var(--color-surface, #ffffff); color: var(--color-text, #1a1c1f);
      box-shadow: 0 12px 34px rgba(0,0,0,.13), 0 2px 8px rgba(0,0,0,.06),
                  inset 0 0 0 1px color-mix(in srgb, var(--color-text, #1a1c1f) 9%, transparent);
      pointer-events: none; opacity: 0; visibility: hidden; transform: translateY(3px);
      transition: opacity .12s ease, transform .12s ease; z-index: 5;
      font: 400 13.5px/1.6 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .card.show { opacity: 1; visibility: visible; transform: translateY(0); }
    .card .title { font-size: 15px; font-weight: 600; line-height: 1.45; letter-spacing: .005em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 26px; }
    .card .body { margin-top: 6px; color: var(--color-text-secondary, color-mix(in srgb, var(--color-text, #1a1c1f) 62%, transparent));
      display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
      white-space: pre-wrap; word-break: break-word; }
    .card .body:empty { display: none; }
    .card .mark { all: unset; position: absolute; top: 9px; right: 10px; width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center; border-radius: 6px; cursor: pointer;
      pointer-events: auto; /* 只有这 22×22 会接事件 */
      color: color-mix(in srgb, currentColor 38%, transparent); }
    .card .mark:hover { background: color-mix(in srgb, currentColor 8%, transparent); color: color-mix(in srgb, currentColor 70%, transparent); }
    .card .mark.on { color: color-mix(in srgb, currentColor 85%, transparent); }
    .card .mark svg { width: 15px; height: 15px; display: block; }
  `;

  const BOOKMARK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 4.5h12v15l-6-3.6-6 3.6z"/></svg>';

  // ---------------------------------------------------------------- DOM
  function ensureHost() {
    if (state.host && state.host.isConnected) return;
    const host = document.createElement('div');
    host.id = 'chatgpt-nav-rail-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:none;display:none;contain:layout style;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const rail = document.createElement('div');
    rail.className = 'rail';
    rail.setAttribute('role', 'navigation');
    rail.setAttribute('aria-label', '提问导航');

    const handle = document.createElement('button');
    handle.className = 'handle';
    handle.type = 'button';
    handle.title = '收起/展开导航栏 (Alt+N)';
    handle.textContent = '⌄';

    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('div');
    title.className = 'title';
    const body = document.createElement('div');
    body.className = 'body';
    const mark = document.createElement('button');
    mark.className = 'mark';
    mark.type = 'button';
    mark.title = '收藏这条提问 (Alt+B)';
    mark.innerHTML = BOOKMARK_SVG;
    card.append(title, body, mark);

    rail.append(card, handle);
    shadow.append(style, rail);
    document.body.appendChild(host);
    Object.assign(state, { host, rail, card, cardTitle: title, cardBody: body, cardMark: mark });

    handle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse();
      layout(true);
    });

    mark.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMark(state.items[state.hoverIndex]);
    });

    rail.addEventListener('mouseleave', () => scheduleHide());
    rail.addEventListener('mousemove', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('.row') : null;
      if (!row) return;
      const i = Number(row.dataset.index);
      if (i === state.hoverIndex) return;
      state.hoverIndex = i;
      clearTimeout(state.hideTimer);
      clearTimeout(state.hoverTimer);
      state.hoverTimer = setTimeout(() => renderHover(i), CFG.hoverDelay);
    });

    // 参考 AI-MarkDone：文档级 capture pointerdown，点在外面就收起预览；绝不 preventDefault
    document.addEventListener(
      'pointerdown',
      (e) => {
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(host)) renderHover(-1);
      },
      true
    );
    window.addEventListener('wheel', () => renderHover(-1), { passive: true, capture: true });
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') renderHover(-1);
      },
      true
    );

    applyCollapsed();
  }

  function scheduleHide() {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => renderHover(-1), CFG.hideDelay);
  }

  function applyCollapsed() {
    if (state.rail) state.rail.classList.toggle('collapsed', state.collapsed);
  }

  function toggleCollapse() {
    state.toggles++;
    state.collapsed = !state.collapsed;
    try {
      localStorage.setItem('chatgpt-nav-rail:collapsed', state.collapsed ? '1' : '0');
    } catch {}
    applyCollapsed();
    if (state.collapsed) renderHover(-1);
    layout(true); // 宿主宽度是行内样式，必须重排一次
  }

  // ---------------------------------------------------------------- 收藏
  const isMarked = (it) => !!(it && state.marks[state.chatKey] && state.marks[state.chatKey][it.key]);
  function toggleMark(it) {
    if (!it) return;
    const bucket = (state.marks[state.chatKey] = state.marks[state.chatKey] || {});
    if (bucket[it.key]) delete bucket[it.key];
    else bucket[it.key] = 1;
    try {
      localStorage.setItem('chatgpt-nav-rail:marks', JSON.stringify(state.marks));
    } catch {}
    syncMarks();
    renderHover(state.hoverIndex);
  }
  function syncMarks() {
    for (const it of state.items) if (it.row) it.row.classList.toggle('marked', isMarked(it));
  }

  // ---------------------------------------------------------------- 采集
  // —— 模式判定：应用自己的模式切换按钮是最可靠的信号 ——
  function getMode() {
    const btn = document.querySelector('[aria-label^="切换模式"]');
    const label = btn ? btn.getAttribute('aria-label') || '' : '';
    if (label.indexOf('Codex') >= 0) return 'codex';
    if (label.indexOf('ChatGPT') >= 0) return 'chat';
    return null;
  }

  // Codex/Work 的结构特征：turn-N 的轮次，或 Codex 专属的 main 容器
  function looksCodex() {
    if (document.querySelector('[data-turn-key^="turn-"]')) return true;
    const main = document.querySelector('main[data-thread-user-message-navigation-content]');
    return !!(main && main.getBoundingClientRect().height > 0);
  }

  function nativeRailVisible() {
    return Array.from(document.querySelectorAll(SELECTORS.nativeRail.join(','))).some(
      (el) => el.isConnected && el.getBoundingClientRect().height > 0
    );
  }

  // 300ms 级守卫：Codex/Work 或官方轨道一出现就立刻隐藏，不等 debounce
  function guardTick() {
    state.guards++;
    if (!state.host) return;
    const blocked = getMode() === 'codex' || looksCodex() || nativeRailVisible();
    if (blocked) {
      if (!state.suppressed) {
        state.suppressed = true;
        hide();
        renderHover(-1);
      }
      return;
    }
    if (state.suppressed) {
      state.suppressed = false;
      schedule(60);
      return;
    }
    // 自愈：有会话容器但还没刻度（刚切会话/刚启动）时补一次测量
    if (!state.items.length && q1(document, SELECTORS.scrollContainer)) schedule(200);
  }

  const frames = (n) =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => (n > 2 ? frames(n - 2) : r()))));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const turnKeyOf = (el) => {
    const t = el.closest('[data-turn-key]');
    return t ? t.getAttribute('data-turn-key') || '' : '';
  };

  // 注意：本文件里有个叫 CSS 的样式字符串常量，会遮蔽全局 CSS 对象，
  // 所以不能直接用 CSS.escape —— 这里自己实现一份。
  const cssEscape = (s) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(s));
    return String(s).replace(/["\\]/g, '\\$&');
  };

  function findMounted(key) {
    const sc = state.scroller;
    if (!sc) return null;
    const turn = sc.querySelector(`[data-turn-key="${cssEscape(key)}"]`);
    if (!turn) return null;
    return turn.querySelector('[data-user-message-bubble]') || turn.querySelector('[data-local-conversation-user-anchor]') || turn;
  }

  // 被动累积：把当前挂载的提问登记进 archive（不滚动、不隐藏、不改布局）
  function mergeArchive() {
    const sc = state.scroller;
    if (!sc) return;
    let bubbles = qAll(sc, SELECTORS.userMessage);
    if (!bubbles.length) bubbles = qAll(sc, SELECTORS.userRole).map((h) => h.parentElement).filter(Boolean);
    const sr = sc.getBoundingClientRect();
    for (const el of bubbles) {
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 8) continue;
      const key = turnKeyOf(el);
      if (!key) continue;
      const offset = Math.round(sc.scrollTop + (r.top - sr.top));
      const prev = state.archive.get(key);
      if (!prev) state.archive.set(key, { key, text: cleanText(el), offset, el });
      else {
        prev.el = el;
        prev.offset = offset;
        if (!prev.text) prev.text = cleanText(el);
      }
    }
  }

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('h4, [data-conversation-role], button, svg, time, .sr-only').forEach((n) => n.remove());
    return (clone.innerText || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s*((星期|周)[一二三四五六日天]\s*)?\d{1,2}:\d{2}\s*$/u, '')
      .trim();
  }

  function pickScroller() {
    const cands = [];
    for (const sel of SELECTORS.scrollContainer) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 150) cands.push({ el, h: el.clientHeight });
      }
      if (cands.length) break;
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.h - a.h);
    return cands[0].el;
  }

  function collect() {
    if (getMode() === 'codex' || looksCodex()) return { notChat: true, scroller: null };
    const scroller = pickScroller();
    if (!scroller) return null;

    const nativeVisible = Array.from(document.querySelectorAll(SELECTORS.nativeRail.join(','))).some(
      (el) => el.isConnected && el.getBoundingClientRect().height > 0
    );
    if (nativeVisible) return { native: true, scroller };

    const chatTurns = Array.from(scroller.querySelectorAll('[data-turn-key]')).filter(
      (t) => !/^turn-\d+$/.test(t.getAttribute('data-turn-key') || '')
    );
    if (!chatTurns.length) return { notChat: true, scroller };

    let bubbles = qAll(scroller, SELECTORS.userMessage);
    if (!bubbles.length) bubbles = qAll(scroller, SELECTORS.userRole).map((h) => h.parentElement).filter(Boolean);
    if (!bubbles.length) return { notChat: true, scroller };

    const seen = new Set();
    const items = [];
    for (const el of bubbles) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 8) continue;
      const turn = el.closest('[data-turn-key]');
      const turnKey = turn ? turn.getAttribute('data-turn-key') || '' : '';
      items.push({ el, text: cleanText(el), id: `${turnKey}#${items.length}`, turnKey });
    }
    if (!items.length) return { notChat: true, scroller };

    return { scroller, conv: q1(scroller, SELECTORS.transcriptRoot) || scroller, items };
  }

  // ---------------------------------------------------------------- 测量 / 渲染
  function measure() {
    const data = collect();
    if (!data) return reset();
    if (data.notChat || data.native) return reset();

    const { scroller, conv } = data;
    state.scroller = scroller;

    // 换会话 / 换容器 -> 清空累积
    const titleKey = (document.title || "").trim() || "unknown";
    if (titleKey !== state.chatKey || scroller !== state.scrollerEl) {
      state.chatKey = titleKey;
      state.scrollerEl = scroller;
      state.archive.clear();
    }

    mergeArchive();
    if (!state.archive.size) return reset();

    const sr = scroller.getBoundingClientRect();
    const cr = conv.getBoundingClientRect();
    let textLeft = cr.left;
    if (!(textLeft > sr.left + 8) || !(textLeft < sr.right)) textLeft = sr.left + 64;
    state.gutter = Math.round(textLeft - sr.left);
    if (state.gutter < CFG.minGutter) return reset();

    const list = [...state.archive.values()].sort((a, b) => a.offset - b.offset);
    if (list.length < CFG.minMessages) return reset();

    const maxH = Math.min(CFG.maxRailHeight, Math.max(150, sr.height - 150));
    state.rowH = clamp(Math.floor(maxH / list.length), CFG.rowMin, CFG.rowMax);
    state.railH = state.rowH * list.length;

    const prevSig = state.items.map((i) => i.key).join("|");
    state.items = list;
    const sig = list.map((i) => i.key).join("|");

    show();
    if (prevSig !== sig) {
      renderRows();
      observeItems();
    }
    syncMarks();
    layout(true);
    updateActive();
  }

  function renderRows() {
    state.rail.querySelectorAll('.row').forEach((r) => r.remove());
    const frag = document.createDocumentFragment();
    state.items.forEach((it, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row';
      row.dataset.index = String(i);
      row.style.height = `${state.rowH}px`;
      row.setAttribute('aria-label', `${i + 1}. ${(it.text || '你的提问').slice(0, 60)}`);
      const bar = document.createElement('span');
      bar.className = 'bar';
      row.appendChild(bar);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpTo(i);
      });
      row.addEventListener('pointerenter', () => {
        state.hoverIndex = i;
        clearTimeout(state.hideTimer);
        clearTimeout(state.hoverTimer);
        state.hoverTimer = setTimeout(() => renderHover(i), CFG.hoverDelay);
      });
      frag.appendChild(row);
      it.row = row;
    });
    state.rail.appendChild(frag);
  }

  // ---------------------------------------------------------------- 高亮
  function observeItems() {
    if (state.io) state.io.disconnect();
    if (!('IntersectionObserver' in window)) return;
    state.io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const it = state.items.find((x) => x.el === en.target);
          if (it) it.visible = en.isIntersecting;
        }
        updateActive();
      },
      { root: state.scroller, rootMargin: '-8px 0px -55% 0px', threshold: [0, 0.01] }
    );
    for (const it of state.items) if (it.el && it.el.isConnected) state.io.observe(it.el);
  }

  function updateActive() {
    if (!state.items.length || !state.scroller) return;
    const sr = state.scroller.getBoundingClientRect();
    let best = -1;
    let bestTop = -Infinity;
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i];
      if (!it.visible || !it.el || !it.el.isConnected) continue;
      const top = it.el.getBoundingClientRect().top - sr.top;
      if (top > bestTop) {
        bestTop = top;
        best = i;
      }
    }
    if (best < 0 || best === state.activeIndex) return;
    const prev = state.items[state.activeIndex];
    if (prev && prev.row) {
      prev.row.classList.remove('active');
      prev.row.removeAttribute('aria-current');
    }
    state.activeIndex = best;
    const cur = state.items[best];
    if (cur && cur.row) {
      cur.row.classList.add('active');
      cur.row.setAttribute('aria-current', 'true');
    }
  }

  // ---------------------------------------------------------------- 布局
  function layout(force) {
    if (!state.host || !state.scroller || !state.scroller.isConnected) return;
    const sr = state.scroller.getBoundingClientRect();
    if (sr.width < 160 || sr.height < 160) return hide();

    const w = state.collapsed ? 8 : CFG.railWidth;
    const h = state.railH || 100;
    const left = Math.round(sr.left + CFG.sideOffset);
    const top = Math.round(sr.top + (sr.height - h) / 2);

    const key = `${left}|${top}|${h}|${w}`;
    if (!force && key === state.lastKey) return;
    state.lastKey = key;
    state.host.style.cssText =
      'position:fixed;z-index:2147483000;pointer-events:none;display:block;contain:layout style;' +
      `left:${left}px;top:${top}px;width:${w}px;height:${h}px;`;
  }

  const show = () => state.host && (state.host.style.display = 'block');
  const hide = () => state.host && (state.host.style.display = 'none');
  function reset() {
    hide();
    state.items = [];
    state.activeIndex = -1;
    state.hoverIndex = -1;
    if (state.io) state.io.disconnect();
    if (state.rail) state.rail.querySelectorAll('.row').forEach((r) => r.remove());
    if (state.card) state.card.classList.remove('show');
  }

  // ---------------------------------------------------------------- 跳转
  function flash(el) {
    if (!el || !el.style) return;
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '2px solid color-mix(in srgb, currentColor 45%, transparent)';
    el.style.outlineOffset = '6px';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 1200);
  }

  async function seekTo(it) {
    const sc = state.scroller;
    if (!sc) return null;
    let el = findMounted(it.key);
    if (el) return el;
    const limit = Math.max(0, sc.scrollHeight - sc.clientHeight);
    let step = Math.round(sc.clientHeight * 0.9);
    let y = clamp(it.offset - 40, 0, limit);
    for (let i = 0; i < 40 && !el; i++) {
      sc.scrollTop = y;
      await frames(2);
      await sleep(90);
      el = findMounted(it.key);
      if (el) break;
      const sr = sc.getBoundingClientRect();
      let min = Infinity;
      let max = -Infinity;
      for (const t of sc.querySelectorAll('[data-turn-key]')) {
        const r = t.getBoundingClientRect();
        if (r.height <= 0) continue;
        min = Math.min(min, sc.scrollTop + (r.top - sr.top));
        max = Math.max(max, sc.scrollTop + (r.bottom - sr.top));
      }
      const dir = it.offset < min ? -1 : 1;
      y = clamp(y + dir * step, 0, limit);
      if (i > 5) step = Math.max(200, Math.round(step * 0.75));
    }
    return el;
  }

  async function jumpTo(i) {
    const it = state.items[i];
    if (!it) return { ok: false, why: 'no-item' };
    if (!state.scroller) return { ok: false, why: 'no-scroller' };
    const el = it.el && it.el.isConnected ? it.el : await seekTo(it);
    if (!el) {
      return {
        ok: false,
        why: 'not-mounted',
        key: it.key,
        offset: it.offset,
        scrollerTop: Math.round(state.scroller.scrollTop),
        scrollerSh: state.scroller.scrollHeight,
        turns: state.scroller.querySelectorAll('[data-turn-key]').length,
      };
    }
    // 不用 scrollIntoView：应用的"跟随底部"会把它吸回去。
    // 直接算绝对偏移并设 scrollTop，然后多次纠偏（与官方组件 350ms 重试同思路）。
    const sc = state.scroller;
    const align = () => {
      const sr = sc.getBoundingClientRect();
      const delta = el.getBoundingClientRect().top - sr.top;
      if (!Number.isFinite(delta)) return 0;
      if (Math.abs(delta) > 8) sc.scrollTop = Math.max(0, sc.scrollTop + delta - 16);
      return delta;
    };
    align();
    flash(el);
    state.activeIndex = -1;
    (async () => {
      for (let k = 0; k < 4; k++) {
        await sleep(320);
        if (Math.abs(align()) <= 8) break;
      }
      measure();
    })();
    return { ok: true, key: it.key, top: Math.round(sc.scrollTop) };
  }

  function jumpRelative(delta) {
    if (!state.items.length) return;
    const cur = state.activeIndex < 0 ? 0 : state.activeIndex;
    jumpTo(clamp(cur + delta, 0, state.items.length - 1));
  }

  // ---------------------------------------------------------------- 预览卡
  function splitPreview(text) {
    const lines = (text || '')
      .split('\n')
      .map((s) => s.replace(/\s+$/, ''))
      .filter((s) => s.trim());
    if (!lines.length) return { title: '（附件或空消息）', body: '' };
    const title = lines[0].slice(0, 140);
    let body = lines.slice(1).join('\n').trim();
    if (!body && title.length > 56) body = lines[0].slice(56);
    return { title, body: body.slice(0, 900) };
  }

  function renderHover(i) {
    if (!state.card) return;
    state.rail.querySelectorAll('.row.hover').forEach((r) => r.classList.remove('hover'));
    if (i < 0 || !state.items[i]) {
      state.hoverIndex = -1;
      state.card.classList.remove('show');
      return;
    }
    const it = state.items[i];
    if (it.row) it.row.classList.add('hover');

    const pv = splitPreview(it.text);
    state.cardTitle.textContent = pv.title;
    state.cardBody.textContent = pv.body;
    const on = isMarked(it);
    state.cardMark.classList.toggle('on', on);
    state.cardMark.title = on ? '取消收藏 (Alt+B)' : '收藏这条提问 (Alt+B)';

    state.card.style.visibility = 'hidden';
    state.card.style.top = '0px';
    state.card.classList.add('show');
    const h = state.card.offsetHeight;
    const rowTop = it.row ? it.row.offsetTop : 0;
    const rowH = it.row ? it.row.offsetHeight : 10;
    state.card.style.top = `${Math.round(clamp(rowTop + rowH / 2 - h / 2, -6, Math.max(-6, state.railH - h + 6)))}px`;

    const railRect = state.rail.getBoundingClientRect();
    const cardW = state.card.offsetWidth;
    let left = state.rail.clientWidth + CFG.cardGap;
    if (railRect.left + left + cardW > window.innerWidth - 12) left = Math.max(12 - railRect.left, -cardW - CFG.cardGap);
    state.card.style.left = `${Math.round(left)}px`;
    state.card.style.visibility = 'visible';
  }

  // ---------------------------------------------------------------- 事件
  function schedule(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => measure(), delay ?? CFG.rescanDebounce);
  }

  function onScroll() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      if (state.hoverIndex >= 0) renderHover(-1);
      updateActive();
      layout(false);
    });
  }

  function onKeyDown(e) {
    state.keyEvents++;
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const map = { ArrowUp: -1, ArrowDown: 1 };
    if (e.key in map) {
      e.preventDefault();
      jumpRelative(map[e.key]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      jumpTo(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      jumpTo(state.items.length - 1);
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      toggleCollapse();
      layout(true);
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      toggleMark(state.items[state.activeIndex]);
    }
  }

  let scrollBound = null;
  let mo = null;
  let ro = null;

  function bind() {
    if (scrollBound !== state.scroller) {
      if (scrollBound) scrollBound.removeEventListener('scroll', onScroll);
      if (state.scroller) state.scroller.addEventListener('scroll', onScroll, { passive: true });
      scrollBound = state.scroller;
    }
    if (ro) ro.disconnect();
    ro = new ResizeObserver(() => {
      if (!state.items.length) schedule(120);
      else layout(true);
    });
    if (state.scroller) ro.observe(state.scroller);

    if (mo) mo.disconnect();
    mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type !== 'childList') continue;
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          // 官方导航轨出现/消失：立刻守卫，不等 debounce
          if (
            n.matches?.('[data-thread-user-message-navigation-rail-list]') ||
            n.querySelector?.('[data-thread-user-message-navigation-rail-list]')
          ) {
            guardTick();
            return;
          }
          const hit =
            n.matches?.('[data-user-message-bubble], [data-turn-key]') ||
            n.querySelector?.('[data-user-message-bubble], [data-turn-key]');
          if (hit) {
            schedule(150);
            return;
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // 模式按钮文案一变就立刻守卫（切 Codex 的即时反应）
    const modeBtn = document.querySelector('[aria-label^="切换模式"]');
    if (modeBtn && !state.modeMo) {
      state.modeMo = new MutationObserver(() => guardTick());
      state.modeMo.observe(modeBtn, { attributes: true, attributeFilter: ['aria-label'] });
    }
  }

  // 单一节拍：守卫 + 自愈，一起做（1s 一次，比原来 300ms+1500ms 两套省一半以上唤醒）
  function tick() {
    state.ticks++;
    guardTick();
    if (state.scroller && !state.scroller.isConnected) {
      state.scroller = null;
      schedule(60);
    }
    if (state.host && !state.host.isConnected) {
      ensureHost();
      schedule(60);
    }
    if (!state.items.length && q1(document, SELECTORS.scrollContainer)) schedule(200);
    if (state.items.length && state.host && state.host.style.display === 'none') layout(true);
  }

  // 窗口不可见时彻底停表：后台不烧 CPU
  function suspend() {
    clearInterval(state.watchdog);
    state.watchdog = 0;
  }
  function resume() {
    if (state.watchdog) return;
    state.watchdog = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resume();
      else suspend();
    });
    if (document.visibilityState !== 'visible') suspend();
    tick();
    schedule(120);
  }
  function watchdogTick() {
    state.ticks++;
    guardTick();
    if (state.scroller && !state.scroller.isConnected) {
      state.scroller = null;
      schedule(60);
    }
    if (state.host && !state.host.isConnected) {
      ensureHost();
      schedule(60);
    }
    if (!state.items.length && q1(document, SELECTORS.scrollContainer)) schedule(200);
    if (state.items.length && state.host && state.host.style.display === 'none') layout(true);
  }

  function start() {
    ensureHost();
    bind();
    measure();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener(
      'resize',
      () => {
        if (state.items.length) layout(true);
        else schedule(150);
      },
      { passive: true }
    );
    state.watchdog = setInterval(tick, 1000);
    state.guardTimer = 0;
    schedule(400);
  }

  window[GLOBAL_KEY] = {
    version: VERSION,
    refresh: () => {
      bind();
      measure();
    },
    destroy: () => {
      window.removeEventListener('keydown', onKeyDown, true);
      clearTimeout(state.timer);
      clearTimeout(state.hoverTimer);
      clearTimeout(state.hideTimer);
      clearInterval(state.watchdog);
      clearInterval(state.guardTimer);
      if (mo) mo.disconnect();
      if (ro) ro.disconnect();
      if (state.io) state.io.disconnect();
      if (scrollBound) scrollBound.removeEventListener('scroll', onScroll);
      if (state.host) state.host.remove();
      state.host = null;
      delete window[GLOBAL_KEY];
    },
    jump: jumpTo,
    toggle: toggleCollapse,
    debug: () => ({
      version: VERSION,
      items: state.items.length,
      chatKey: state.chatKey,
      marks: Object.keys(state.marks[state.chatKey] || {}).length,
      rowH: state.rowH,
      railH: state.railH,
      gutter: state.gutter,
      collapsed: state.collapsed,
      active: state.activeIndex,
      hover: state.hoverIndex,
      ticks: state.ticks,
      guards: state.guards,
    }),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
