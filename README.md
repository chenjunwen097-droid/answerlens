<div align="center">

# AnswerLens · AI 推荐情报

**看见 AI 如何理解、比较和推荐你的产品。**

[在线体验](https://answerlens-v2.vercel.app) · [架构](#架构) · [本地运行](#本地运行) · [部署](#部署)

</div>

## 这是什么

买家越来越多地先问 AI，再决定买什么。AnswerLens 用两个真实大模型回答同一组购买决策问题，再逐条判定品牌是否被提及、是否被推荐、推荐顺位、证据和竞品差异，最后生成可追溯到原始回答的报告。

- 6 个问题由真实模型根据品牌、产品/型号、竞品和检测方向生成
- DeepSeek Flash 与 GLM 4.6v 各回答 6 题，共 12 条真实回答
- DeepSeek Flash 作为固定 judge 逐条判定；分数由确定性代码汇总
- 报告包含 AI 推荐表现、竞品对比、定位判断和行动建议
- AnswerLens Copilot 可以读取真实报告、比较报告，并在需要时联网核验
- 没有 mock 报告、种子数据、虚构分数或虚构来源

## 架构

```text
Next.js v2 (Vercel)
  /api/chat  /api/runs  /api/reports  /api/health
        │ SSE / JSON proxy
        ▼
AnswerLens runtime (Shenzhen ECS)
  ├── deterministic pipeline: research → questions → 12 answers → judge → report
  ├── DeepSeek Harness (dsh) agents
  │     ├── Orchestrator
  │     ├── Researcher
  │     └── Report Agent
  └── SQLite report store (/data)
        │
        └── DeepSeek + GLM + DeepSeek Search
```

### Agent 职责

| 角色 | 可做什么 | 边界 |
| --- | --- | --- |
| Orchestrator | 澄清需求、调用检索、把独立任务交给 Researcher 或 Report Agent | 不编造型号，不引用不存在的报告 |
| Researcher | 只整理搜索与网页读取结果，附来源 | 不写最终建议，不猜事实 |
| Report Agent | 读取指定报告、比较报告、核验外部事实 | 只引用工具返回的证据；不修改旧版本 |

报告是可查询资源，不是每份报告常驻一个 Agent。每次对话请求启动独立 dsh 进程，避免不同用户共享会话状态。

## 评分

| 维度 | 权重 |
| --- | ---: |
| 推荐出现 | 25% |
| 推荐顺位 | 25% |
| 描述倾向 | 15% |
| 证据完整 | 20% |
| 竞品差异 | 15% |

单题分是可用维度的加权结果，总分是可用题目的平均值。无法判定的维度不进入分母；样本不足会显式标注，不以默认分数补齐。

## 本地运行

```bash
# 1. 安装运行时
cd runtime
npm install

# 2. 安装 dsh runtime
cd dsh
npm install
cd ..

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY、GLM_API_KEY、RUNTIME_TOKEN、DATA_DIR

# 4. 启动真实运行时
AGENT_ENGINE=dsh npm start

# 5. 另开终端启动前端
cd ../v2
npm install
# .env.local: AGENT_RUNTIME_URL 和 AGENT_RUNTIME_TOKEN
npm run dev
```

访问 `http://127.0.0.1:3100`。本地没有离线或演示数据模式；运行时不可用时，产品会明确提示服务不可用。

## 测试

```bash
cd runtime
npm test

# 额外运行真实模型契约测试
RUN_DSH_CONTRACT=1 npm test

cd ../v2
npx tsc --noEmit
npx vitest run
npm run build
npm run smoke
```

`npm run smoke` 会走完整产品流程并生成一份真实报告。

## 部署

- `v2/` 部署到 Vercel，配置 `AGENT_RUNTIME_URL` 与 `AGENT_RUNTIME_TOKEN`
- `runtime/` 部署到长期运行的主机，SQLite 数据目录挂载到 `/data`
- 国内访问需要自有域名或反向代理；`*.vercel.app` 在中国大陆可能被 DNS/SNI 阻断
- 模型 key 只放本地 `.env` 或托管平台环境变量，绝不提交到仓库

## 已知限制

- Vercel Hobby 单个 Function 约 60 秒；完整检测目前仍在限制内，但 dsh 与上游模型波动可能触发超时
- 两个被测模型会随供应商版本更新而变化，结果适合看趋势，不应视为永久结论
- judge 与被测模型 DeepSeek Flash 相同，存在自偏好风险；评分理由和原始回答始终公开可查
- 当前没有账号体系，运行时的报告库是单实例 SQLite
- 中国大陆访问 Vercel 默认域名可能需要代理

## 许可

[MIT](LICENSE) © 2026 chenjunwen097-droid

---

## English

AnswerLens shows how real LLMs understand, compare and recommend a product. Six buyer questions are generated from the user's brand, product, competitors and directions; DeepSeek Flash and GLM 4.6v answer all six; a fixed DeepSeek Flash judge evaluates each answer; deterministic code builds the final score and report.

The product uses a Next.js frontend on Vercel and a long-lived runtime on ECS with SQLite. DeepSeek Harness runs three bounded roles: Orchestrator, Researcher and Report Agent. Reports are resources rather than always-on agents, and each chat request uses an isolated dsh process.

There is no mock report path. Scores, quotes and recommendations must trace back to real model answers or real search results. The MIT-licensed repository is maintained by [chenjunwen097-droid](https://github.com/chenjunwen097-droid).
