# 贡献指南

感谢你愿意改进 AnswerLens。请先读一遍下面的约定，能省掉很多来回。

## 本地环境

- Node.js ≥ 20
- `npm ci`（只有一个开发依赖：Playwright，用于视觉冒烟测试）
- 仓库**没有构建步骤**：直接改 `index.html` / `app.js` / `app-core.js` / `styles.css`，浏览器刷新即可看到效果

```bash
npm test              # 150 个单元测试：前端核心逻辑、API 校验、评分与判定
npm run test:visual   # 全流程视觉冒烟（桌面 + 移动），截图输出到 qa/（已 gitignore）
                      # 首次运行前需要：npx playwright install chromium
```

## 代码约定

- 前端保持**零依赖**，请不要引入打包器或框架
- 后端是 Vercel Functions（CommonJS），可复用的逻辑放 `api/_lib/`
- 任何影响行为的改动都要补测试；提交前 `npm test` 必须全绿
- 不要提交密钥：`.env.local` 与 `.vercel/` 已在 `.gitignore` 中
- **不允许编造数据**：每个分数、引用和建议都必须能追溯到真实的模型回答；无法判定时显示 `-`，并标注「不参与」
- **所有动效都走 `app-motion.js`**：新场景要在那张场景表里登记（时长 / 缓动 / 位移 / 错开步长），并且必须能通过 `prefers-reduced-motion` 整体关闭；不要在别处另起一套动画

## 提交与 PR

- 一个改动一个 commit，提交信息写清楚"改了什么、为什么"
- PR 描述里请包含：解决什么问题、怎么验证的、是否影响评分口径
- 涉及评分口径的改动，请同步更新产品「说明」模块和 README 中的评分表

## Contributor License Agreement (CLA)

本项目要求所有贡献者同意以下条款。**提交 PR 即视为你已同意**：

1. 你是该贡献的作者，并且有权提交它；
2. 你授予 chenjunwen097-droid 永久、全球范围、免费、不可撤销的著作权与专利许可，允许其使用、复制、修改、分发和再许可该贡献，**包括以其他许可证分发**；
3. 该贡献按「现状」提供，不附带任何明示或默示担保。

如果你不同意以上条款，请不要提交 PR。

> 以上是通俗表述，不构成法律意见。如果你希望这份 CLA 具备更强的执行力，建议接入 CLA Assistant 之类的工具，并请专业人士审阅文本。

## 安全问题

请不要用公开 issue 报告安全问题，见 [SECURITY.md](SECURITY.md)。
