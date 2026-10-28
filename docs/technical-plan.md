# AnswerLens v2 技术实现方案

> 依据：已确认的 `prototype/` 交互原型 + DeepSeek Search/Fetch API + DeepSeek Harness（dsh）。
> 目标：把原型落成可上线的产品，而不是继续在静态页面上叠功能。

## 0. 结论先说

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 前端 | Next.js（App Router）+ Tailwind + shadcn/ui + Motion | 报告分享页需要 SSR/OG；聊天 + artifact + 报告库的复杂度用原生 DOM 不划算 |
| Agent 运行时 | dsh `sdk` profile（常驻 Node 服务） | 多 agent、scoped tools、append-only session、deliverables 都是现成的；它不能跑在 Vercel 函数里 |
| 搜索 | DeepSeek Search/Fetch 为主，Serper 兜底 | 官方 API 有 `summary`、`authority`、`date`、正文抓取，比纯链接强一档 |
| Agent 数量 | 3 个（Orchestrator / Researcher / Report Agent） | 报告是资源，不是 agent；活跃 agent 数与报告数量无关 |
| 评分 | 代码计算 + LLM 逐条判定 | 分数必须可复现，judge 不参与加总 |
| 报告库 | 先本地（IndexedDB），v2.1 再接账号 | 先把产品跑通；跨设备是下一阶段 |

**范围守则（v1 不做）**：分享链接、团队空间、定时监控、自定义模型、报告对话上传图片、多语言 UI。

---

## 1. 系统架构

### 1.1 拓扑

```text
浏览器（Next.js）
   │ SSE / fetch
   ▼
Next.js 服务（Vercel 或同一台 VPS）
   │ JSON-RPC
   ▼
dsh 运行时（常驻 Node，sdk profile）── 模型 / 搜索 / 文件
   │
   ├── Postgres（Supabase 或同机）
   └── 对象存储（报告快照、导出文件）
```

推荐 v2 用**单台香港/新加坡 VPS + Docker Compose**（Next + dsh + Postgres + Caddy），
原因是国内访问、常驻进程、部署复杂度三者同时满足；Vercel 只作为前端备选。

### 1.2 dsh 的接入方式

- 只使用 `sdk` profile 的 JSON-RPC 服务，不用它的 Web UI（品牌与交互要自己控制）。
- 在 `dsh` 外套一层 `agent-service` 适配器：暴露我们自己的 `/rpc`，内部转发到 dsh。
- 固定 dsh 版本（developer preview 会破坏性变更），升级必须跑契约测试。
- session 持久化用 dsh 的 JSONL + 数据库索引；`threads.agent_session_id` 用于 resume。

### 1.3 Agent 分工（3 个）

| Agent | 生命周期 | 工具（scoped） | 产出 |
| --- | --- | --- | --- |
| Orchestrator | 每用户常驻 1 个 | `start_analysis` `list_reports` `get_report` `search`（小额）`present` | 回复、任务计划 |
| Researcher | 每次研究临时创建，跑完 dispose | `search` `fetch` | `researchBrief` |
| Report Agent | 每用户常驻 1 个，`reportId` 为参数 | `get_report` `get_judgments` `compare_reports` `rewrite_recommendations` `search`（2 次预算） | 解释、改写建议（生成新版本） |

确定性阶段（不是 agent）：

| 阶段 | 形态 | 说明 |
| --- | --- | --- |
| 问题设计 | Tool（单次结构化输出） | 代码校验覆盖规则 |
| 12 条回答 | Job | 2 模型 × 6 问，逐条重试 |
| Judge | Tool（逐条） | 温度 0、JSON schema、失败降级规则判定 |
| 分数聚合 | 纯代码 | 权重与样本规则 |
| 报告组装 | 纯代码 | 只读 artifacts |

### 1.4 搜索层

```ts
interface SearchProvider {
  search(query: string, opts: {
    count?: number; needContent?: boolean; after?: string; lang?: string;
  }): Promise<SearchResult[]>;
  fetch(url: string): Promise<{ title: string; markdown: string }>;
}
```

- `DeepSeekSearch`：`POST /v1/tools/search`，`need_content` 按需；过滤 `rerank_score >= 1.5`，优先 `authority >= 3`。
- `SerperSearch`：兜底，仅在 DeepSeek 连续失败或超时触发。
- 预算：单次检测 ≤ 6 次 search + 4 次 fetch；query 结果缓存 24h。
- 研究中必须保留 `date`，用于"最新型号"校验。

### 1.5 一次检测的数据流

```text
用户消息
 → Orchestrator 解析 brief（缺型号就追问）
 → 创建 run，发 run.started
 → Researcher（可选）产出 researchBrief
 → design_questions → 用户编辑/确认
 → run_models（12 条，逐条 progress）
 → judge（12 条，逐条 verdict）
 → compute_scores（代码）
 → report_builder → present(report vN)
 → run.completed + 报告入库
```

---

## 2. 数据模型

```sql
users(id, email, created_at)
brands(id, user_id, name, product, created_at)
reports(id, user_id, brand_id, title, status, current_version, created_at, updated_at)
report_versions(
  id, report_id, version, score, metrics jsonb,
  positioning jsonb, actions jsonb, model_snapshot jsonb, created_at
)
questions(id, report_version_id, idx, text, score)
answers(id, report_version_id, question_id, provider, model, text, latency_ms, raw jsonb)
judgments(
  id, answer_id, dimensions jsonb, reasons jsonb, applicable jsonb,
  judge_model, degraded boolean, created_at
)
runs(id, report_id, status, stage, started_at, finished_at, cost jsonb, error text)
threads(id, user_id, scope, report_id, agent_session_id, created_at, updated_at)
messages(id, thread_id, role, text, blocks jsonb, created_at)
artifacts(id, run_id, kind, payload jsonb)   -- researchBrief / plan / reportDigest
quota_events(id, user_id, date, delta, reason)
```

约束：

- `report_versions` 不可变；改写/重跑都追加新版本。
- 每个 `answer` 最多一条有效 `judgment`（重试覆盖旧记录但保留 attempt）。
- `threads` 与报告是多对一：一份报告可以有多个线程，但同一用户同一报告只允许一个活跃 agent。
- `reports.status`：`running | reviewing | complete | failed`。
- 报告库默认按 `updated_at` 倒序，版本号只增不减。

---

## 3. 接口与事件

| 接口 | 说明 |
| --- | --- |
| `POST /api/chat`（SSE） | `{ threadId, message, scope }`；流式返回文本、blocks、进度、错误 |
| `POST /api/runs` | 开始一次检测，返回 `runId` |
| `POST /api/runs/:id/retry` | 只重试失败的回答/判定 |
| `GET /api/reports?filter=` | 报告库列表（分页、品牌、分数、状态） |
| `GET /api/reports/:id` | 报告详情 + 当前版本 |
| `POST /api/reports/:id/rerun` | 生成新版本 |
| `GET /api/reports/:id/thread` | 报告作用域线程 |
| `GET /api/health` | 三个上游探活（模型 ×2、搜索） |

SSE 事件（前端只依赖这些，不解析模型的自然语言）：

```text
run.stage        { stage, index, total, label }
research.source  { title, url, authority, date }
answer.progress  { provider, done, total }
judge.progress   { done, total }
report.ready     { reportId, version, score }
chat.token       { text }
chat.blocks      { blocks }
run.error        { stage, retryable, message }
```

错误分级：

| 级别 | 例子 | 处理 |
| --- | --- | --- |
| `retryable` | 上游超时、429、JSON 解析失败 | 指数退避 2 次；仍失败则该条降级 |
| `degraded` | judge 不可用 | 规则判定，报告标注 |
| `fatal` | 配置缺失、全部回答失败 | 终止 run，不扣额度，提示重试 |

---

## 4. 页面与功能

### 4.1 首页 / 新对话

| 项 | 说明 |
| --- | --- |
| 布局 | 左栏 280px（可收起 76px）+ 主栏（内容 760px 居中）+ 底部 composer |
| 内容 | eyebrow、主标题、一句说明、3 个建议、最近 3 份报告 |
| 交互 | 建议卡片只**填入**输入框，不自动发送；Enter 发送，Shift+Enter 换行 |
| 数据 | `GET /api/reports?limit=3`；首屏可用 IndexedDB 缓存先行渲染 |
| 空态 | 没有报告时隐藏"最近报告"，不显示骨架 |
| 验收 | 页面只有一个 `#composer`；网络断开时首页仍可渲染；建议点击后输入框有内容且未发送 |

### 4.2 对话线程

| 项 | 说明 |
| --- | --- |
| 内容 | 用户气泡、助手气泡、结构化 blocks（计划卡、确认卡、指标、任务、来源） |
| 流式 | SSE `chat.token` 增量渲染；`chat.blocks` 覆盖为结构化组件 |
| 持久化 | 每条消息有 `id`，前端按 id 去重；刷新后从 `messages` 恢复 |
| 操作 | 确认卡触发 `POST /api/runs`；运行中禁止重复提交 |
| 边界 | 流中断 → 保留已收到内容 + "继续"按钮；路由切换 → abort 请求 |
| 验收 | 不出现重复气泡；刷新后消息顺序一致；确认卡不会重复创建 run |

### 4.3 分析进度（artifact）

| 项 | 说明 |
| --- | --- |
| 来源 | 真实 SSE `run.stage` / `answer.progress` / `judge.progress`，不是定时器 |
| 展示 | 6 个阶段：理解 → 调研 → 问题 → 作答 → 判定 → 汇总；当前阶段 pulse |
| 失败 | 阶段红点 + 原因 + "只重试失败项"；不扣额度 |
| 验收 | 每个阶段事件在 500ms 内反映到 UI；完成后自动出现"查看完整报告"单入口；失败后额度不变 |

### 4.4 报告页 · 总览

| 项 | 说明 |
| --- | --- |
| 结构 | 分数环 + 标题 + 三个指标 → 竞品对比 → 定位判断 + 行动建议 |
| 分数 | 由 `report_versions.score` 计算；环形与数字同一个 tween |
| 样本 | 覆盖不足显示 `-` / "样本不足"，不参与排名 |
| 建议 | 每条必须带 `evidenceIds` 与可选 `sourceUrl`；代码校验，不通过则重写一次 |
| 验收 | 分数与后端一致；每条建议可追溯到回答；无来源时不显示地球图标 |

### 4.5 报告页 · 提问明细

| 项 | 说明 |
| --- | --- |
| 结构 | 6 个问题，展开后显示两个模型回答 + 判定依据 |
| 数据 | `questions` + `answers` + `judgments`（按 `question_id` 聚合） |
| 展示 | 分数在右，第一题默认展开；判定依据逐维度列出理由 |
| 边界 | 规则判定的回答标注"规则判定"；未问到的维度显示"不参与" |
| 验收 | 12 条回答全部可见；展开/收起可键盘操作；没有原因时不允许编造 |

### 4.6 报告信息面板（artifact）

| 项 | 说明 |
| --- | --- |
| 尺寸 | 280px（原 420 的 2/3），≤1180px 时改为固定 320px 抽屉 |
| 内容 | 仅元数据：模型、版本、检测时间、问题数；一句"在下方输入框直接提问" |
| 禁止 | 不再放"报告对话""提问明细"等跳转按钮，避免与报告页 tab 重复 |
| 验收 | 面板内没有重复入口；宽度 280±10；X 可直接关闭 |

### 4.7 报告对话

| 项 | 说明 |
| --- | --- |
| 入口 | 在报告作用域下向底部**同一个 composer** 发消息，自动打开 |
| 内容 | 该报告线程的 user/assistant 消息，不显示其他报告内容 |
| 导航 | 顶部"返回报告"→ 回到元数据面板；X 关闭面板 |
| Agent | 常驻 1 个 Report Agent，`reportId` 作为参数；不按报告创建 agent |
| 隔离 | 线程按 `(user, reportId)` 存储；切报告只换上下文 |
| 验收 | 页面仍只有一个 composer；报告 A 的问题不会出现在报告 B；活跃 agent ≤ 3 |

### 4.8 报告库

| 项 | 说明 |
| --- | --- |
| 结构 | 卡片网格（品牌/型号、竞品、分数、版本、日期） |
| 筛选 | 全部 / ≥70 / <70；后续加品牌、时间 |
| 分页 | 每页 24，滚动加载；总数 > 100 时用虚拟列表 |
| 交互 | 打开报告 → 主栏报告页 + scope 跟随；返回 → 报告库并重置 scope |
| 版本 | 同品牌重跑生成 vN，卡片显示版本，可进详情对比 |
| 验收 | 筛选结果数量正确；打开/返回 scope 正确；刷新后列表一致 |

### 4.9 品牌与竞品

| 项 | 说明 |
| --- | --- |
| v1 范围 | 只读列表 + 预填：品牌、型号、竞品、最近报告 |
| 交互 | 点品牌 → 主栏显示历史报告；"新建检测"把信息填进 composer |
| 验收 | 预填不带假数据；无报告时显示空态 |

### 4.10 命令面板

| 项 | 说明 |
| --- | --- |
| 触发 | ⌘K / Ctrl+K；Esc 关闭 |
| 内容 | 新建对话、打开报告库、最近报告、分享 |
| 键盘 | ↑↓ 选择、Enter 执行、焦点陷阱 |
| 验收 | 可完全键盘操作；Esc 后焦点回到触发器 |

### 4.11 移动端

| 项 | 说明 |
| --- | --- |
| 左栏 | 抽屉式，点击菜单按钮打开 |
| 报告 | 主栏整页；artifact 变成底部抽屉（52dvh，停在 composer 上方） |
| 验收 | 无横向滚动；抽屉打开时 composer 仍可点；只有一个 composer |

### 4.12 设置 / 账号（v2.1）

| 项 | 说明 |
| --- | --- |
| v2.0 | 无账号；数据在 IndexedDB，可导出/清空 |
| v2.1 | Supabase magic link；登录后合并本地报告 |
| 验收 | 不登录也能完成所有 v2.0 流程；登录不丢本地数据 |

---

## 5. 非功能设计

| 维度 | 目标 | 做法 |
| --- | --- | --- |
| 性能 | LCP < 2.5s；报告首屏 < 1s | RSC + 缓存；报告详情按版本缓存；图片/字体按需 |
| 稳定性 | 单次 run 可恢复 | run 状态机 + 幂等 key；SSE 断线重连；stage 级重试 |
| 配额 | 服务端 6 次/天 | `quota_events` + 原子写入；IP + user 双限流 |
| 成本 | 单次 run 有上限 | 预算计数器（search/fetch/token）；超预算终止并提示 |
| 安全 | 密钥不出服务端 | 所有模型/搜索调用在服务端；CSP；上传类型/大小校验 |
| 可观测 | 每次 run 可追踪 | dsh session id + run id 串联；Langfuse/OTel；阶段耗时与成本 |
| 无障碍 | AA | 焦点可见、aria、键盘、`prefers-reduced-motion` |
| 兼容 | Chrome/Edge/Safari 16.4+ | 不用仅 Chromium 的 API 作为硬依赖；无 View Transition 时降级 |

---

## 6. 测试与验收

### 6.1 测试分层

| 层 | 工具 | 覆盖 |
| --- | --- | --- |
| 单元 | Vitest | 评分、样本规则、schema、search 映射、状态机、格式化 |
| 集成 | Vitest + fake LLM/search | 完整 run：12 答 → 判定 → 报告；失败重试；额度 |
| E2E | Playwright | 首页 → 发送 → 运行 → 报告 → 明细 → 报告库 → 报告对话 → 移动端 |
| 视觉 | Playwright screenshot | 1440 / 390 两档 + reduced motion |
| LLM 评测 | 自建 harness | 30–50 条黄金样本，judge 与人工一致率 |
| 负载 | k6 | 20 并发用户、SSE 长连接 |

### 6.2 质量门槛

- 现有 151 个评分/逻辑测试迁移后必须全绿（它们是评分口径的契约）。
- judge 与人工在"是否提及/是否推荐/顺位档位"上一致率 ≥ 85%。
- 每条行动建议 100% 可追溯到 `evidenceId`；每条外部来源可解析。
- 报告中出现的所有数字都必须能在 `report_versions` 里找到来源，禁止模型自报。
- 端到端 p95 ≤ 4 分钟（12 答 + 12 判 + 报告）。
- 单次 run 成本超预算时必须在报告生成前终止，并明确提示。

---

## 7. 里程碑

### M0 · 基础与可行性验证（1.5 周）

交付：

- Next.js + Tailwind + shadcn/ui 脚手架，CI（typecheck / lint / unit / e2e smoke）
- dsh `sdk` profile 本地跑通：创建一个子 agent、调用一次工具、流式返回
- `SearchProvider` + DeepSeek Search/Fetch 实现 + Serper 兜底
- Postgres schema 与迁移；Docker Compose（Next + dsh + Postgres + Caddy）

验收：

- [ ] `docker compose up` 后本地可访问
- [ ] 脚本：query → search → 一个 agent 回答，日志可追踪
- [ ] 20 条真实查询 A/B（DeepSeek vs Serper），输出延迟/成本/可引用率
- [ ] CI 全绿

### M1 · 产品外壳（1.5 周）

交付：

- 左栏 / 会话 / 报告库 / 报告页 / artifact 面板，与原型一致
- 唯一 composer + scope chip + 命令面板
- IndexedDB 本地报告库（先 mock 数据）

验收：

- [ ] 原型 smoke 用例 1:1 迁移到 Next
- [ ] 任意时刻 `#composer` 数量 = 1
- [ ] 移动端无横向滚动，抽屉打开时 composer 可点
- [ ] 视觉回归通过

### M2 · 真实检测流水线（2 周）

交付：

- `POST /api/runs` + SSE 事件；问题设计、12 答、judge、评分、报告组装
- 失败重试与降级；额度服务端化
- 报告持久化与刷新恢复

验收：

- [ ] 真实一次检测产出可回看的报告
- [ ] 进度事件与真实阶段一致（无假定时器）
- [ ] 失败不扣额度；重试只跑失败项
- [ ] p95 ≤ 4 分钟

### M3 · 三个 Agent（1.5 周）

交付：

- Orchestrator / Researcher / Report Agent（`parentAgent`，scoped tools）
- 报告对话线程（按 reportId 隔离）、返回报告、升权到 Orchestrator
- 活跃 agent 上限与信号量

验收：

- [ ] 研究阶段有真实来源（title/url/authority/date）
- [ ] 报告 A 的问题不会出现在报告 B
- [ ] 同一用户活跃 agent ≤ 3
- [ ] 报告对话 100% 基于报告数据，不改写旧版本

### M4 · 体验打磨（1 周）

交付：

- 动效、空态/错误态/骨架、键盘与焦点、导出、移动端细节
- 可观测：run 级 trace、阶段耗时、成本

验收：

- [ ] Lighthouse Performance ≥ 90（桌面）
- [ ] axe 无 critical
- [ ] `prefers-reduced-motion` 下无动画残留
- [ ] 导出文件与页面数据一致

### M5 · 上线与稳定性（1 周）

交付：

- 服务端限流/配额/成本护栏、备份、健康检查、告警
- 部署（香港 VPS 或 Vercel + 常驻运行时）、回滚方案

验收：

- [ ] 20 并发模拟无 5xx；SSE 稳定
- [ ] 密钥只在服务端；仓库无泄漏
- [ ] 预算告警触发
- [ ] 可一键回滚到上一版本

**总计：8–9 周（单人）**；如果先做 M0–M2，可在 5 周内得到可用版本。

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| dsh 是 developer preview，接口会变 | 升级破坏 | 固定版本、`agent-service` 适配层、契约测试 |
| dsh 需要常驻进程 | 不能部署在 Vercel 函数 | 单台 VPS / 容器；健康检查与自动重启 |
| DeepSeek Search 限流或涨价 | 研究阶段变慢/变贵 | 预算、缓存、Serper 兜底、A/B 数据驱动 |
| 模型输出波动 | 报告不稳定 | 黄金样本评测；judge 温度 0；失败降级规则 |
| 国内访问 | 用户打不开 | 香港/VPS + 备案方案并行评估 |
| 迁移丢功能 | 评分口径漂移 | 评分核心先迁 TS，151 个旧测试当契约 |

---

## 9. 与当前版本的迁移

1. **保留**：`app-core.js` 的评分、覆盖率、问题校验逻辑；现有 151 个测试即验收契约。
2. **迁移**：把评分逻辑抽到 `packages/scoring`（TypeScript），测试改跑 Vitest；新旧实现并行跑 50 份历史报告做 diff。
3. **替换**：前端逐步迁到 Next；旧版冻结在现有域名，新版先部署在子域 `/v2`。
4. **切换**：E2E + 评测达标后切主域；保留旧版一周可回滚。
5. **数据**：v2.0 用 IndexedDB；登录后提供"导入本地报告"。

---

## 10. 需要你确认的决策

1. **部署形态**：单台香港 VPS（推荐，简单且国内可达）还是 Vercel + 独立运行时？
2. **账号时机**：v2.0 先本地报告库，v2.1 再接 Supabase，还是 v2.0 就上账号？
3. **Report Agent 权限**：v1 只读 + 解释，还是允许生成新版本建议？
4. **搜索切换**：先双路 A/B 一周，还是直接切 DeepSeek？
5. **导出范围**：v1 只做 PDF/图片导出，还是也做分享链接？
6. **单次成本上限**：每个 run 的预算阈值（建议先设一个硬上限，比如 ¥2/次）。

确认以上 6 项后，我按 M0 先落脚手架与 dsh/搜索的可行性验证。
