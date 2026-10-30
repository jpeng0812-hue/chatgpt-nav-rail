# AI 提示词（直接复制使用）

下面三段提示词，按用途选一段粘给 AI（ChatGPT / Codex / Claude 均可）。
第 1 段用于**接手维护**，第 2 段用于**从零复刻**，第 3 段用于**日常加功能**。

---

## 1. 接手维护（推荐）

```text
你是 Windows 桌面端逆向 + 前端工程师，接手维护开源项目「ChatGPT Nav Rail」。
仓库已在你当前目录（或先 git clone 下来）。

【项目目标】
给 ChatGPT Windows 桌面端（MSIX 打包的 Electron 应用，包名 OpenAI.Codex）的 Chat 模式，
在正文左侧加一条"只对应你提的问题"的导航条：点刻度跳转、悬停出摘要、Alt 快捷键、收藏。
要求：不改安装包、抗版本更新、不挡鼠标点击。

【环境事实（已实测，勿再猜）】
- 应用路径：C:\Program Files\WindowsApps\OpenAI.Codex_<版本>_x64__2p2nqsd0c76g0\app\ChatGPT.exe
- AUMID：OpenAI.Codex_2p2nqsd0c76g0!App（由签名证书派生，跨版本稳定；用它启动而不是写路径）
- 渲染层：app://-/index.html（本地 React 打包产物，不是 chatgpt.com 网页）
- 应用是单实例：再次启动只会把"开新窗口"转发给主实例，命令行开关传不进去；
  所以必须先让旧实例退出，再用带 --remote-debugging-port 的启动方式拉起。
- 关键 DOM 钩子：
  * 滚动容器 .thread-scroll-container（可能同时存在多个，取"可见且最高"）
  * 会话根 [data-thread-find-target="conversation"]
  * 用户提问 [data-user-message-bubble] → [data-local-conversation-user-anchor] → [data-conversation-role="user"] 的父级
  * 轮次键 [data-turn-key]，有两种格式：history-content:turn:<uuid> 与裸 <uuid>；Codex 用 turn-N
  * 官方导航条 [data-thread-user-message-navigation-rail-list]（官方只在 Work/Codex 挂载）
- 本机直连 github.com 会超时，存在本地代理 127.0.0.1:7897；git/gh 需显式带代理
  （gh: 设 HTTPS_PROXY；git: -c http.proxy=http://127.0.0.1:7897）

【架构】
- injector/payload.js  页面内导航（Shadow DOM），唯一需要随应用改版维护的文件
- injector/daemon.mjs  CDP 注入器：addScriptToEvaluateOnNewDocument + executionContextCreated，
                       3s 扫一次 /json/list，单实例锁 127.0.0.1:(port+1)，应用关闭后自行退出
- supervisor.mjs       生命周期看护：应用起→注入器起；应用关→注入器退；2s TCP 探测，空闲 CPU≈0
- launch.ps1           幂等：确保端口 + 注入器；restart-with-cdp.ps1 负责"退出+带端口重启"
- install.ps1/uninstall.ps1、supervisor-hidden.vbs、Start-ChatGPT-Nav.cmd

【必须遵守的不变量】
1. 绝不修改 app.asar / WindowsApps 下任何文件（只读 + 签名校验 + 更新覆盖）。
2. 只给"用户提问"生成刻度，AI 回答不参与。
3. 点击穿透：:host 与预览卡一律 pointer-events:none，只有 28px 轨道条和 22px 书签接收事件；
   文档级 capture pointerdown 只负责收起预览，绝不 preventDefault。
4. 以下任一成立必须立即隐藏自己（≤300ms）：官方轨道可见 / 处于 Codex（turn-N）/ 出现
   main[data-thread-user-message-navigation-content] / 模式按钮 aria-label 含 Codex。
5. 正文左侧留白 <48px 不显示，且不得通过改 padding/margin/visibility 去"腾地方"。

【已知坑（改代码前必读）】
- payload.js 里有 const CSS = `...`，会遮蔽全局 CSS 对象 → 不能用 CSS.escape，需自实现 cssEscape。
- scrollIntoView 会被应用的"跟随底部"逻辑吸回去：改为直接算绝对偏移设 scrollTop，并
  在 ~320ms × 4 内反复纠偏（官方组件也是 350ms 后重试）。
- transcript 是 6 条一窗的滑动窗口：DOM 里永远只有 6 条，未加载的历史不可能被枚举，
  只能"被动累积 + 点击时有界寻址（≤40 步）"。
- 系统里可能有杀不掉的残留 ChatGPT.exe：判定"应用在跑"要用进程数 ≥5，而不是"存在进程"。
- 折叠状态存在 localStorage，改宽度后必须强制重排一次，否则轨道只剩 8px。

【工作方式】
- 改动前先用 tools/ 下的脚本取证（verify / verify-click / verify-guard / regress），
  用真实数字（scrollTop、命中点数、行数）说话，不要凭感觉结论。
- 每次改完 payload.js 都要：node --check、重启注入器、跑一次 verify-click 确认没挡点击。
- 注释用中文、短句；提交信息写清"为什么"。
```

---

## 2. 从零复刻

```text
在这个 Windows 机器上，复刻一个「ChatGPT 桌面端 Chat 模式提问导航」项目。

硬约束：
1. 不许改安装包（MSIX，只读 + 签名），只能运行时注入；
2. 必须能在应用刷新/重启后自动恢复；
3. 不能影响鼠标点击，也不能和官方在 Work/Codex 模式下的导航条同时出现。

已知起点（可直接用）：
- 应用是 Electron + MSIX，AUMID = OpenAI.Codex_2p2nqsd0c76g0!App
- 渲染进程页面是 app://-/index.html，可用 CDP（--remote-debugging-port）注入
- 应用单实例：必须完全退出后再带端口启动，命令行开关才会生效
- 聊天正文钩子：.thread-scroll-container / [data-thread-find-target="conversation"] /
  [data-user-message-bubble] / [data-turn-key]（两种格式）

请按这个顺序推进，每步都给出实测证据：
1) 用 AUMID 带 --remote-debugging-port 启动，确认 /json/version 可访问；
2) 探测 Chat 模式下的消息 DOM，列出可用的稳定属性（不要用哈希类名）；
3) 先在页面里注入一个最小 Shadow DOM 轨道（只读，不拦截指针），截图确认；
4) 加悬停卡片、点击跳转、滚动高亮（IntersectionObserver，不要用像素推算）；
5) 写守护进程（注入 + 重注入 + 单实例锁 + 应用关闭后退出）；
6) 写启动器/安装器（AUMID 启动、幂等、开机自启、可卸载）；
7) 做验证脚本：点击穿透命中测试、官方轨道让位、多会话回归。

最后输出：README（徽章/特性/安装/原理/限制）、LICENSE(MIT)、CHANGELOG、
以及一份"改版后如何补选择器"的维护说明。
```

---

## 3. 日常加功能（在已有仓库上）

```text
仓库：ChatGPT Nav Rail（Windows 版 ChatGPT 提问导航）。
请先读 README.md 和 injector/payload.js 顶部的 SELECTORS/CFG，再动手。

本次需求：<在这里写你要的功能，例如"给收藏的提问加一个下拉列表"/"支持按关键词过滤刻度">

约束：
- 只改 payload.js 能解决就不要动 daemon/supervisor；
- 保持点击穿透（:host 与 .card 为 pointer-events:none）；
- 保持"未加载历史不虚构"的原则，不要为了实现功能去后台滚动页面；
- 改完跑：node --check injector/payload.js，重启注入器，
  再跑 node tools/verify-click.mjs 与 node tools/verify-guard.mjs，
  把"命中点数 / 刻度数 / 是否让位"的实测结果贴给我。
```
