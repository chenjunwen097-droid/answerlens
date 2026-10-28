# AnswerLens v2

Next.js 版的产品外壳（M0/M1）。当前默认使用确定性 mock runtime，因此**不需要任何 key 就能跑通整条交互**。

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
| `/api/chat` | SSE 对话（mock 或代理到 dsh） |
| `/api/runs` | SSE 检测流水线（mock 或代理到 dsh） |
| `/api/health` | 上游配置探活 |

## 运行模式

- **mock（默认）**：`AGENT_RUNTIME_URL` 为空，`lib/runtime.ts` 用确定性数据模拟 6 个阶段。
- **dsh**：设置 `AGENT_RUNTIME_URL` 指向常驻的 dsh `sdk` profile 服务。
- **真实搜索**：`lib/search.ts` 已实现 DeepSeek Search/Fetch（主）与 Serper（兜底），配置 key 后即可用。
- **Supabase**：`sql/schema.sql` 是 v2.1 的数据表；v2.0 报告存在 localStorage。

## 部署

- Vercel：项目 Root Directory 设为 `v2`。
- dsh 运行时：单独部署到常驻 Node 主机（香港/新加坡 VPS），把地址填进 `AGENT_RUNTIME_URL`。
- 国内访问：Vercel 域名仍可能不可达，发布前需按 `docs/technical-plan.md` 的部署方案处理。

## 验证

```bash
npm run typecheck
npm run build
npm run smoke      # 需要先 npm run dev
```
