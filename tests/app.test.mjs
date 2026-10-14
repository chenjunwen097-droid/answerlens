import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../app-core.js");

test("cleans competitor input and caps it at three items", () => {
  assert.deepEqual(
    core.cleanList(["Linear", " linear ", "", "Coda", "ClickUp", "Asana"]),
    ["Linear", "Coda", "ClickUp"]
  );
});

test("a conversation names itself after the first user message", () => {
  const created = core.createConversation({ at: "2026-10-07T10:00:00.000Z" });
  assert.equal(created.title, "新对话");
  assert.deepEqual(created.messages, []);
  assert.equal(created.report, null);

  const withUser = core.appendConversationMessage(created, {
    role: "user",
    text: "帮我看看喜茶和林里在清爽果茶上的差别，我要写一份汇报",
    at: "2026-10-07T10:01:00.000Z"
  });
  // 标题取首条消息截断
  assert.equal(withUser.title, "帮我看看喜茶和林里在清爽果茶上的差别…");
  assert.equal(withUser.messages.length, 1);
  assert.equal(withUser.updatedAt, "2026-10-07T10:01:00.000Z");

  const withReply = core.appendConversationMessage(withUser, {
    role: "assistant",
    text: "好的。",
    blocks: [{ type: "text", text: "好的。" }],
    at: "2026-10-07T10:01:05.000Z"
  });
  // 助手回复不会改标题
  assert.equal(withReply.title, withUser.title);
  assert.equal(withReply.messages.length, 2);
  assert.equal(withReply.messages[1].blocks.length, 1);
});

test("keeps the newest messages and never starts with an assistant reply", () => {
  let conversation = core.createConversation({ at: "2026-10-07T10:00:00.000Z" });
  const limit = core.CONVERSATION_MESSAGE_LIMIT;
  for (let index = 0; index < limit + 4; index += 1) {
    conversation = core.appendConversationMessage(conversation, {
      role: index % 2 === 0 ? "user" : "assistant",
      text: `第 ${index} 条`,
      at: new Date(Date.parse("2026-10-07T10:00:00.000Z") + index * 1000).toISOString()
    });
  }
  assert.equal(conversation.messages.length, limit);
  assert.equal(conversation.messages[0].role, "user");
  assert.equal(conversation.messages[limit - 1].text, `第 ${limit + 3} 条`);
});

test("prunes to twelve conversations, newest first", () => {
  const list = Array.from({ length: 15 }, (_, index) =>
    core.createConversation({
      at: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 86400000).toISOString()
    })
  );
  const pruned = core.pruneConversations(list);
  assert.equal(pruned.length, core.CONVERSATION_LIMIT);
  assert.ok(pruned[0].createdAt > pruned[pruned.length - 1].createdAt);
  // 最新的那一个一定还在
  assert.ok(pruned.some((item) => item.id === list[list.length - 1].id));
  assert.ok(!pruned.some((item) => item.id === list[0].id));
});

test("renaming and deleting conversations never touches the others", () => {
  const first = core.createConversation({ id: "c_a", at: "2026-10-07T10:00:00.000Z" });
  const second = core.createConversation({ id: "c_b", at: "2026-10-07T11:00:00.000Z" });
  const renamed = core.renameConversation([first, second], "c_a", "  喜茶对比  ");
  assert.equal(renamed.find((item) => item.id === "c_a").title, "喜茶对比");
  assert.equal(renamed.find((item) => item.id === "c_b").title, "新对话");
  // 空标题不生效
  assert.equal(
    core.renameConversation(renamed, "c_a", "   ").find((item) => item.id === "c_a").title,
    "喜茶对比"
  );
  const removed = core.removeConversation(renamed, "c_b");
  assert.deepEqual(removed.map((item) => item.id), ["c_a"]);
});

test("storage round-trips, migrates and survives junk", () => {
  const conversation = core.appendConversationMessage(
    core.createConversation({ id: "c_x", at: "2026-10-07T10:00:00.000Z" }),
    { role: "user", text: "喜茶和林里哪个更清爽？", at: "2026-10-07T10:01:00.000Z" }
  );
  const report = { id: "report_1", brand: "喜茶", score: 58 };
  const state = {
    activeId: "c_x",
    conversations: [{ ...conversation, report }]
  };
  const restored = core.parseConversations(core.serializeConversations(state));
  assert.equal(restored.activeId, "c_x");
  assert.equal(restored.conversations[0].messages[0].text, "喜茶和林里哪个更清爽？");
  assert.equal(restored.conversations[0].report.score, 58);
  assert.equal(restored.conversations[0].pinned, false);

  // 置顶状态也要能存下来。
  const pinnedState = core.parseConversations(
    core.serializeConversations({
      activeId: "c_x",
      conversations: [core.pinConversation([conversation], "c_x", true)[0]]
    })
  );
  assert.equal(pinnedState.conversations[0].pinned, true);

  // 坏的 JSON、缺字段的旧数据都不能让聊天崩掉
  assert.deepEqual(core.parseConversations("{not json"), { conversations: [], activeId: null });
  const legacy = core.parseConversations(
    JSON.stringify({ conversations: [{ id: "c_old", title: "旧对话", messages: [{ role: "user", text: "你好" }] }] })
  );
  assert.equal(legacy.conversations.length, 1);
  assert.equal(legacy.conversations[0].messages[0].text, "你好");
  assert.equal(legacy.activeId, "c_old");
  assert.equal(legacy.conversations[0].report, null);
});

test("pinned conversations float to the top and survive eviction", () => {
  const older = core.createConversation({ id: "c_old", at: "2026-10-01T00:00:00.000Z" });
  const newer = core.createConversation({ id: "c_new", at: "2026-10-07T00:00:00.000Z" });
  const middle = core.createConversation({ id: "c_mid", at: "2026-10-04T00:00:00.000Z" });
  const pinned = core.pinConversation([older, newer, middle], "c_old", true);
  assert.equal(pinned.find((item) => item.id === "c_old").pinned, true);
  // 置顶不改变“最近活动时间”，只是排到最前。
  assert.equal(pinned.find((item) => item.id === "c_old").updatedAt, older.updatedAt);
  assert.deepEqual(
    core.pruneConversations(pinned).map((item) => item.id),
    ["c_old", "c_new", "c_mid"]
  );
  const unpinned = core.pinConversation(pinned, "c_old", false);
  assert.deepEqual(
    core.pruneConversations(unpinned).map((item) => item.id),
    ["c_new", "c_mid", "c_old"]
  );

  // 全部置顶时，新建的对话也必须在（不能被淘汰掉）。
  const all = Array.from({ length: core.CONVERSATION_LIMIT }, (_, index) =>
    core.pinConversation(
      [
        core.createConversation({
          id: `c_${index}`,
          at: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 1000).toISOString()
        })
      ],
      `c_${index}`,
      true
    )[0]
  );
  const created = core.createConversation({ id: "c_fresh", at: "2026-10-08T00:00:00.000Z" });
  const kept = core.pruneConversations([created, ...all], undefined, created.id);
  assert.equal(kept.length, core.CONVERSATION_LIMIT);
  assert.ok(kept.some((item) => item.id === "c_fresh"));
});

test("shrinks storage by dropping old report snapshots before conversations", () => {
  const conversations = Array.from({ length: 3 }, (_, index) =>
    core.appendConversationMessage(
      core.createConversation({
        id: `c_${index}`,
        at: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 86400000).toISOString()
      }),
      { role: "user", text: `第 ${index} 个对话` }
    )
  ).map((item) => ({ ...item, report: { id: item.id, notes: "x".repeat(2000) } }));
  const state = { activeId: "c_2", conversations };
  const shrunk = core.shrinkConversations(state, 3000);
  assert.equal(shrunk.conversations.length, 3, "conversations survive before snapshots do");
  assert.equal(shrunk.conversations.find((item) => item.id === "c_2").report.report === undefined, true);
  assert.ok(shrunk.conversations.filter((item) => item.report).length < 3);
});

test("labels conversations and numbers repeated titles", () => {
  const first = core.appendConversationMessage(
    core.createConversation({ id: "c_1", at: "2026-10-07T10:00:00.000Z" }),
    { role: "user", text: "喜茶和林里哪个更清爽？" }
  );
  const second = core.appendConversationMessage(
    core.createConversation({ id: "c_2", at: "2026-10-07T11:00:00.000Z" }),
    { role: "user", text: "喜茶和林里哪个更清爽？" }
  );
  const state = { activeId: "c_2", conversations: [first, second] };
  assert.equal(core.conversationLabel(state), `${second.title} (2)`);
  assert.equal(
    core.conversationLabel({ activeId: "c_1", conversations: [first, second] }),
    `${first.title} (1)`
  );
  assert.equal(core.conversationLabel({ activeId: null, conversations: [] }), "新对话");
});

test("flags a batch of six near-identical questions", () => {
  const brief = {
    brand: "麦当劳",
    brandProduct: "炸鸡",
    competitors: [{ name: "肯德基" }, { name: "德克士" }, { name: "塔斯汀" }],
    dimensions: ["价格与性价比"]
  };
  const repetitive = [
    "在价格与性价比方面，麦当劳的炸鸡和肯德基的炸鸡相比，哪个更划算？",
    "麦当劳的炸鸡和德克士的炸鸡，哪个价格更实惠且味道更好？",
    "从价格与性价比角度，麦当劳的炸鸡和塔斯汀的炸鸡，你更推荐哪个？",
    "麦当劳的炸鸡在价格上比肯德基和德克士的炸鸡更有优势吗？",
    "考虑到炸鸡的味道，麦当劳的炸鸡和肯德基、塔斯汀的炸鸡，哪个性价比更高？",
    "麦当劳的炸鸡和德克士、塔斯汀的炸鸡相比，在价格与性价比方面有什么不同？"
  ];
  const problems = core.questionBatchProblems(repetitive, brief);
  // 0 道场景题 + 同一方向覆盖 5 题，两条都要报出来。
  assert.ok(problems.issues.some((issue) => /^scenario_shortage/.test(issue)));
  assert.ok(problems.issues.some((issue) => /^direction_repeat:价格/.test(issue)));
  assert.deepEqual(problems.rewriteIndexes, [1, 3, 5]);

  const diverse = [
    "麦当劳的炸鸡和肯德基的炸鸡，哪个口味更好？",
    "我是学生，预算 30 元以内，麦当劳和德克士的炸鸡哪个更合适？",
    "周末带孩子去商场，麦当劳和肯德基的炸鸡你会怎么选？",
    "第一次吃炸鸡想换换口味，麦当劳和塔斯汀比哪个更值得试？",
    "只能选一个，麦当劳、肯德基、德克士和塔斯汀的炸鸡你会怎么排序？",
    "考虑到油和热量，麦当劳的炸鸡和肯德基的炸鸡哪个更清淡？"
  ];
  assert.deepEqual(core.questionBatchProblems(diverse, brief), {
    issues: [],
    rewriteIndexes: []
  });
  // 只有形容价格的说法（划算/实惠）不算场景题。
  assert.deepEqual(core.questionSceneKeys("哪个更划算实惠？"), []);
  assert.deepEqual(core.questionSceneKeys("我周末带孩子去，预算 30 元"), [
    "people",
    "time",
    "budget"
  ]);
});

test("keeps the recipe and the scene library available to the generator", () => {
  assert.equal(
    core.QUESTION_RECIPE.reduce((sum, item) => sum + item.count, 0),
    6
  );
  assert.deepEqual(
    core.QUESTION_RECIPE.map((item) => item.key),
    ["compare", "scenario", "stage", "ranking"]
  );
  assert.ok(core.SCENE_DIMENSIONS.length >= 5);
});

test("generates six buyer questions around selection intent", () => {
  const questions = core.makeQuestions("Notion", ["Linear", "Coda"]);
  assert.equal(questions.length, 6);
  assert.match(questions[0], /Notion/);
  assert.match(questions[0], /Linear/);
  assert.match(questions[1], /替代品/);
});

test("normalizes product-level research briefs", () => {
  const brief = core.cleanBrief({
    brand: " 小米 ",
    brandProduct: " 小米 14 ",
    competitors: [{ name: "Apple", product: "iPhone 17 Pro" }],
    dimensions: ["屏幕体验", "屏幕体验", "续航"],
    other: "重点看日常使用"
  });
  assert.deepEqual(brief, {
    brand: "小米",
    brandProduct: "小米 14",
    competitors: [{ name: "Apple", product: "iPhone 17 Pro" }],
    dimensions: ["屏幕体验", "续航"],
    other: "重点看日常使用"
  });
  const questions = core.makeQuestionsForBrief(brief);
  assert.equal(questions.length, 6);
  assert.match(questions[0], /小米 14/);
  assert.match(questions[1], /屏幕体验/);
  assert.match(questions[1], /iPhone 17 Pro/);
});

test("rejects obvious off-topic brand input before analysis", () => {
  assert.equal(core.isOffTopic("红烧鱼怎么做好吃"), true);
  assert.equal(core.isOffTopic("Linear project management"), false);
});

test("computes question coverage with the same rules as the generator", () => {
  const brief = {
    brand: "小米",
    brandProduct: "小米 14",
    competitors: [
      { name: "苹果", product: "iPhone 17 Pro" },
      { name: "三星", product: "" }
    ],
    dimensions: [],
    other: ""
  };
  const coverage = core.questionCoverage(brief, [
    "小米 14 和 iPhone 17 Pro 谁更值得买？",
    "小米 14 和 iPhone 17 Pro 的续航谁更好？",
    "小米 14、iPhone 17 Pro 和三星谁更适合通勤？",
    "小米 14 和 iPhone 17 Pro 的长期口碑如何？",
    "小米 14 的续航表现如何？",
    "三星和小米 14 哪个更省电？"
  ]);
  assert.equal(coverage.total, 6);
  assert.equal(coverage.minCompetitorCoverage, 3);
  const brand = coverage.entities.find((item) => item.type === "brand");
  const apple = coverage.entities.find((item) => item.name === "苹果");
  const samsung = coverage.entities.find((item) => item.name === "三星");
  assert.equal(brand.count, 6);
  assert.equal(apple.count, 4);
  assert.equal(samsung.count, 2);
  // Question 5 names the brand but no competitor at all.
  assert.deepEqual(coverage.issues[4].problems, ["missing_competitor"]);
});

test("builds a report with bounded scores and comparable matrix data", () => {
  const report = core.buildReport("Acme", ["Beta", "Gamma"]);
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.equal(report.totalQuestions, 6);
  assert.equal(report.matrix.length, 3);
  assert.equal(report.matrix[0].name, "Acme");
  assert.equal(report.mentioned >= 3 && report.mentioned <= 6, true);
});

test("keeps the primary example aligned with the reviewed mock report", () => {
  const report = core.buildReport("Notion", ["Linear", "ClickUp"]);
  assert.equal(report.score, 58);
  assert.equal(report.mentioned, 4);
  assert.equal(report.questionStats.filter((item) => item.mentioned).length, 4);
  assert.equal(report.questionStats[0].mentioned, true);
  assert.equal(report.questionStats[1].mentioned, false);
  assert.equal(report.questionStats[5].mentioned, true);
  assert.equal(
    report.score,
    Math.round(
      report.questionStats.reduce((sum, item) => sum + item.score, 0) /
        report.questionStats.length
    )
  );
});

test("renders structured answer components and escapes their content", () => {
  const html = core.renderAnswerBlocks([
    { type: "text", text: "结论：<b>不该被渲染</b>" },
    {
      type: "task_list",
      title: "待认领",
      items: [{ text: "补充续航实测", owner: "产品", priority: "高" }]
    },
    {
      type: "table",
      title: "逐题对比",
      columns: ["题号", "比亚迪"],
      rows: [["第2题", "88"]]
    },
    {
      type: "sources",
      items: [
        { title: "某报道", url: "https://example.com/a", host: "example.com", snippet: "摘要" }
      ]
    },
    { type: "quote", model: "deepseek", text: "表显估算不如蔚来" },
    { type: "html", text: "未知类型必须被忽略" }
  ]);
  assert.match(html, /class="answer-task-list"/);
  assert.match(html, /class="answer-table"/);
  assert.match(html, /class="answer-sources"/);
  assert.match(html, /class="answer-quote"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /产品 · 高/);
  // Model output is escaped, never injected as markup.
  assert.match(html, /&lt;b&gt;不该被渲染&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>不该被渲染<\/b>/);
  assert.doesNotMatch(html, /未知类型必须被忽略/);
});

test("renders the new answer blocks through the same escaping path", () => {
  const html = core.renderAnswerBlocks([
    { type: "callout", tone: "warn", title: "样本不足", text: "该竞品只被问到 <2> 题。" },
    {
      type: "metric",
      title: "AI 推荐表现",
      items: [
        { label: "总分", value: "58", unit: "分", hint: "6 题平均" },
        { label: "排名", value: "#2" }
      ]
    },
    { type: "task_list", items: [{ text: "补充实测", questionNumber: 2, model: "glm-4.6v" }] },
    { type: "quote", questionNumber: 3, model: "glm-4.6v", text: "甜度偏高。" },
    {
      type: "confirm_card",
      title: "已填好检测表单",
      fields: [{ label: "品牌", value: "小米" }],
      sources: [
        { title: "小米官网发布页", url: "https://example.com/mi", host: "example.com" }
      ],
      action: { type: "scroll_form", label: "去确认并开始检测" }
    }
  ]);
  assert.match(html, /class="answer-callout is-warn"/);
  assert.match(html, /class="answer-metric-value">58<em>分<\/em>/);
  assert.match(html, /6 题平均/);
  assert.match(html, /依据：第 2 题 · glm-4.6v/);
  assert.match(html, /第 3 题 · glm-4.6v/);
  assert.match(html, /data-confirm-action="scroll_form"/);
  assert.match(html, /去确认并开始检测/);
  assert.match(html, /品牌<\/span><strong>小米<\/strong>/);
  // 型号来源用小地球图标呈现，不显示整条 URL。
  assert.match(html, /class="answer-confirm-source"[^>]*href="https:\/\/example\.com\/mi"/);
  assert.match(html, /data-lucide="globe"/);
  assert.match(html, /小米官网发布页/);
  assert.doesNotMatch(html, />https:\/\/example\.com\/mi</);
  // Block content is escaped, never injected as markup.
  assert.match(html, /&lt;2&gt;/);
  assert.doesNotMatch(html, /<2>/);
  assert.match(html, /<strong>样本不足<\/strong>/);
});

test("the chat wires the confirm card button to the detection form", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /\[data-confirm-action\]/);
  assert.match(app, /已定位到检测表单/);
});

test("an external recommendation source is a globe icon, not a pasted URL", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /class="recommendation-source"/);
  assert.match(app, /data-lucide="globe"/);
  assert.match(app, /item\.source\?\.url/);
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.recommendation-source \{/);
  assert.match(styles, /\.recommendation-source i \{/);
  // 建议里的“· ”分点要靠 pre-wrap 才能显示成多行。
  assert.match(
    styles,
    /\.recommendation-suggestion > p \{[\s\S]{0,400}white-space: pre-wrap/
  );
  // 覆盖不一致用琥珀色区分，并把“没提到”的那一侧标出来。
  assert.match(styles, /\.positioning-gap \{/);
  assert.match(styles, /blockquote\.is-missing/);
  assert.match(app, /模型覆盖不一致/);
  assert.match(app, /这一题没有提到该产品/);
});

test("publishes the judging rules behind every dimension", () => {
  const total = core.SCORE_DIMENSIONS.reduce((sum, item) => sum + item.weight, 0);
  assert.equal(total, 100);
  core.SCORE_DIMENSIONS.forEach((item) => {
    assert.ok(item.rule && item.rule.length > 10, `${item.label} needs a judging rule`);
  });
  const rank = core.SCORE_DIMENSIONS.find((item) => item.key === "rank");
  assert.match(rank.rule, /没有给出顺序时/);
  assert.deepEqual(rank.values, ["25", "50", "75", "100"]);
  const evidence = core.SCORE_DIMENSIONS.find((item) => item.key === "evidence");
  assert.match(evidence.rule, /具体/);
  assert.match(evidence.valuesNote, /不参与该项/);
  // 每个维度都要能回答“怎么算”和“能得哪些分”。
  core.SCORE_DIMENSIONS.forEach((item) => {
    assert.ok(item.formula && item.formula.length > 6, `${item.label} needs a formula`);
    assert.ok(Array.isArray(item.values) && item.values.length >= 2, `${item.label} needs tiers`);
  });
  const presence = core.SCORE_DIMENSIONS.find((item) => item.key === "presence");
  assert.match(presence.formula, /被列为首选/);
  assert.deepEqual(presence.values, ["0", "25", "50", "75", "100"]);
  assert.match(presence.rule, /被列为首选/);
  const differentiation = core.SCORE_DIMENSIONS.find((item) => item.key === "differentiation");
  assert.match(differentiation.formula, /÷ 3 × 100/);
  assert.deepEqual(differentiation.values, ["0", "33", "67", "100"]);
});

test("the pipeline judges every answer and keeps a rule-based fallback", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  // One judge call per answer, driven by the page so progress stays visible.
  assert.match(app, /phase: "judge"/);
  assert.match(app, /按判定项核对回答 · /);
  assert.match(app, /judgments\[`\$\{target\.provider\}:\$\{target\.questionIndex\}`\]/);
  assert.match(app, /judgments,/);
  // The report form must never claim a judged score when the verdict failed.
  assert.match(app, /规则判定/);
  assert.match(app, /判定依据/);
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.answer-rationale/);
  assert.match(styles, /\.rationale-entity li/);
  assert.match(styles, /\.rationale-value\.is-na/);
  assert.match(styles, /\.scoring-dimension-list \.scoring-rule/);
});

test("the scoring standard explains the new formulas without internal names", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /该维度不参与加权，分母按其余维度重新计算/);
  assert.match(app, /展开任意一条回答的“判定依据”/);
  // 顶部两项指标：主动推荐率 + 首选率（平均顺位不再上屏）。
  assert.match(app, /elements\.firstChoiceMetric\.textContent/);
  assert.match(app, /report\.metrics\?\.firstChoiceRate/);
  assert.doesNotMatch(app, /rankMetric/);
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="firstChoiceMetric"/);
  assert.match(html, /<span>首选率<\/span>/);
  assert.doesNotMatch(html, /平均推荐位置|几乎没有区分度/);
  // The fallback is documented in the standard, not just in the code.
  assert.match(app, /备用口径 · 规则判定/);
  assert.match(app, /首次出现的位置排序/);
  assert.match(app, /只作为兜底，不用于判定可用的回答/);
  assert.doesNotMatch(app, /rubric/i);
  assert.doesNotMatch(app, /deepseek-flash 判定|judge 模型/);
  // Sections are separated with a labelled block, not one long paragraph.
  assert.match(app, /scoring-block-kicker/);
  assert.match(html, /class="scoring-block"/);
  assert.match(html, /样本与覆盖/);
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.scoring-block \{/);
  assert.match(styles, /\.scoring-block \+ |\.scoring-block \{[\s\S]*border-top: 1px solid var\(--line\)/);
  assert.match(styles, /\.scoring-rule-list li \{/);
});

test("turns plain-text source URLs into safe clickable links", () => {
  const linked = core.linkify("来源：喜茶新品 https://example.com/news。");
  assert.match(linked, /<a href="https:\/\/example\.com\/news" target="_blank" rel="noopener noreferrer">/);
  assert.match(linked, /<\/a>。/);

  // Anything that is not http(s) must never become a link.
  assert.equal(
    core.linkify("javascript:alert(1)"),
    "javascript:alert(1)"
  );
  assert.equal(core.linkify("没有链接"), "没有链接");
});

test("flattens Markdown links so the URL stays clickable", () => {
  assert.equal(
    core.cleanAssistantText("[喜茶新品](https://example.com/news)"),
    "喜茶新品 https://example.com/news"
  );
});

test("cleans Markdown without flattening useful line breaks", () => {
  assert.equal(
    core.cleanAssistantText("**得分**：58\n- 提及率 `44%`\n- 排名 #3"),
    "得分：58\n• 提及率 44%\n• 排名 #3"
  );
});

test("formats the flat daily quota", () => {
  assert.equal(core.quotaLabel(6), "今日免费额度 6/6 次");
  assert.equal(core.quotaLabel(2), "今日免费额度 2/6 次");
  assert.equal(core.quotaLabel(3, 3), "今日免费额度 3/3 次");
  assert.match(core.quotaLabel(0), /今日免费额度已用完/);
  assert.match(core.quotaLabel(0), /明天自动恢复/);
  assert.doesNotMatch(core.quotaLabel(0), /注册|邀请/);
  assert.equal(core.canAnalyze(0), false);
  assert.equal(core.canAnalyze(1), true);
});

test("contains the complete prototype workflow without remote dependencies", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const requiredIds = [
    "analysisForm",
    "process",
    "report",
    "notes",
    "scoringStandard",
    "quotaText",
    "chatImageInput",
    "chatPanel",
    "questionReview",
    "questionEditorList",
    "regenerateQuestions",
    "confirmQuestions",
    "brandProductInput",
    "otherInput"
  ];
  for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /AI 推荐情报/);
  assert.doesNotMatch(html, /AI 选型情报/);
  assert.match(app, /AI 推荐情报报告/);
  assert.doesNotMatch(app, /AI 选型情报/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:\/\//);
  assert.doesNotMatch(html, /id="brandImage"|upload-control/);
  assert.doesNotMatch(html, /id="brandUrl"|value="Linear"|value="ClickUp"/);
  assert.doesNotMatch(html, /chatSuggestions|signalTable|AI 回答信号/);
  assert.match(html, /id="process" hidden/);
  assert.match(html, /id="report" hidden/);
  assert.match(html, /placeholder="你的品牌"/);
  assert.match(html, /placeholder="你的产品\/型号"/);
  assert.match(html, /试试示例/);
  assert.doesNotMatch(html, /小米 14 vs iPhone 17 Pro/);
  assert.match(html, /class="competitor-product-input"/);
  assert.match(html, /class="direction-checkbox"/);
  assert.match(html, /value="产品体验"/);
  assert.match(html, /value="核心功能"/);
  assert.match(html, /检测方向\s*<small>选填 · 可多选<\/small>/);
  assert.match(app, /elements\.otherInput\.value = action\.payload\.other/);
  assert.doesNotMatch(app, /checkbox\.checked = directions\.includes/);
  // The product is a single tool now: registration, invitation, sharing and
  // the weekly-monitor funnel are gone for good.
  assert.doesNotMatch(html, /GrowthAtlas/);
  assert.doesNotMatch(html, /id="invite|id="register|id="claimFollowBonus"/);
  assert.doesNotMatch(
    html,
    /id="shareDialog"|id="shareTitle"|id="subscribeDialog"|id="headerRegister"|id="headerShare"|id="footerShare"|id="shareReport"|id="monitorButton"/
  );
  assert.doesNotMatch(html, /share-context|og-preview|mock-qr|invite-blocks/);
  assert.doesNotMatch(html, /注册|邀请码|分享报告|每周监控/);
  assert.doesNotMatch(app, /openShareDialog|renderShareDialog|openInviteDialog|grantBonus/);
  assert.doesNotMatch(html, /model-monitor/);
  assert.match(html, /question-review/);
  assert.match(html, /id="questionCoverage"/);
  assert.match(html, /id="editQuestions"/);
  assert.match(html, /修改问题并重新测试/);
  assert.match(html, /id="scoringSampleRule"/);
  assert.match(html, /<details class="scoring-standard notes-scoring" id="scoringStandard">/);
  assert.match(
    html,
    /<summary>\s*<span>评分标准与计算方式<\/span>\s*<i data-lucide="chevron-down"><\/i>\s*<\/summary>/
  );
  assert.match(styles, /\.scoring-standard\[open\] summary svg \{[\s\S]*?rotate\(180deg\)/);
  assert.ok(
    html.indexOf('id="scoringStandard"') > html.indexOf('id="notes"'),
    "评分标准与计算方式 must live inside the note at the bottom of the page"
  );
  assert.doesNotMatch(
    html.slice(html.indexOf("<section class=\"report-section\""), html.indexOf("<section class=\"notes-section\"")),
    /id="scoringStandard"/,
    "the report overview must no longer carry the scoring standard"
  );
  assert.doesNotMatch(html, /扎心版|好奇版/);
  assert.ok(
    html.indexOf('id="scoringSampleRule"') >
      html.indexOf("首选率 = 被判定为“第一推荐”"),
    "样本与覆盖 must sit at the very bottom of the scoring standard block"
  );
  assert.doesNotMatch(html, /Qwen/i);
  assert.match(html, /AnswerLens/);
  assert.match(html, /AI 推荐表现/);
  assert.match(html, /<strong>说明<\/strong>/);
  assert.match(html, /<h3>这是什么<\/h3>/);
  assert.match(html, /<h3>怎么用<\/h3>/);
  assert.match(html, /<h3>免费额度<\/h3>/);
  assert.match(html, /<h3>数据从哪来<\/h3>/);
  assert.match(html, /<h3>已知限制<\/h3>/);
  assert.match(html, /每天 6 次免费检测/);
  assert.doesNotMatch(html, /Mock|演示数据|目标用户与痛点|增长路径/);
  assert.doesNotMatch(html, /检测流程不联网/);
  assert.doesNotMatch(html, /额度只计在当前浏览器本地，清缓存或换设备即重置/);
  assert.doesNotMatch(html, /SearXNG 调研覆盖有限/);
  assert.match(html, /趋势参考/);
  assert.match(html, /AnswerLens Copilot（AI 助手）/);
  assert.doesNotMatch(html, /数据来源与 Mock 标注/);
  assert.doesNotMatch(html, /交互 Demo/);
  assert.doesNotMatch(html, /title="切换指标"/);
  assert.doesNotMatch(app, /applySharedReportMode|shareContext/);
  assert.match(app, /api\/analyze/);
  assert.match(app, /api\/agent/);
  assert.match(app, /api\/extract-image/);
  assert.match(app, /phase:\s*"questions"/);
  assert.match(app, /phase:\s*"answer"/);
  assert.match(app, /phase:\s*"report"/);
  assert.match(app, /runAnswerQueue/);
  assert.match(app, /fetchQuestionsWithRetry/);
  assert.match(app, /正在重试（\$\{attempt\}\/\$\{maxAttempts - 1\}）/);
  assert.match(app, /provider: "deepseek"[\s\S]{0,140}concurrency: 1/);
  assert.match(app, /provider: "glm"[\s\S]{0,140}concurrency: 1/);
  assert.match(app, /attempt === 1 \? 5000 : 15000/);
  assert.match(app, /prepareAnalysis/);
  assert.match(app, /runConfirmedQuestionTests/);
  assert.match(app, /readConfirmedQuestions/);
  assert.match(app, /confirmQuestions/);
  assert.doesNotMatch(app, /runChatCommand/);
  assert.match(app, /questionStats/);
  assert.match(app, /question-score/);
  assert.match(app, /score-breakdown/);
  assert.match(app, /question-score-toggle/);
  assert.match(app, /得分明细/);
  assert.match(app, /entityScores\[column\.id\]/);
  assert.match(app, /score-na/);
  assert.match(app, /score-ignored/);
  assert.match(app, /样本偏少 · 不参与排名/);
  assert.match(app, /bar-rank/);
  assert.match(app, /core\.linkify/);
  assert.match(app, /core\.renderAnswerBlocks\(blocks\)/);
  assert.match(app, /pushChatMessage\(data\.reply, false, data\.blocks\)/);
  assert.match(app, /scoringSampleRule/);
  assert.match(app, /updateQuestionCoverage/);
  assert.match(app, /用修改后的问题重新测试/);
  assert.match(app, /每题都需要包含你的品牌/);
  assert.match(app, /questionCoverage/);
  assert.match(app, /每个对象只按“被问到它的题目”计分/);
  assert.match(app, /被问到的题数/);
  assert.match(app, /column\.isBrand \? "品牌" : "竞品"/);
  assert.doesNotMatch(app, /（品牌）|（竞品）/);
  assert.match(app, /positioning-item/);
  assert.match(app, /positioning-conflict/);
  assert.match(app, /positioning: activeReport\.positioning/);
  assert.match(app, /suggestions: \(activeReport\.suggestions/);
  assert.match(app, /与竞品的关键差异/);
  assert.match(app, /模型描述冲突/);
  assert.match(html, /class="positioning-summary" id="positioningSummary"/);
  assert.match(styles, /\.positioning-item strong/);
  assert.match(app, /scoringStandardBody/);
  assert.doesNotMatch(app, /品牌提及|正面情感|Visibility Copilot/);
  assert.match(app, /reportState/);
  assert.match(app, /renderMarkdown/);
  assert.match(app, /recommendation-analysis/);
  assert.match(app, /recommendation-suggestion/);
  assert.doesNotMatch(app, /registrationSuccess|已注册GrowthAtlas|grantBonus/);
  assert.match(app, /quotaLabel/);
  assert.match(app, /const DAILY_LIMIT = 6;/);
  assert.doesNotMatch(app, /dailyLimit|normalizeInviteCode|isValidInviteCode|saved\.invitedByBonus/);
  assert.match(app, /renderScoringStandard\(null\)/);
  assert.doesNotMatch(styles, /\.register-button|\.invite-hint|\.register-hint/);
  assert.match(app, /data-image-role/);
  assert.match(styles, /width: min\(880px, calc\(100vw - 24px\)\)/);
  assert.match(styles, /font-size: 15px;\s*line-height: 1\.75;\s*overflow-wrap: anywhere;\s*white-space: pre-wrap;/);
  assert.match(styles, /\.recommendation-suggestion strong/);
  assert.match(styles, /\.question-score-button/);
  assert.match(styles, /\.question-score-toggle svg/);
  assert.match(styles, /\.score-table tfoot td/);
  assert.match(styles, /\.score-table thead th:first-child \{[\s\S]*?text-align: left/);
  assert.match(styles, /\.answer-grid \{[\s\S]*?padding-left: 74px/);
  assert.match(styles, /\.positioning-item:first-child p \{[\s\S]*?color: var\(--orange-dark\)/);
  assert.match(styles, /\.notes-grid p \{[\s\S]*?font-size: 15px/);
  assert.match(styles, /\.notes-section summary strong \{[\s\S]*?font-size: 24px/);
  assert.doesNotMatch(html, /目标用户、增长路径、Mock 标识与已知限制/);
  assert.match(html, /每天 6 次免费检测/);
  assert.match(html, /点击「开始检测」|点「开始检测」/);
  assert.match(styles, /\.positioning-block \.block-heading/);
  assert.match(styles, /\.section-kicker,[\s\S]*?font-size: 22px/);
  assert.match(styles, /\.step-label \{[\s\S]*?font-size: 22px/);
  assert.match(styles, /\.scoring-standard summary \{[\s\S]*?color: var\(--ink\);[\s\S]*?font-size: 16px/);
  assert.match(styles, /\.scoring-dimension-list strong \{[\s\S]*?color: var\(--ink\)/);
  assert.doesNotMatch(styles, /\.scoring-dimension-list > div \{[\s\S]{0,200}?color: #d3cfc7/);
  assert.doesNotMatch(styles, /\.scoring-standard summary \{[\s\S]{0,120}?color: #ffffff/);
  assert.match(styles, /\.answer-grid \{[\s\S]*?grid-template-columns: 1fr;[\s\S]*?gap: 24px/);
  assert.match(styles, /\.notes-steps \{/);
  assert.match(styles, /\.notes-scoring \{/);
});
