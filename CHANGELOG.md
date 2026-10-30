# Changelog

## 3.3.0

- 页面内定时器合并为单一 1s 节拍，窗口不可见时完全停表
- 看护从 PowerShell 换成 Node（空闲 CPU ≈ 0，内存 95.9MB → 38.8MB）
- 端口探测改为 TCP connect，不再每轮发 HTTP
- 启动策略：`autoRestart` 仅在应用刚启动 90s 内生效，绝不无故杀进程

## 3.2.x

- 修复 `CSS.escape` 被同名常量遮蔽导致"点未挂载的刻度无反应"
- 修复 `scrollIntoView` 被应用"跟随底部"吸回：改为直接设置 `scrollTop` + 多次纠偏
- 修复收起状态宽度未恢复（轨道只剩 8px）
- 修复官方导航条检查只取第一个节点、忽略隐藏节点的问题
- 修复 Codex/Work 模式与官方轨道同屏：加入模式按钮 / `turn-N` / `main[...]` 三重判定，300ms 级让位

## 3.1.0

- 点击穿透硬化：`:host` 与预览卡 `pointer-events:none`，只有 28px 轨道与 22px 书签接收事件
- 文档级 capture `pointerdown` 收起预览，绝不 `preventDefault`

## 3.0.0

- 只给用户提问生成刻度（AI 回答不参与）
- 兼容两种 `data-turn-key` 格式（带 `history-content:turn:` 前缀与裸 UUID）
- 视觉改为横向短线刻度 + 标题/摘要预览卡 + 收藏

## 2.0.0

- 与官方浮动导航条同款布局：右侧对齐短线、悬停卡片
- 增加"正文左侧留白 ≥48px 才显示"的约束

## 1.0.0

- 首个可用版本：左侧细轨 + 点击定位 + 悬停预览