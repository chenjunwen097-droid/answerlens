# AnswerLens v2

Next.js 产品前端。后端是 `runtime/` 的真实分析与 dsh Agent 服务；**没有 mock 模式，也没有种子报告**。

```bash
cd v2
npm install
npm run dev
# http://127.0.0.1:3100
```

## 路由

| 路由 | 说明 |
| --- | --- |
| `/` | 对话 / 新检测 |
| `/reports` | 报告库 |
| `/reports/[id]` | 报告详情（总览 / 提问明细） |
| `/api/chat` | SSE 对话（代理到常驻运行时，真实模型） |
| `/api/runs` | SSE 检测流水线（真实问题/回答/判定/报告） |
| `/api/reports` | 从运行时 SQLite 读取真实报告库 |
| `/api/health` | 上游配置探活 |

## 运行模式

- **remote（唯一模式）**：`AGENT_RUNTIME_URL` 指向 `runtime/` 服务（当前部署在 47.115.148.30:80），同时设置 `AGENT_RUNTIME_TOKEN`；未配置会直接报错，不提供 mock 数据。
- **真实搜索**：只使用 DeepSeek Search/Fetch，不再保留 Serper 回退。
- **报告持久化**：报告由常驻运行时写入 ECS SQLite，前端通过 `/api/reports` 读取；浏览器 localStorage 只保存对话线程。
- **Agent**：运行时 `AGENT_ENGINE=dsh` 时启用 DeepSeek Harness 的 Orchestrator、Researcher 与 Report Agent。

本地 `.env.local`（已 gitignore）示例：

```
AGENT_RUNTIME_URL=http://47.115.148.30
AGENT_RUNTIME_TOKEN=<runtime token>
```

ECS 上旧的 SearXNG / Caddy 网关容器已 `docker stop`（容器保留），80 端口现在由
`answerlens-runtime` 使用；`cowagent` 未受影响。

## 部署

- Vercel：项目 `answerlens-v2`，Root Directory 设为 `v2`；生产地址 https://answerlens-v2.vercel.app
- 环境变量（Production + Preview）：`AGENT_RUNTIME_URL=http://47.115.148.30`、`AGENT_RUNTIME_TOKEN=<runtime token>`
- dsh 运行时：部署在 ECS Docker 容器中，把地址填进 `AGENT_RUNTIME_URL`。
- 国内访问：Vercel 域名仍可能不可达，发布前需按 `docs/technical-plan.md` 的部署方案处理。

## 验证

```bash
npm run typecheck
npm run build
npm run smoke      # 需要先 npm run dev
```
