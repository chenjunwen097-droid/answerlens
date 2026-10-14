import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agent = require("../api/_lib/agent.js");
const analyzeInput = require("../api/_lib/analyze-input.js");
const analysis = require("../api/_lib/analysis.js");
const entities = require("../api/_lib/entities.js");
const insights = require("../api/_lib/insights.js");
const model = require("../api/_lib/model.js");
const questions = require("../api/_lib/questions.js");
const reflection = require("../api/_lib/reflection.js");
const research = require("../api/_lib/research.js");
const judge = require("../api/_lib/judge.js");
const background = require("../api/_lib/background.js");

test("builds provider-specific OpenAI-compatible completion URLs", () => {
  assert.equal(
    model.completionUrl("https://api.deepseek.com", "deepseek"),
    "https://api.deepseek.com/v1/chat/completions"
  );
  assert.equal(
    model.completionUrl("https://open.bigmodel.cn/api/paas/v4/", "glm"),
    "https://open.bigmodel.cn/api/paas/v4/chat/completions"
  );
  assert.equal(model.DEFAULTS.deepseek.testedModel, "deepseek-flash");
  assert.equal(model.DEFAULTS.deepseek.utilityModel, "deepseek-flash");
  assert.equal(model.DEFAULTS.glm.visionModel, "glm-4.6v");
});

test("resolves DeepSeek and GLM models by role", () => {
  assert.equal(model.resolveModel("deepseek", "agent"), "deepseek-flash");
  assert.equal(model.resolveModel("deepseek", "tested"), "deepseek-flash");
  assert.equal(model.resolveModel("deepseek", "utility"), "deepseek-flash");
  assert.equal(model.resolveModel("glm", "tested"), "glm-4.6v");
  assert.equal(model.resolveModel("glm", "vision"), "glm-4.6v");
  assert.equal(
    model.resolveModel("deepseek", "tested", undefined, {
      DEEPSEEK_TESTED_MODEL: "custom-tested"
    }),
    "custom-tested"
  );
  assert.throws(() => model.resolveModel("qwen", "tested"), /Unsupported model provider/);
});

test("merges provider-specific request options", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  let requestBody = null;
  process.env.DEEPSEEK_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [{ message: { role: "assistant", content: "answer" } }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  try {
    await model.callChat({
      provider: "deepseek",
      role: "tested",
      messages: [{ role: "user", content: "test" }],
      extraBody: { thinking: { type: "disabled" } }
    });
    assert.deepEqual(requestBody.thinking, { type: "disabled" });
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test("limits agent tools according to the active page", () => {
  const inputNames = agent.toolsForContext("input").map((tool) => tool.function.name);
  const reportNames = agent.toolsForContext("report").map((tool) => tool.function.name);
  assert.ok(inputNames.includes("fill_form"));
  assert.ok(!inputNames.includes("update_competitors"));
  assert.ok(reportNames.includes("update_competitors"));
  assert.ok(reportNames.includes("add_buyer_question"));
  assert.ok(reportNames.includes("explain_score"));
  // The registration and weekly-monitor funnel is gone, so the assistant no
  // longer owns a tool that opens it.
  assert.ok(!inputNames.includes("open_subscribe"));
  assert.ok(!reportNames.includes("open_subscribe"));
});

test("validates and applies tool calls without permitting quota-consuming execution", () => {
  const action = agent.validateToolCall(
    "fill_form",
    { brand: "Linear", competitors: ["Notion", "Notion", "Asana"] },
    {}
  );
  assert.equal(action.type, "fill_form");
  assert.deepEqual(action.payload.competitors, ["Notion", "Asana"]);
  const state = agent.applyToolToState(action, {});
  assert.equal(state.brand, "Linear");
  const rerun = agent.validateToolCall("prepare_analysis", { brand: "Linear" }, state);
  assert.equal(rerun.type, "prepare_analysis");
});

test("keeps a completed report in Agent tool context", () => {
  const state = {
    brand: "李宁",
    competitors: ["安踏", "nike", "阿迪"],
    buyerQuestions: [],
    reportState: "complete",
    report: {
      id: "report_1",
      isReal: true,
      brand: "李宁",
      competitors: ["安踏", "nike", "阿迪"],
      score: 58,
      mentioned: 4,
      totalQuestions: 6,
      sentiment: 62,
      rank: 3,
      questionStats: [{ questionIndex: 0, question: "李宁适合哪些团队？", mentioned: true }]
    }
  };
  const action = agent.validateToolCall("explain_score", {}, state);
  const result = agent.toolResultFor(action, agent.applyToolToState(action, state));
  assert.equal(result.reportState, "complete");
  assert.equal(result.state.report.score, 58);
  assert.match(result.note, /真实证据/);
  assert.match(agent.systemPrompt("report", state), /李宁/);
  assert.match(agent.systemPrompt("report", state), /绝不能称为草稿/);
  assert.throws(
    () => agent.validateToolCall("explain_score", {}, { reportState: "draft" }),
    /completed report/
  );
});

test("runAgentTurn applies validated tool calls to the page state", async () => {
  let calls = 0;
  const result = await agent.runAgentTurn({
    messages: [{ role: "user", content: "帮我检测小米，对比苹果" }],
    state: {},
    callChatImpl: async () => {
      calls += 1;
      return calls === 1
        ? {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "fill_form",
                    arguments: JSON.stringify({
                      brand: "小米",
                      competitors: ["苹果"]
                    })
                  }
                }
              ]
            }
          }
        : { message: { content: "已填好表单，请确认后开始检测。", tool_calls: [] } };
    }
  });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, "fill_form");
  assert.equal(result.actions[0].payload.brand, "小米");
  assert.equal(result.state.brand, "小米");
  assert.deepEqual(result.state.competitors, ["苹果"]);
  assert.equal(result.reply, "已填好表单，请确认后开始检测。");
});

test("runAgentTurn keeps internal tool errors out of the model and user reply", async () => {
  const conversations = [];
  const result = await agent.runAgentTurn({
    messages: [{ role: "user", content: "帮我填一下品牌" }],
    state: {},
    callChatImpl: async (options) => {
      conversations.push(options.messages);
      return conversations.length === 1
        ? {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "fill_form", arguments: "{not valid json" }
                }
              ]
            }
          }
        : { message: { content: "这次没有成功，请稍后再试。", tool_calls: [] } };
    }
  });
  const toolEntry = conversations[1].find((message) => message.role === "tool");
  assert.ok(toolEntry, "expected a tool result message in the next round");
  assert.match(toolEntry.content, /invalid_tool_call/);
  assert.doesNotMatch(toolEntry.content, /SyntaxError|Unexpected token|JSON\.parse/);
  assert.doesNotMatch(toolEntry.content, /node:internal|\bat Object\b/);
  assert.equal(result.actions.length, 0);
  assert.doesNotMatch(result.reply, /SyntaxError|Unexpected token|constant variable/);
});

test("keeps the report conclusions and recommendations in the agent context", () => {
  const state = agent.stateSnapshot({
    brand: "林里",
    reportState: "complete",
    report: {
      id: "report_1",
      isReal: true,
      brand: "林里",
      competitors: ["喜茶"],
      score: 58,
      positioning: {
        headline: "AI 认为林里主打清爽",
        consensus: "两个模型都提到甜度",
        differentiators: "比喜茶更克制",
        conflicts: [
          {
            entityName: "林里",
            question: "清爽场景下哪个更合适？",
            summary: "",
            sides: [{ model: "glm-4.6v", quote: "林里甜度偏高。" }]
          }
        ]
      },
      suggestions: [
        {
          title: "补充实测",
          analysis: "证据不足",
          suggestion: "公布 AAC 实测数据",
          evidence: [{ model: "deepseek-flash", question: "Q", quote: "音质会打折。" }]
        }
      ]
    }
  });
  assert.equal(state.report.positioning.headline, "AI 认为林里主打清爽");
  assert.equal(state.report.positioning.conflicts[0].entityName, "林里");
  assert.equal(state.report.recommendations.length, 1);
  assert.equal(state.report.recommendations[0].title, "补充实测");
  assert.match(state.report.recommendations[0].suggestion, /实测数据/);
});

test("tells the assistant to answer measure questions from the report itself", () => {
  const prompt = agent.systemPrompt("report", {
    brand: "林里",
    reportState: "complete",
    report: { score: 60 }
  });
  // Behaviour, not the internal field name: the rule has to be stated in
  // Chinese and backed by the authoritative count.
  assert.match(prompt, /行动建议/);
  assert.match(prompt, /recommendationCount 为准/);
  assert.match(prompt, /措施/);
  assert.match(prompt, /禁止用/);
});

test("continues a truncated assistant reply instead of returning it cut off", async () => {
  let calls = 0;
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await agent.runAgentTurn({
      messages: [{ role: "user", content: "有什么具体措施" }],
      state: { brand: "林里", reportState: "complete" },
      callChatImpl: async () => {
        calls += 1;
        return calls === 1
          ? {
              message: { content: "建议分两类措施：跨平台公布实测数据，长期使用" },
              finishReason: "length"
            }
          : {
              message: { content: "公开电池健康数据。", tool_calls: [] },
              finishReason: "stop"
            };
      }
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(calls, 2);
  assert.match(result.reply, /跨平台公布实测数据/);
  assert.match(result.reply, /公开电池健康数据/);
});

test("returns the model finish reason so truncation is observable", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      model: "deepseek-flash",
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: "cut off" }
        }
      ]
    })
  });
  try {
    const completion = await model.callChat({
      provider: "deepseek",
      role: "agent",
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(completion.finishReason, "length");
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

const openQuestionState = () => ({
  brand: "林里",
  reportState: "complete",
  report: {
    id: "report_1",
    isReal: true,
    brand: "林里",
    competitors: ["喜茶"],
    score: 58,
    totalQuestions: 2,
    questionStats: [
      {
        questionIndex: 0,
        question: "林里和喜茶在清爽场景下谁更合适？",
        askedEntityIds: ["brand", "competitor_1"],
        entityScores: {
          brand: { applicable: true, mentioned: true, score: 72, dimensions: { presence: 100 } },
          competitor_1: { applicable: true, mentioned: false, score: 0, dimensions: { presence: 0 } }
        },
        models: []
      }
    ],
    observations: [
      {
        model: "deepseek-flash",
        provider: "deepseek",
        questionIndex: 0,
        question: "林里和喜茶在清爽场景下谁更合适？",
        answer: "林里在清爽场景下甜度控制更克制，喜茶偏甜。",
        mentioned: true,
        mentionQuote: "林里在清爽场景下甜度控制更克制。"
      },
      {
        model: "glm-4.6v",
        provider: "glm",
        questionIndex: 0,
        question: "林里和喜茶在清爽场景下谁更合适？",
        answer: "两家各有侧重。",
        mentioned: false
      }
    ],
    entityStats: [
      {
        id: "brand",
        type: "brand",
        name: "林里",
        score: 58,
        askedQuestions: 2,
        totalQuestions: 2,
        insufficient: false,
        rankable: true,
        mentions: 1
      }
    ],
    ranking: [{ id: "brand", name: "林里", rank: 1, score: 58 }]
  }
});

test("gives the assistant a summary card and keeps every detail behind a tool", () => {
  const prompt = agent.systemPrompt("report", openQuestionState());
  // The card carries the numbers the assistant may quote...
  assert.match(prompt, /"dataVersion":"AL-[0-9A-F]{8}"/);
  assert.match(prompt, /"score":58/);
  assert.match(prompt, /"recommendationCount":0/);
  // ...and points at read-only tools for everything it must not guess.
  assert.match(prompt, /get_positioning/);
  assert.match(prompt, /get_recommendations/);
  assert.match(prompt, /get_comparison/);
  assert.ok(
    !/林里在清爽场景下甜度控制更克制/.test(prompt),
    "raw answers must stay out of the prompt"
  );
  assert.match(prompt, /search_evidence/);
  assert.match(prompt, /来源/);
});

test("summarises the report with a stable data fingerprint", () => {
  const state = openQuestionState();
  const first = agent.promptSnapshot(state);
  const second = agent.promptSnapshot(state);
  assert.equal(first.page, "report");
  assert.equal(first.report.dataVersion, second.report.dataVersion);
  assert.match(agent.reportFingerprint(first.report), /^AL-[0-9A-F]{8}$/);
  assert.equal(first.report.evidenceCount, 2);
  assert.equal(first.report.questionCount, 1);

  const changed = JSON.parse(JSON.stringify(state));
  changed.report.score = 61;
  assert.notEqual(
    agent.promptSnapshot(changed).report.dataVersion,
    first.report.dataVersion,
    "a new score must produce a new fingerprint"
  );

  const edited = JSON.parse(JSON.stringify(state));
  edited.report.questionStats[0].question = "改过的买家问题？";
  assert.notEqual(
    agent.promptSnapshot(edited).report.dataVersion,
    first.report.dataVersion,
    "edited questions must produce a new fingerprint"
  );

  // The card is small on purpose: the report body stays out of the prompt.
  assert.ok(JSON.stringify(first.report).length < 900);
  assert.equal(agent.promptSnapshot({}).report, null);
});

test("reads positioning and recommendations back on demand", () => {
  const state = openQuestionState();
  state.report.positioning = {
    headline: "AI 认为林里主打清爽",
    consensus: "两个模型都提到甜度",
    differentiators: "比喜茶更克制",
    conflicts: [
      {
        entityName: "林里",
        question: "清爽场景下哪个更合适？",
        summary: "",
        sides: [{ model: "glm-4.6v", quote: "林里甜度偏高。" }]
      }
    ]
  };
  state.report.suggestions = [
    {
      title: "补充实测",
      analysis: "证据不足",
      suggestion: "公布 AAC 实测数据",
      evidence: [{ model: "deepseek-flash", question: "Q", quote: "音质会打折。" }]
    }
  ];

  const positioning = agent.toolResultFor(
    agent.validateToolCall("get_positioning", {}, state),
    state
  );
  assert.equal(positioning.headline, "AI 认为林里主打清爽");
  assert.equal(positioning.conflicts[0].entityName, "林里");

  const recommendations = agent.toolResultFor(
    agent.validateToolCall("get_recommendations", {}, state),
    state
  );
  assert.equal(recommendations.count, 1);
  assert.match(recommendations.items[0].suggestion, /实测数据/);
  assert.match(recommendations.note, /原样使用/);

  // Both are report-only read tools: no report, no call.
  assert.throws(() => agent.validateToolCall("get_recommendations", {}, {}), /completed report/);
  assert.throws(() => agent.validateToolCall("get_positioning", {}, {}), /completed report/);

  const reportNames = agent.toolsForContext("report").map((tool) => tool.function.name);
  assert.ok(reportNames.includes("get_recommendations"));
  assert.ok(reportNames.includes("get_positioning"));
  const inputNames = agent.toolsForContext("input").map((tool) => tool.function.name);
  assert.ok(!inputNames.includes("get_recommendations"));
  assert.ok(!inputNames.includes("get_positioning"));
});

test("keeps the positioning and recommendation text out of the prompt", () => {
  const state = openQuestionState();
  state.report.positioning = { headline: "AI 认为林里主打清爽" };
  state.report.suggestions = [
    { title: "补充实测", analysis: "证据不足", suggestion: "公布 AAC 实测数据" }
  ];
  const prompt = agent.systemPrompt("report", state);
  assert.ok(!/公布 AAC 实测数据/.test(prompt), "recommendation text must be read, not pasted");
  assert.ok(!/AI 认为林里主打清爽/.test(prompt), "positioning text must be read, not pasted");
  assert.match(prompt, /"hasPositioning":true/);
  assert.match(prompt, /"recommendationCount":1/);
});

test("tells the assistant to admit when search results are off topic", async () => {
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await agent.webToolResult(
      agent.validateToolCall("search_web", { query: "库迪咖啡 新品" }, {}),
      {
        callSearch: async (query) => ({
          status: "ok",
          query,
          results: [
            {
              title: "库迪成为世界杯授权零售商",
              url: "https://example.com/a",
              content: "营销活动"
            }
          ]
        })
      }
    );
  } finally {
    console.error = originalError;
  }
  assert.match(result.note, /是否真的回答了用户的问题/);
  assert.match(result.note, /没有搜到与这个问题直接相关的信息/);
  assert.match(result.note, /禁止把这些内容当作答案呈现/);
  // The rail that matters is the tool result the model always sees before it
  // answers about a search — not a sentence pinned in the prompt.
  assert.match(result.note, /禁止把这些内容当作答案呈现/);
  assert.equal(result.searchStatus, "ok");
  assert.equal(result.results.length, 1);
});

test("asks for components once when the model answers in prose", async () => {
  const originalError = console.error;
  console.error = () => {};
  const rounds = [];
  let result;
  try {
    result = await agent.runAgentTurn({
      messages: [{ role: "user", content: "库迪最近有什么新品" }],
      state: openQuestionState(),
      callChatImpl: async ({ messages }) => {
        rounds.push(messages);
        if (rounds.length === 1) {
          return {
            message: {
              content:
                "报告里没有这部分数据。搜到的都是营销活动：库迪成了世界杯授权零售商 9.9元促销三年不停。",
              tool_calls: []
            },
            finishReason: "stop"
          };
        }
        return {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_render",
                type: "function",
                function: {
                  name: "render_answer",
                  arguments: JSON.stringify({
                    blocks: [
                      { type: "text", text: "没有搜到与库迪新品直接相关的信息。" },
                      {
                        type: "sources",
                        items: [
                          {
                            title: "库迪成为世界杯授权零售商",
                            url: "https://example.com/a",
                            host: "example.com"
                          }
                        ]
                      }
                    ]
                  })
                }
              }
            ]
          },
          finishReason: "tool_calls"
        };
      }
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(rounds.length, 2, "one retry is requested");
  assert.match(
    JSON.stringify(rounds[1]),
    /改用 render_answer 工具重新输出/,
    "the retry must ask for components"
  );
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[1].type, "sources");
});

test("does not force components for a one-line confirmation", async () => {
  let calls = 0;
  const result = await agent.runAgentTurn({
    messages: [{ role: "user", content: "好的" }],
    state: openQuestionState(),
    callChatImpl: async () => {
      calls += 1;
      return {
        message: { content: "好的，随时可以继续。", tool_calls: [] },
        finishReason: "stop"
      };
    }
  });
  assert.equal(calls, 1, "short confirmations must not trigger a retry");
  assert.deepEqual(result.blocks, []);
  assert.match(result.reply, /随时可以继续/);
  assert.equal(agent.needsRender("好的"), false);
  assert.equal(agent.needsRender("x".repeat(60)), true);
});

test("renders answers as whitelisted components only", () => {
  const blocks = agent.normalizeAnswerBlocks({
    blocks: [
      { type: "text", text: "报告里已经有 3 条行动建议。" },
      {
        type: "task_list",
        title: "可认领任务",
        items: [
          { text: "补充城市通勤续航实测", owner: "产品", priority: "高" },
          { text: "" }
        ]
      },
      {
        type: "table",
        title: "逐题对比",
        columns: ["题号", "比亚迪", "蔚来"],
        rows: [["第2题", "88", "91"]]
      },
      {
        type: "sources",
        title: "外部来源",
        items: [
          { title: "某报道", url: "https://example.com/a", snippet: "摘要" },
          { title: "坏链接", url: "javascript:alert(1)" }
        ]
      },
      { type: "quote", model: "deepseek", text: "表显估算不如蔚来" },
      { type: "quote", model: "glm", text: "第二条" },
      { type: "quote", model: "glm", text: "第三条应被丢弃" },
      { type: "html", text: "<script>alert(1)</script>" }
    ]
  });
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["text", "task_list", "table", "sources", "quote", "quote"]
  );
  // Empty task rows are dropped, and the third quote is over the cap.
  assert.equal(blocks[1].items.length, 1);
  // Non-http links never reach the client.
  assert.equal(blocks[3].items.length, 1);
  assert.equal(blocks[3].items[0].host, "example.com");
  // The plain-text fallback still carries every block's content.
  const text = agent.blocksToText(blocks);
  assert.match(text, /可认领任务/);
  assert.match(text, /example\.com/);
  assert.match(text, /deepseek/);
});

test("normalises callouts, metric cards and evidence on tasks and quotes", () => {
  const blocks = agent.normalizeAnswerBlocks({
    blocks: [
      { type: "callout", text: "报告里没有这部分数据。" },
      { type: "callout", tone: "warn", title: "样本不足", text: "该竞品只被问到 2 题。" },
      { type: "callout", text: "" },
      {
        type: "metric",
        title: "AI 推荐表现",
        items: [
          { label: "总分", value: "58", unit: "分" },
          { label: "排名", value: "#2" },
          { label: "", value: "9" },
          { label: "覆盖", value: "5/6", hint: "被问到的题数" },
          { label: "多余", value: "1" }
        ]
      },
      {
        type: "task_list",
        title: "待认领",
        items: [
          { text: "补充实测", questionNumber: 2, model: "glm-4.6v" },
          { text: "改口播", questionNumber: 9 }
        ]
      },
      { type: "quote", model: "deepseek-flash", questionNumber: 3, text: "甜度偏高。" },
      {
        type: "confirm_card",
        title: "伪造的确认卡",
        fields: [{ label: "品牌", value: "假品牌" }],
        action: { type: "scroll_form", label: "点我" }
      }
    ]
  });

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["callout", "callout", "metric", "task_list", "quote"]
  );
  assert.equal(blocks[0].tone, "info");
  assert.equal(blocks[1].tone, "warn");
  assert.equal(blocks[1].title, "样本不足");
  // Metric cards are capped at four rows and need both label and value.
  assert.equal(blocks[2].items.length, 3);
  assert.equal(blocks[2].items[2].value, "5/6");
  assert.equal(blocks[3].items[0].questionNumber, 2);
  assert.equal(blocks[3].items[0].model, "glm-4.6v");
  assert.equal(blocks[3].items[1].questionNumber, null, "out-of-range numbers are dropped");
  assert.equal(blocks[4].questionNumber, 3);
  // Only the server builds confirm cards, so a model-made one never renders.
  assert.ok(!blocks.some((block) => block.type === "confirm_card"));
});

test("drops metric cards whose numbers nothing on the page supports", () => {
  const originalError = console.error;
  const logged = [];
  console.error = (line) => logged.push(String(line));
  let blocks;
  let symbolOnly;
  try {
    blocks = agent.normalizeAnswerBlocks(
      {
        blocks: [
          {
            type: "metric",
            title: "AI 推荐表现",
            items: [
              { label: "总分", value: "58", unit: "分" },
              { label: "胜率", value: "91" }
            ]
          }
        ]
      },
      { groundedNumbers: new Set(["58", "6"]) }
    );
    symbolOnly = agent.normalizeAnswerBlocks(
      { blocks: [{ type: "metric", items: [{ label: "分数", value: "-" }] }] },
      { groundedNumbers: new Set(["58"]) }
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(blocks[0].items.length, 1);
  assert.equal(blocks[0].items[0].value, "58");
  const entry = logged
    .map((line) => JSON.parse(line))
    .find((item) => item.event === "agent_metric_dropped");
  assert.ok(entry, "an ungrounded metric must be logged");
  assert.deepEqual(entry.values, ["91"]);
  // "样本不足" renders as "-", which carries no number to verify.
  assert.equal(symbolOnly[0].items[0].value, "-");
  assert.equal(agent.metricIsGrounded("5/6", new Set(["5", "6"])), true);
  assert.equal(agent.metricIsGrounded("5/6", new Set(["5"])), false);
});

test("grounds metric numbers in the report and this turn's tool results", async () => {
  const state = openQuestionState();
  state.report.score = 58;
  const result = await agent.runAgentTurn({
    messages: [{ role: "user", content: "我得了多少分？" }],
    state,
    callChatImpl: async () => ({
      message: {
        content: "",
        tool_calls: [
          {
            id: "call_metric",
            type: "function",
            function: {
              name: "render_answer",
              arguments: JSON.stringify({
                blocks: [
                  {
                    type: "metric",
                    title: "AI 推荐表现",
                    items: [
                      { label: "总分", value: "58", unit: "分" },
                      { label: "编造的分数", value: "88", unit: "分" }
                    ]
                  }
                ]
              })
            }
          }
        ]
      },
      finishReason: "tool_calls"
    })
  });
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].items.length, 1);
  assert.equal(result.blocks[0].items[0].value, "58");
});

test("appends a confirm card whenever the assistant changes the form", async () => {
  const calls = [];
  const result = await agent.runAgentTurn({
    messages: [{ role: "user", content: "帮我检测小米 14，对比苹果" }],
    state: {},
    callChatImpl: (() => {
      let round = 0;
      return async ({ messages }) => {
        round += 1;
        calls.push(messages);
        if (round === 1) {
          return {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_fill",
                  type: "function",
                  function: {
                    name: "fill_form",
                    arguments: JSON.stringify({
                      brand: "小米",
                      brandProduct: "14",
                      competitors: ["苹果"],
                      competitorProducts: ["iPhone 17 Pro"],
                      other: "重点比较屏幕体验"
                    })
                  }
                }
              ]
            },
            finishReason: "tool_calls"
          };
        }
        return {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_render",
                type: "function",
                function: {
                  name: "render_answer",
                  arguments: JSON.stringify({
                    blocks: [{ type: "text", text: "已填好表单，确认后开始检测。" }]
                  })
                }
              }
            ]
          },
          finishReason: "tool_calls"
        };
      };
    })()
  });

  const card = result.blocks.find((block) => block.type === "confirm_card");
  assert.ok(card, "a form action must ship with a confirm card");
  assert.equal(card.title, "已填好检测表单");
  assert.deepEqual(
    card.fields.map((field) => field.label),
    ["品牌", "产品/型号", "竞品", "竞品产品", "其他补充"]
  );
  assert.equal(card.fields[0].value, "小米");
  assert.equal(card.fields[3].value, "iPhone 17 Pro");
  assert.deepEqual(card.action, { type: "scroll_form", label: "去确认并开始检测" });
  // The card never replaces the page action, and it never consumes quota.
  assert.equal(result.actions[0].type, "fill_form");
  assert.match(result.reply, /品牌：小米/);
  assert.match(result.reply, /去确认并开始检测/);
});

test("a prose reply after a form action still carries the confirm card", async () => {
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await agent.runAgentTurn({
      messages: [{ role: "user", content: "把竞品换成奈雪" }],
      state: openQuestionState(),
      callChatImpl: (() => {
        let round = 0;
        return async () => {
          round += 1;
          if (round === 1) {
            return {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_update",
                    type: "function",
                    function: {
                      name: "update_competitors",
                      arguments: JSON.stringify({ competitors: ["奈雪"] })
                    }
                  }
                ]
              },
              finishReason: "tool_calls"
            };
          }
          return {
            message: { content: "竞品已经换成奈雪，重新检测才会更新报告。", tool_calls: [] },
            finishReason: "stop"
          };
        };
      })()
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].type, "text");
  assert.equal(result.blocks[1].type, "confirm_card");
  assert.match(result.blocks[1].title, /竞品已替换/);
  assert.equal(result.blocks[1].fields[0].value, "奈雪");
  assert.equal(result.actions[0].type, "update_competitors");
});

test("flattens the new components into a plain-text fallback", () => {
  const text = agent.blocksToText([
    { type: "callout", title: "样本不足", text: "该竞品只被问到 2 题。" },
    {
      type: "metric",
      title: "AI 推荐表现",
      items: [{ label: "总分", value: "58", unit: "分", hint: "6 题平均" }]
    },
    { type: "task_list", items: [{ text: "补充实测", questionNumber: 2 }] },
    { type: "quote", model: "glm-4.6v", questionNumber: 3, text: "甜度偏高。" },
    {
      type: "confirm_card",
      title: "已填好检测表单",
      fields: [{ label: "品牌", value: "小米" }],
      action: { type: "scroll_form", label: "去确认并开始检测" }
    }
  ]);
  assert.match(text, /样本不足：该竞品只被问到 2 题。/);
  assert.match(text, /总分 58分（6 题平均）/);
  assert.match(text, /1\. 补充实测（依据：第 2 题）/);
  assert.match(text, /第 3 题 · glm-4.6v：甜度偏高。/);
  assert.match(text, /品牌：小米/);
  assert.match(text, /去确认并开始检测/);
});

test("answer components are sanitised with the same rails as plain replies", () => {
  const blocks = agent.normalizeAnswerBlocks({
    blocks: [
      { type: "text", text: "这份报告里没有生成行动建议（recommendations 为空）。" },
      { type: "table", columns: ["recommendations"], rows: [["positioning"]] }
    ]
  });
  assert.match(blocks[0].text, /行动建议/);
  assert.doesNotMatch(blocks[0].text, /recommendations/);
  assert.equal(blocks[1].columns[0], "行动建议");
  assert.equal(blocks[1].rows[0][0], "定位判断");
});

test("reads the report conclusions through tools inside a real turn", async () => {
  const state = openQuestionState();
  state.report.positioning = { headline: "AI 认为林里主打清爽" };
  state.report.suggestions = [
    {
      title: "补充实测",
      analysis: "证据不足",
      suggestion: "公布 AAC 实测数据"
    }
  ];
  const rounds = [];
  const result = await agent.runAgentTurn({
    messages: [{ role: "user", content: "我应该先做什么？" }],
    state,
    callChatImpl: async ({ messages }) => {
      rounds.push(messages);
      if (rounds.length === 1) {
        return {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_read",
                type: "function",
                function: { name: "get_recommendations", arguments: "{}" }
              }
            ]
          },
          finishReason: "tool_calls"
        };
      }
      return {
        message: {
          content: "",
          tool_calls: [
            {
              id: "call_render",
              type: "function",
              function: {
                name: "render_answer",
                arguments: JSON.stringify({
                  blocks: [{ type: "text", text: "先补齐实测证据：公布 AAC 实测数据。" }]
                })
              }
            }
          ]
        },
        finishReason: "tool_calls"
      };
    }
  });

  // The report text reaches the model only as a tool result...
  const toolEntry = rounds[1].find((message) => message.role === "tool");
  assert.ok(toolEntry, "the read tool must run before the answer");
  assert.match(toolEntry.content, /公布 AAC 实测数据/);
  assert.doesNotMatch(rounds[0][0].content, /公布 AAC 实测数据/);
  // ...and reading it is not a page action.
  assert.deepEqual(result.actions, []);
  assert.equal(result.blocks.length, 1);
  assert.match(result.reply, /AAC 实测数据/);
});

test("a render_answer call delivers blocks and ends the turn", async () => {
  const result = await agent.runAgentTurn({
    messages: [{ role: "user", content: "帮我写任务清单" }],
    state: openQuestionState(),
    callChatImpl: (() => {
      let round = 0;
      return async () => {
        round += 1;
        if (round === 1) {
          return {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_render",
                  type: "function",
                  function: {
                    name: "render_answer",
                    arguments: JSON.stringify({
                      blocks: [
                        { type: "text", text: "按报告建议拆成三项。" },
                        {
                          type: "task_list",
                          title: "待认领",
                          items: [{ text: "补充续航实测", priority: "高" }]
                        }
                      ]
                    })
                  }
                }
              ]
            },
            finishReason: "tool_calls"
          };
        }
        throw new Error("the turn must end after render_answer");
      };
    })()
  });
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[1].type, "task_list");
  assert.match(result.reply, /补充续航实测/);
  // Rendering is not a page action, so nothing is sent to the client.
  assert.deepEqual(result.actions, []);
});

test("output rails block a false 'no recommendations' claim", () => {
  const state = {
    report: {
      recommendationCount: 3,
      suggestions: [
        { title: "强化城市通勤续航达成率认知", suggestion: "输出可验证的实测内容" },
        { title: "补齐高速补能便利性叙事", suggestion: "补充快充功率与充电曲线说明" },
        { title: "明确质保限制条件的对外表述", suggestion: "主动澄清首任车主等限制" }
      ]
    }
  };
  const originalError = console.error;
  console.error = () => {};
  let blocked;
  let blockedEmpty;
  let untouched;
  let noReport;
  try {
    blocked = agent.applyOutputRails(
      "这份报告里没有生成行动建议（recommendations 为空），所以我不能编。",
      state
    );
    blockedEmpty = agent.applyOutputRails("报告里没有行动建议。", state);
    untouched = agent.applyOutputRails("报告里有 3 条行动建议。", state);
    noReport = agent.applyOutputRails("报告里没有行动建议。", { report: {} });
  } finally {
    console.error = originalError;
  }
  // Whenever the report really has recommendations, the reply is replaced with
  // the deterministic list, so the user always gets them.
  assert.match(blocked, /报告里已经有 3 条行动建议/);
  assert.match(blocked, /强化城市通勤续航达成率认知/);
  assert.match(blockedEmpty, /报告里已经有 3 条行动建议/);
  // A truthful reply and a report with no recommendations are left alone.
  assert.equal(untouched, "报告里有 3 条行动建议。");
  assert.equal(noReport, "报告里没有行动建议。");
});

test("output rails translate leaked field names into Chinese", () => {
  const originalError = console.error;
  console.error = () => {};
  let translated;
  let clean;
  try {
    translated = agent.applyOutputRails(
      "你可以看 positioning 里的结论，再看 questionStats。",
      { report: {} }
    );
    clean = agent.applyOutputRails("报告里已经有行动建议。", { report: {} });
  } finally {
    console.error = originalError;
  }
  assert.equal(translated, "你可以看定位判断里的结论，再看逐题数据。");
  assert.equal(clean, "报告里已经有行动建议。");
});

test("makes the assistant read recommendations back before denying them", async () => {
  const state = openQuestionState();
  state.report.suggestions = [
    {
      title: "强化续航认知",
      analysis: "deepseek 认为表显估算偏乐观",
      suggestion: "补充可验证的实测内容"
    }
  ];
  // The count is the authoritative signal the assistant must not contradict.
  assert.equal(agent.promptSnapshot(state).report.recommendationCount, 1);
  assert.match(agent.systemPrompt("report", state), /recommendationCount 为准/);

  // Behaviour, not prompt wording: a "there are no recommendations" claim is
  // replaced with the real list by the output rails.
  const calls = [];
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await agent.runAgentTurn({
      messages: [{ role: "user", content: "报告里有什么行动建议？" }],
      state,
      callChatImpl: async ({ messages }) => {
        calls.push(messages);
        return {
          message: {
            content: "这份报告里没有生成行动建议（recommendations 为空）。",
            tool_calls: []
          },
          finishReason: "stop"
        };
      }
    });
  } finally {
    console.error = originalError;
  }
  assert.match(result.reply, /报告里已经有 1 条行动建议/);
  assert.match(result.reply, /强化续航认知/);
  assert.doesNotMatch(result.reply, /recommendations/);
  assert.ok(calls.length >= 1);
});

test("keeps answers synthesised instead of pasted", () => {
  const prompt = agent.systemPrompt("report", openQuestionState());
  assert.match(prompt, /不要摘抄/);
  assert.match(prompt, /最多引用两处/);
  assert.match(prompt, /禁止把两个模型的回答逐段罗列/);
  assert.match(prompt, /必须先综合成结论再回答/);
  assert.match(prompt, /禁止只丢一堆链接/);
});

test("answers open questions by classifying intent instead of refusing", () => {
  const prompt = agent.systemPrompt("report", openQuestionState());
  assert.match(prompt, /报告内可答/);
  assert.match(prompt, /报告内可推导/);
  assert.match(prompt, /报告外但相关/);
  assert.match(prompt, /基于报告的推断/);
  assert.match(prompt, /300 个汉字/);
});

test("exposes read-only report tools to the report-page assistant", () => {
  const names = agent.toolsForContext("report").map((tool) => tool.function.name);
  for (const name of [
    "get_comparison",
    "get_question_detail",
    "search_evidence",
    "search_web"
  ]) {
    assert.ok(names.includes(name), `report tools must include ${name}`);
  }
  const inputNames = agent.toolsForContext("input").map((tool) => tool.function.name);
  assert.ok(inputNames.includes("search_web"));
  assert.ok(!inputNames.includes("search_evidence"), "no report means no evidence search");
});

test("returns exact wording from the real answers instead of paraphrasing", () => {
  const state = openQuestionState();
  const action = agent.validateToolCall("search_evidence", { query: "清爽 甜度" }, state);
  const result = agent.toolResultFor(action, state);
  assert.equal(result.matched, 1);
  assert.equal(
    result.results[0].quote,
    "林里在清爽场景下甜度控制更克制。"
  );
  assert.equal(result.results[0].model, "deepseek-flash");
  // Question numbers are 1-based everywhere the model can see them.
  assert.equal(result.results[0].questionNumber, 1);
});

test("exposes per-question detail and comparison facts", () => {
  const state = openQuestionState();
  const detail = agent.toolResultFor(
    agent.validateToolCall("get_question_detail", { questionNumber: 1 }, state),
    state
  );
  assert.equal(detail.questionNumber, 1);
  assert.equal(detail.entityScores.find((item) => item.id === "brand").score, 72);
  assert.equal(
    detail.entityScores.find((item) => item.id === "competitor_1").applicable,
    true
  );
  assert.equal(detail.answers.length, 2);

  const comparison = agent.toolResultFor(
    agent.validateToolCall("get_comparison", {}, state),
    state
  );
  assert.equal(comparison.ranking[0].rank, 1);
  assert.equal(comparison.entities[0].name, "林里");
  assert.throws(
    () => agent.validateToolCall("get_question_detail", { questionNumber: 9 }, state),
    /questionNumber/
  );
  assert.throws(
    () => agent.validateToolCall("get_question_detail", { questionNumber: 0 }, state),
    /questionNumber/
  );
});

test("runs a web search and tells the assistant to cite sources", async () => {
  const seen = [];
  const result = await agent.runAgentTurn({
    messages: [{ role: "user", content: "喜茶最近有什么新品？" }],
    state: openQuestionState(),
    searchImpl: async (query) => {
      seen.push(query);
      return {
        status: "ok",
        query,
        results: [
          {
            title: "喜茶新品发布",
            url: "https://example.com/news",
            content: "喜茶推出新口味。"
          }
        ]
      };
    },
    callChatImpl: (() => {
      let round = 0;
      return async () => {
        round += 1;
        if (round === 1) {
          return {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_web",
                  type: "function",
                  function: {
                    name: "search_web",
                    arguments: JSON.stringify({ query: "喜茶 新品" })
                  }
                }
              ]
            },
            finishReason: "tool_calls"
          };
        }
        return {
          message: {
            content: "报告里没有这部分数据。来源：喜茶新品发布 https://example.com/news",
            tool_calls: []
          },
          finishReason: "stop"
        };
      };
    })()
  });
  assert.deepEqual(seen, ["喜茶 新品"]);
  assert.match(result.reply, /https:\/\/example\.com\/news/);
});

test("never shows the model a zero-based question number", () => {
  const prompt = agent.systemPrompt("report", openQuestionState());
  assert.ok(
    !/"questionIndex"/.test(prompt),
    "0-based indexes must not leak into the prompt"
  );
  // Per-question data is read on demand, so the card carries no question
  // numbers at all — and the tool hands them back 1-based.
  assert.ok(!/"questionNumber"/.test(prompt));
  assert.match(prompt, /get_question_detail/);
  assert.match(prompt, /题号对用户一律从 1 开始/);

  const state = openQuestionState();
  const detail = agent.toolResultFor(
    agent.validateToolCall("get_question_detail", { questionNumber: 1 }, state),
    state
  );
  assert.equal(detail.questionNumber, 1);

  const detailTool = agent.TOOL_DEFINITIONS.get_question_detail.function;
  assert.ok("questionNumber" in detailTool.parameters.properties);
  assert.ok(!("questionIndex" in detailTool.parameters.properties));
  assert.equal(detailTool.parameters.properties.questionNumber.minimum, 1);
});

test("describes the exact web-search status instead of a vague failure", async () => {
  const originalError = console.error;
  console.error = () => {};
  let cases;
  try {
    const action = agent.validateToolCall("search_web", { query: "喜茶 新品" }, {});
    cases = {
      notConfigured: await agent.webToolResult(action, {
        callSearch: async () => ({ status: "not_configured", query: "喜茶 新品", results: [] })
      }),
      failed: await agent.webToolResult(action, {
        callSearch: async () => ({
          status: "failed",
          code: "search_timeout",
          query: "喜茶 新品",
          results: [],
          error: "timed out"
        })
      }),
      empty: await agent.webToolResult(action, {
        callSearch: async () => ({ status: "empty", query: "喜茶 新品", results: [] })
      })
    };
  } finally {
    console.error = originalError;
  }
  assert.equal(cases.notConfigured.searchStatus, "not_configured");
  assert.match(cases.notConfigured.note, /尚未配置/);
  assert.match(cases.notConfigured.note, /禁止说成“联网功能不可用”/);

  assert.equal(cases.failed.searchStatus, "failed");
  assert.match(cases.failed.note, /请求失败/);
  assert.match(cases.failed.note, /禁止说成“联网功能不可用”/);

  assert.equal(cases.empty.searchStatus, "empty");
  assert.match(cases.empty.note, /没有搜到/);
});

test("logs every web-search attempt so failures are diagnosable", async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    const action = agent.validateToolCall("search_web", { query: "喜茶 新品" }, {});
    await agent.webToolResult(action, {
      callSearch: async () => ({
        status: "failed",
        code: "search_timeout",
        query: "喜茶 新品",
        results: [],
        error: "timed out after 8000ms"
      })
    });
  } finally {
    console.error = originalError;
  }
  const entry = logged.map((line) => JSON.parse(line)).find((item) => item.event === "agent_web_search");
  assert.ok(entry, "a web search attempt must be logged");
  assert.equal(entry.status, "failed");
  assert.equal(entry.code, "search_timeout");
  assert.equal(entry.query, "喜茶 新品");
  assert.ok(Number.isFinite(entry.durationMs));
});

test("never reports an unavailable score as zero", () => {
  const state = {
    brand: "林里",
    reportState: "complete",
    report: { isReal: true, brand: "林里", score: null, totalQuestions: 6 }
  };
  const snapshot = agent.promptSnapshot(state);
  assert.equal(snapshot.report.score, null);
  assert.equal(snapshot.report.scoreAvailable, false);
});

test("agent system prompt forbids leaking internal errors to users", () => {
  assert.match(
    agent.systemPrompt("input", {}),
    /禁止向用户披露任何内部错误/
  );
});

test("keeps 检测方向 user-controlled and routes assistant intents to other", () => {
  for (const name of ["fill_form", "prepare_analysis"]) {
    const tool = agent.TOOL_DEFINITIONS[name].function;
    assert.ok(
      !("directions" in tool.parameters.properties),
      `${name} must not expose directions`
    );
    assert.match(tool.parameters.properties.other.description, /检测方向/);
    assert.match(tool.description, /不要设置检测方向/);
  }

  const action = agent.validateToolCall(
    "fill_form",
    {
      brand: "麦当劳",
      competitors: ["汉堡王", "肯德基"],
      other: "重点比较服务态度"
    },
    {}
  );
  assert.ok(!("directions" in action.payload));
  assert.equal(action.payload.other, "重点比较服务态度");

  const next = agent.applyToolToState(action, { dimensions: ["产品体验"] });
  assert.deepEqual(next.dimensions, ["产品体验"]);
  assert.match(agent.systemPrompt("input", {}), /不要设置检测方向/);
});

test("agent route delegates to the tested runAgentTurn loop", async () => {
  const routeSource = await readFile(
    new URL("../api/agent.js", import.meta.url),
    "utf8"
  );
  const libSource = await readFile(
    new URL("../api/_lib/agent.js", import.meta.url),
    "utf8"
  );
  assert.match(routeSource, /runAgentTurn/);
  assert.doesNotMatch(routeSource, /const currentState/);
  assert.match(libSource, /let currentState = stateSnapshot/);
  assert.match(libSource, /currentState = applyToolToState\(action, currentState\)/);
});

test("computes a bounded report from observed model answers", () => {
  const report = analysis.analyzeObservations({
    brand: "Acme",
    competitors: ["Beta"],
    questions: ["Should I choose Acme or Beta?", "Is Acme more reliable than Beta?"],
    responses: [
      {
        provider: "deepseek",
        model: "DeepSeek",
        answers: ["Acme is a reliable recommendation.", "Beta is useful, but Acme is stronger."]
      },
      {
        provider: "glm",
        model: "GLM",
        answers: ["Beta is the safer choice.", "I recommend Acme for reliability."]
      }
    ]
  });
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.equal(report.totalQuestions, 2);
  assert.equal(report.matrix.length, 2);
  assert.equal(report.questions.length, 2);
  assert.equal(report.questionStats.length, 2);
  assert.equal(report.modelStats.length, 2);
  assert.equal(
    report.score,
    Math.round(
      report.questionStats.reduce((sum, item) => sum + item.score, 0) /
        report.questionStats.length
    )
  );
  assert.ok(
    report.questionStats.every(
      (item) =>
        item.dimensions &&
        ["presence", "rank", "sentiment", "evidence", "differentiation"].every(
          (key) => Number.isFinite(item.dimensions[key])
        )
    )
  );
});

test("scores every entity with the same five evidence-backed dimensions", () => {
  const report = analysis.analyzeObservations({
    brand: "Acme",
    competitors: ["Zed", "Nova", "Unasked"],
    questions: [
      "Compare Acme, Zed and Nova for reliability?",
      "Which of Acme, Zed and Nova is easier to start with?"
    ],
    responses: [
      {
        provider: "deepseek",
        model: "DeepSeek",
        answers: ["Neither option is mentioned here.", "Neither option is mentioned here."]
      }
    ]
  });
  // Both questions asked about the brand and both listed competitors, so each
  // scores a real 0 for being asked about but never mentioned.
  report.questionStats.forEach((stat) => {
    ["brand", "competitor_1", "competitor_2"].forEach((entityId) => {
      const score = stat.entityScores[entityId];
      assert.equal(score.applicable, true, `${entityId} should be applicable`);
      for (const key of ["presence", "rank", "sentiment", "evidence", "differentiation"]) {
        assert.ok(Number.isFinite(score[key]), `${entityId}.${key} must be numeric`);
      }
      assert.equal(score.score, 0, "asked but never mentioned must score 0");
    });
    assert.equal(stat.entityScores.competitor_3.applicable, false);
  });
  // A competitor no question ever asks about is not applicable and gets no score.
  const notAsked = report.questionStats[0].entityScores.competitor_3;
  assert.equal(notAsked.applicable, false);
  assert.equal(notAsked.dimensions, null);
  const thin = report.matrix.find((item) => item.id === "competitor_3");
  assert.equal(thin.asked, 0);
  assert.equal(thin.insufficient, true);
  assert.equal(thin.value, null);
  assert.equal(report.matrix.find((item) => item.id === "competitor_1").value, 0);
  assert.equal(report.matrix.find((item) => item.id === "competitor_2").value, 0);
});

test("scores on two questions but keeps it out of the ranking", () => {
  const report = analysis.analyzeObservations({
    brand: "Acme",
    competitors: ["Beta", "Gamma"],
    questions: [
      "Acme vs Beta vs Gamma for reliability?",
      "Acme vs Beta vs Gamma for price?",
      "Acme vs Beta for support?",
      "Acme vs Beta for longevity?"
    ],
    responses: [
      {
        provider: "deepseek",
        model: "DeepSeek",
        answers: [
          "Acme is the best, Beta is fine, Gamma is weak.",
          "Acme wins, Beta is fine, Gamma is weak.",
          "Acme wins, Beta is fine.",
          "Acme wins, Beta is fine."
        ]
      }
    ]
  });
  const gamma = report.entityStats.find((item) => item.name === "Gamma");
  assert.equal(gamma.askedQuestions, 2);
  assert.equal(gamma.insufficient, false, "two questions is not 'no score'");
  assert.equal(gamma.rankable, false, "two questions must not be ranked");
  assert.ok(Number.isFinite(gamma.score), "two questions still produce a score");

  const beta = report.entityStats.find((item) => item.name === "Beta");
  assert.equal(beta.askedQuestions, 4);
  assert.equal(beta.rankable, true);

  const rankedIds = report.ranking.map((item) => item.id);
  assert.ok(!rankedIds.includes(gamma.id), "low confidence must not be ranked");
  assert.equal(report.ranking[0].rank, 1);
  assert.equal(report.rankingMinQuestions, 3);
  assert.equal(report.minAskedQuestions, 2);
  // The unranked entity still appears in the comparison data, just not ranked.
  assert.ok(report.matrix.some((item) => item.id === gamma.id));
});

test("gives no score and no rank when an entity is asked once", () => {
  const report = analysis.analyzeObservations({
    brand: "Acme",
    competitors: ["Beta", "Gamma"],
    questions: ["Acme vs Beta vs Gamma?", "Acme vs Beta?", "Acme vs Beta?"],
    responses: [
      {
        provider: "deepseek",
        model: "DeepSeek",
        answers: ["Acme wins, Beta fine, Gamma weak.", "Acme wins.", "Acme wins."]
      }
    ]
  });
  const gamma = report.entityStats.find((item) => item.name === "Gamma");
  assert.equal(gamma.askedQuestions, 1);
  assert.equal(gamma.insufficient, true);
  assert.equal(gamma.score, null);
  const gammaRow = report.matrix.find((item) => item.id === gamma.id);
  assert.equal(gammaRow.value, null);
  assert.equal(gammaRow.insufficient, true);
  assert.ok(!report.ranking.map((item) => item.id).includes(gamma.id));
});

test("judges sentiment around each entity instead of the whole answer", () => {
  const report = analysis.analyzeObservations({
    brand: "Acme",
    competitors: ["Beta"],
    questions: ["Acme 和 Beta 哪个更好？"],
    responses: [
      {
        provider: "deepseek",
        model: "DeepSeek",
        answers: ["Acme 存在明显的缺点和风险。Beta 更值得推荐。"]
      }
    ]
  });
  const stat = report.questionStats[0].entityScores;
  assert.equal(stat.brand.sentiment, 20);
  assert.equal(stat.competitor_1.sentiment, 100);
  assert.notEqual(stat.brand.sentiment, stat.competitor_1.sentiment);
});

test("derives per-question mentions from evidence positions", () => {
  const report = analysis.analyzeObservations({
    brand: "Acme",
    competitors: ["Beta"],
    questions: ["Choose Beta?", "Choose Acme?"],
    responses: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        answers: ["Beta is useful.", "I recommend Acme."]
      },
      {
        provider: "glm",
        model: "glm-4.6v",
        answers: ["Choose Beta.", "Choose Beta."]
      }
    ]
  });
  assert.equal(report.mentioned, 1);
  assert.equal(report.questionStats[0].mentioned, false);
  assert.equal(report.questionStats[1].mentioned, true);
  assert.equal(report.modelStats.find((item) => item.provider === "deepseek").mentions, 1);
  assert.equal(report.modelStats.find((item) => item.provider === "glm").mentions, 0);
});

test("validates phased analysis inputs", () => {
  const base = analyzeInput.cleanBaseInput({
    brand: "小米",
    brandProduct: "小米 14",
    competitors: [{ name: "Apple", product: "iPhone 17 Pro" }],
    dimensions: ["屏幕体验"],
    other: "日常使用"
  });
  assert.equal(base.brief.brandProduct, "小米 14");
  assert.deepEqual(base.competitors, ["Apple"]);
  assert.deepEqual(base.competitorProducts, ["iPhone 17 Pro"]);
  assert.deepEqual(base.dimensions, ["屏幕体验"]);
  assert.deepEqual(
    analyzeInput.cleanAnswerInput({
      provider: "deepseek",
      questionIndex: 2,
      question: "Which product should I choose?",
      requestId: "analysis_1"
    }),
    {
      provider: "deepseek",
      questionIndex: 2,
      question: "Which product should I choose?",
      requestId: "analysis_1"
    }
  );
  assert.throws(() => analyzeInput.cleanAnswerInput({ provider: "qwen" }), /invalid_provider/);
  assert.throws(() => analyzeInput.cleanQuestions(["only one"]), /six_questions_required/);
});

test("matches product aliases instead of exact brand strings", () => {
  const dictionary = entities.buildEntityDictionary({
    brand: "比亚迪",
    brandProduct: "宋",
    competitors: [{ name: "特斯拉", product: "Model Y" }]
  });
  const mentions = entities.findEntityMentionsForDictionary(
    "宋PLUS DM-i 的续航表现不错，Model Y 的操控更强。",
    dictionary
  );
  assert.ok(mentions.some((item) => item.entityId === "brand"));
  assert.ok(mentions.some((item) => item.entityId === "competitor_1"));
  assert.ok(mentions.every((item) => item.quote.includes("续航") || item.quote.includes("Model Y")));
});

test("uses product aliases in report observations", () => {
  const report = analysis.analyzeObservations({
    brand: "比亚迪",
    brandProduct: "宋",
    competitors: ["特斯拉"],
    competitorProducts: ["Model Y"],
    questions: ["比亚迪宋和特斯拉Model Y的电池续航如何？"],
    responses: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        answers: ["宋PLUS DM-i 的电池续航较长，Model Y 也不弱。"]
      }
    ]
  });
  assert.equal(report.observations[0].mentioned, true);
  assert.ok(report.observations[0].mentionQuote.includes("续航"));
  assert.notEqual(report.observations[0].sentiment, "not_observed");
});

test("normalizes only evidence-backed report insights", () => {
  const analyzed = {
    observations: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        questionIndex: 0,
        question: "续航如何？",
        answer: "比亚迪宋的续航表现较好。",
        mentioned: true,
        rank: 1,
        sentiment: "positive",
        mentionQuote: "比亚迪宋的续航表现较好。"
      }
    ]
  };
  const normalized = insights.normalizeInsights(
    {
      positioning: {
        headline: "AI 把品牌定位成续航优先的选择",
        consensus: "两个模型都提到了续航表现。",
        differentiators: "与竞品相比补能效率被单独提及。",
        conflicts: ""
      },
      suggestions: [
        {
          title: "补充续航证据",
          detail: "围绕真实续航和补能效率补充可验证内容。",
          evidenceIds: ["answer_deepseek_0", "answer_missing_0"],
          impact: "高影响"
        },
        {
          title: "无证据建议",
          detail: "这条建议没有引用原始回答。",
          evidenceIds: []
        }
      ]
    },
    analyzed
  );
  assert.equal(normalized.status, "ok");
  assert.equal(normalized.positioning.headline, "AI 把品牌定位成续航优先的选择");
  assert.match(normalized.positioningSummary, /续航/);
  assert.equal(normalized.suggestions.length, 1);
  assert.deepEqual(normalized.suggestions[0].evidenceIds, ["answer_deepseek_0"]);
  assert.match(normalized.suggestions[0].evidence[0].quote, /续航/);
});

const positioningFixture = () => ({
  matrix: [
    { id: "brand", type: "brand", name: "林里", value: 50, mentions: 2 },
    { id: "competitor_1", type: "competitor", name: "喜茶", value: 40, mentions: 2 }
  ],
  observations: [
    {
      provider: "deepseek",
      model: "deepseek-flash",
      questionIndex: 0,
      question: "清爽场景下哪个更合适？",
      answer: "林里在清爽场景下甜度控制更克制，喜茶偏甜。",
      mentioned: true,
      rank: 1,
      sentiment: "positive",
      mentionQuote: "林里在清爽场景下甜度控制更克制。"
    }
  ],
  conflicts: [
    {
      entityId: "brand",
      entityName: "林里",
      entityType: "brand",
      questionIndex: 0,
      question: "清爽场景下哪个更合适？",
      sides: [
        {
          provider: "deepseek",
          model: "deepseek-flash",
          tone: "positive",
          quote: "林里甜度控制更克制。"
        },
        {
          provider: "glm",
          model: "glm-4.6v",
          tone: "negative",
          quote: "林里甜度偏高。"
        }
      ]
    }
  ]
});

test("drops conflict summaries that misattribute the entity or the conflict", () => {
  const normalized = insights.normalizeInsights(
    {
      positioning: { headline: "AI 认为林里主打清爽" },
      conflictSummaries: [
        // Names the wrong entity: the conflict is about 林里, not 喜茶.
        { entityId: "brand", questionIndex: 0, summary: "喜茶的甜度结论互相矛盾" },
        // Points at a conflict that does not exist.
        { entityId: "brand", questionIndex: 9, summary: "林里结论互相矛盾" }
      ],
      suggestions: []
    },
    positioningFixture()
  );
  assert.equal(normalized.positioning.conflicts.length, 1);
  assert.equal(normalized.positioning.conflicts[0].summary, "");
  assert.equal(normalized.positioning.conflicts[0].sides.length, 2);
  assert.match(normalized.positioningSummary, /林里/);
});

test("keeps a conflict summary only when it names the conflicted entity", () => {
  const normalized = insights.normalizeInsights(
    {
      positioning: { headline: "AI 认为林里主打清爽" },
      conflictSummaries: [
        { entityId: "brand", questionIndex: 0, summary: "林里的甜度结论两个模型互相矛盾" }
      ],
      suggestions: []
    },
    positioningFixture()
  );
  assert.equal(
    normalized.positioning.conflicts[0].summary,
    "林里的甜度结论两个模型互相矛盾"
  );
});

test("blanks differentiators unless the cited answers contrast brand and competitor", () => {
  const withoutAnchors = insights.normalizeInsights(
    {
      positioning: {
        headline: "AI 认为林里主打清爽",
        differentiators: "AI 认为林里比喜茶更克制"
      },
      suggestions: []
    },
    positioningFixture()
  );
  assert.equal(withoutAnchors.positioning.differentiators, "");
  assert.deepEqual(withoutAnchors.positioning.differentiatorEvidenceIds, []);

  const withAnchors = insights.normalizeInsights(
    {
      positioning: {
        headline: "AI 认为林里主打清爽",
        differentiators: "AI 认为林里比喜茶更克制",
        differentiatorEvidenceIds: ["answer_deepseek_0", "answer_missing_0"]
      },
      suggestions: []
    },
    positioningFixture()
  );
  assert.equal(withAnchors.positioning.differentiators, "AI 认为林里比喜茶更克制");
  assert.deepEqual(withAnchors.positioning.differentiatorEvidenceIds, [
    "answer_deepseek_0"
  ]);
});

test("keeps positioning fields that the critic could not verify empty", () => {
  const detectedConflict = {
    entityId: "brand",
    entityName: "Acme",
    entityType: "brand",
    questionIndex: 0,
    question: "快充表现如何？",
    sides: [
      { provider: "deepseek", model: "deepseek-flash", tone: "positive", quote: "快充很强。" },
      { provider: "glm", model: "glm-4.6v", tone: "negative", quote: "快充偏弱。" }
    ],
    summary: "Acme 的快充结论两个模型互相矛盾"
  };
  const applied = reflection.applyReflection(
    {
      positioning: {
        headline: "AI 认为产品主打续航",
        consensus: "两个模型都认可续航",
        differentiators: "与竞品相比补能更快",
        conflicts: [detectedConflict]
      },
      suggestions: []
    },
    {
      verdict: "revise",
      revised: {
        positioning: {
          headline: "AI 认为产品主打续航",
          consensus: "",
          differentiators: ""
        },
        suggestions: []
      }
    }
  );
  assert.equal(applied.positioning.headline, "AI 认为产品主打续航");
  assert.equal(applied.positioning.consensus, "两个模型都认可续航");
  assert.equal(applied.positioning.differentiators, "与竞品相比补能更快");
  assert.equal(applied.positioning.conflicts.length, 1);
  assert.equal(
    applied.positioning.conflicts[0].summary,
    "Acme 的快充结论两个模型互相矛盾"
  );
  assert.match(applied.positioningSummary, /Acme/);
});

test("disables thinking when generating report insights", async () => {
  let request = null;
  const analyzed = {
    metrics: {},
    questionStats: [],
    observations: []
  };
  const result = await insights.generateInsights(
    {
      brand: "小米",
      brandProduct: "小米 14",
      competitors: [{ name: "Apple", product: "iPhone 17 Pro" }],
      dimensions: ["产品体验"],
      other: ""
    },
    analyzed,
    {
      callChatImpl: async (options) => {
        request = options;
        return {
          message: {
            content: JSON.stringify({
              positioningSummary: "两个模型认为产品体验是主要比较点。",
              suggestions: []
            })
          }
        };
      }
    }
  );
  assert.deepEqual(request.extraBody, { thinking: { type: "disabled" } });
  assert.equal(result.status, "summary_only");
});

test("builds one focused research query per entity, capped at four", () => {
  const queries = research.buildQueries({
    brand: "小米",
    brandProduct: "小米 14",
    competitors: [
      { name: "Apple", product: "iPhone 17 Pro" },
      { name: "三星", product: "S24" }
    ],
    dimensions: ["屏幕体验"],
    other: ""
  });
  assert.equal(queries.length, 3, "one query per entity");
  assert.equal(queries[0].role, "brand");
  assert.match(queries[0].query, /小米 14/);
  assert.ok(queries.some((item) => item.query.includes("iPhone 17 Pro")));
  assert.ok(queries.some((item) => item.query.includes("S24")));
  assert.ok(queries.every((item) => item.query.includes("屏幕体验")));

  // Quota guard: a long competitor list must not blow the query budget.
  const many = research.buildQueries({
    brand: "A",
    brandProduct: "",
    competitors: [{ name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }],
    dimensions: [],
    other: ""
  });
  assert.ok(many.length <= 4);
});

test("generates questions without any network research", async () => {
  const source = await readFile(
    new URL("../api/_lib/questions.js", import.meta.url),
    "utf8"
  );
  const analyzeSource = await readFile(
    new URL("../api/analyze.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /researchBrief|evidencePayload/);
  assert.doesNotMatch(analyzeSource, /researchBrief/);
  assert.match(source, /不联网/);

  // The generator must still work when handed a research object (or none).
  const result = await questions.generateQuestions(
    {
      brand: "小米",
      brandProduct: "小米 14",
      competitors: [{ name: "Apple", product: "iPhone 17 Pro" }],
      dimensions: ["屏幕体验"],
      other: ""
    },
    undefined,
    {
      sleep: async () => {},
      callChatImpl: async ({ messages }) => {
        assert.ok(
          !/researchStatus|"evidence"/.test(messages[1].content),
          "no evidence payload may be sent to the model"
        );
        return {
          model: "deepseek-flash",
          message: {
            content: JSON.stringify({
              questions: Array.from({ length: 6 }, (_, index) => ({
                text: `小米 14 和 iPhone 17 Pro 在屏幕体验的第${index + 1}个场景谁更好？`,
                dimension: "屏幕体验"
              }))
            })
          }
        };
      }
    }
  );
  assert.equal(result.questions.length, 6);
});

test("accepts only evidence-aligned generated questions", () => {
  const brief = {
    brand: "比亚迪",
    brandProduct: "宋",
    competitors: [{ name: "特斯拉", product: "Model Y" }],
    dimensions: ["电池续航"],
    other: ""
  };
  const weak = questions.normalizeQuestions({
    questions: Array.from({ length: 6 }, () => ({
      text: "哪款产品更适合用户？",
      dimension: "",
      entities: []
    }))
  });
  assert.ok(questions.validateQuestions(weak, brief).length > 0);

  const aligned = questions.normalizeQuestions({
    questions: Array.from({ length: 6 }, (_, index) => ({
      text:
        index === 0
          ? "比亚迪宋和特斯拉Model Y在电池续航和冬季衰减上如何比较？"
          : index === 1
            ? "比亚迪宋和特斯拉Model Y哪个更适合长途通勤的电池续航？"
            : index === 2
              ? "比亚迪宋的电池续航对比特斯拉Model Y在高速场景谁更强？"
              : index === 3
                ? "比亚迪宋和特斯拉Model Y的充电效率谁更好？"
                : index === 4
                  ? "低温下比亚迪宋和特斯拉Model Y的电池续航会下降多少？"
                  : "比亚迪宋和特斯拉Model Y的电池衰减和长期使用成本如何？",
      dimension: "电池续航",
      entities: ["比亚迪宋", "特斯拉Model Y"]
    }))
  });
  assert.deepEqual(questions.validateQuestions(aligned, brief), []);

  // Every question without the brand, or with only one side, is rejected.
  const oneSided = questions.normalizeQuestions({
    questions: Array.from({ length: 6 }, () => ({
      text: "比亚迪宋的电池续航表现如何？",
      dimension: "电池续航",
      entities: ["比亚迪宋"]
    }))
  });
  const oneSidedIssues = questions.validateQuestions(oneSided, brief);
  assert.ok(
    oneSidedIssues.some((issue) => issue.startsWith("incomplete_comparison_in_")),
    `brand-only questions must be rejected: ${oneSidedIssues.join(",")}`
  );
});

test("requires every competitor to be covered by enough questions", () => {
  const brief = {
    brand: "小米",
    brandProduct: "小米 14",
    competitors: [
      { name: "苹果", product: "iPhone 17 Pro" },
      { name: "三星", product: "S24" }
    ],
    dimensions: ["电池续航"],
    other: ""
  };
  const batch = questions.normalizeQuestions({
    questions: Array.from({ length: 6 }, (_, index) => ({
      text:
        index < 4
          ? `小米 14 和 iPhone 17 Pro 在电池续航的第${index + 1}个场景谁更好？`
          : `小米 14、iPhone 17 Pro 和 S24 在电池续航的第${index + 1}个场景谁更好？`,
      dimension: "电池续航"
    }))
  });
  const issues = questions.validateQuestions(batch, brief);
  assert.ok(
    issues.some((issue) => /competitor_coverage_low:三星:2/.test(issue)),
    `under-covered competitors must be rejected: ${issues.join(",")}`
  );
});

test("retries generic questions instead of falling back to a template", async () => {
  const calls = { deepseek: 0, glm: 0 };
  const result = await questions.generateQuestions(
    {
      brand: "比亚迪",
      brandProduct: "宋",
      competitors: [{ name: "特斯拉", product: "Model Y" }],
      dimensions: ["电池续航"],
      other: ""
    },
    { status: "ok", results: [] },
    {
      sleep: async () => {},
      callChatImpl: async ({ provider }) => {
        calls[provider] += 1;
        const generic = calls[provider] === 1;
        return {
          model: provider === "glm" ? "glm-4.6v" : "deepseek-flash",
          message: {
            content: JSON.stringify({
              questions: generic
                ? Array.from({ length: 6 }, () => ({ text: "哪款产品更好？" }))
                : Array.from({ length: 6 }, (_, index) => ({
                    text: `比亚迪宋和特斯拉Model Y在电池续航的第${index + 1}个真实场景如何？`,
                    dimension: "电池续航",
                    entities: ["比亚迪宋", "特斯拉Model Y"]
                  }))
            })
          }
        };
      }
    }
  );
  assert.equal(result.attempts, 2);
  assert.match(result.questions[0].text, /比亚迪宋/);
});

const questionBrief = () => ({
  brand: "比亚迪",
  brandProduct: "宋",
  competitors: [{ name: "特斯拉", product: "Model Y" }],
  dimensions: ["电池续航"],
  other: ""
});

const validQuestionsPayload = (tag = "") =>
  JSON.stringify({
    questions: Array.from({ length: 6 }, (_, index) => ({
      text: `比亚迪宋和特斯拉Model Y在电池续航的第${index + 1}个场景${tag}如何？`,
      dimension: "电池续航",
      entities: ["比亚迪宋", "特斯拉Model Y"]
    }))
  });

test("hedges question generation across providers so one outage is survivable", async () => {
  const seen = [];
  const result = await questions.generateQuestions(questionBrief(), { status: "ok", results: [] }, {
    sleep: async () => {},
    callChatImpl: async ({ provider, timeoutMs, extraBody, messages }) => {
      seen.push({ provider, timeoutMs, extraBody, messages });
      if (provider === "deepseek") {
        const error = new Error("deepseek timed out");
        error.code = "model_timeout";
        throw error;
      }
      return { model: "glm-4.6v", message: { content: validQuestionsPayload() } };
    }
  });
  assert.equal(result.attempts, 1, "the hedge should succeed on the first attempt");
  assert.equal(result.provider, "glm");
  const isRepair = (item) =>
    /只重写不合格的那几道/.test(item.messages?.[0]?.content || "");
  assert.deepEqual(
    [...new Set(seen.filter((item) => !isRepair(item)).map((item) => item.provider))].sort(),
    ["deepseek", "glm"],
    "both providers should be raced"
  );
  // This fixture is six copies of one question, so the batch gets repaired once
  // before it is accepted.
  assert.ok(
    seen.some(isRepair),
    "a repetitive batch must be sent back for a targeted rewrite"
  );
  assert.ok(
    seen.every((item) => item.timeoutMs <= questions.ATTEMPT_TIMEOUT_MS),
    "every attempt must respect the per-attempt timeout"
  );
  assert.ok(
    seen.every(
      (item) => item.extraBody?.thinking?.type === "disabled"
    ),
    "thinking must be disabled so the call stays fast"
  );
});

test("falls back to the second provider when the first keeps failing", async () => {
  const attempts = [];
  const result = await questions.generateQuestions(questionBrief(), { status: "ok", results: [] }, {
    sleep: async () => {},
    callChatImpl: async ({ provider }) => {
      attempts.push(provider);
      if (provider === "deepseek") {
        const error = new Error("rate limited");
        error.status = 429;
        throw error;
      }
      return { model: "glm-4.6v", message: { content: validQuestionsPayload() } };
    }
  });
  assert.equal(result.provider, "glm");
  assert.ok(attempts.includes("deepseek") && attempts.includes("glm"));
});

test("backs off on retryable failures but not on validation failures", async () => {
  const sleeps = [];
  try {
    await questions.generateQuestions(questionBrief(), { status: "ok", results: [] }, {
      sleep: async (ms) => sleeps.push(ms),
      random: () => 0.5,
      callChatImpl: async () => {
        const error = new Error("upstream busy");
        error.status = 503;
        throw error;
      }
    });
  } catch {
    // All attempts are expected to fail here.
  }
  assert.ok(sleeps.length >= 1, "retryable failures must back off");
  assert.ok(
    sleeps.every((ms) => ms >= 1000 && ms <= 5500),
    `backoff should stay in a sane range, got ${sleeps.join(",")}`
  );

  const validationSleeps = [];
  try {
    await questions.generateQuestions(questionBrief(), { status: "ok", results: [] }, {
      sleep: async (ms) => validationSleeps.push(ms),
      callChatImpl: async () => ({
        model: "deepseek-flash",
        message: {
          content: JSON.stringify({
            questions: Array.from({ length: 6 }, () => ({ text: "哪款更好？" }))
          })
        }
      })
    });
  } catch {
    // Expected: generic questions never validate.
  }
  assert.deepEqual(
    validationSleeps,
    [],
    "validation failures should repair the prompt immediately, not sleep"
  );
});

test("stops before exhausting the function's time budget", async () => {
  let clock = 0;
  let calls = 0;
  await assert.rejects(
    questions.generateQuestions(questionBrief(), { status: "ok", results: [] }, {
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      totalBudgetMs: 20000,
      callChatImpl: async () => {
        calls += 1;
        clock += 9000;
        const error = new Error("timed out");
        error.code = "model_timeout";
        throw error;
      }
    }),
    (error) => error.code === "question_generation_failed"
  );
  assert.ok(
    calls <= 4,
    `the generator must not keep calling past its budget, made ${calls} calls`
  );
});

test("rewrites only the invalid questions instead of the whole batch", async () => {
  const prompts = [];
  const result = await questions.generateQuestions(questionBrief(), { status: "ok", results: [] }, {
    sleep: async () => {},
    callChatImpl: async ({ messages }) => {
      prompts.push(messages[1].content);
      const isRepair = /rewriteIndexes/.test(messages[1].content);
      if (isRepair) {
        return {
          model: "glm-4.6v",
          message: {
            content: JSON.stringify({
              questions: [
                { index: 1, text: "比亚迪宋和特斯拉Model Y在电池续航的补能速度上如何？" },
                { index: 4, text: "比亚迪宋和特斯拉Model Y在电池续航的冬季表现如何？" }
              ]
            })
          }
        };
      }
      return {
        model: "deepseek-flash",
        message: {
          content: JSON.stringify({
            questions: Array.from({ length: 6 }, (_, index) =>
              index === 1 || index === 4
                ? { text: "这两款哪个更值得买？" }
                : {
                    text: `比亚迪宋和特斯拉Model Y在电池续航的第${index + 1}个场景如何？`,
                    dimension: "电池续航"
                  }
            )
          })
        }
      };
    }
  });
  assert.equal(result.attempts, 1, "a targeted repair should finish inside one attempt");
  assert.ok(
    prompts.some((prompt) => /rewriteIndexes/.test(prompt)),
    "the repair prompt should only ask for the failing questions"
  );
  const repairPrompt = prompts.find((prompt) => /rewriteIndexes/.test(prompt));
  assert.match(repairPrompt, /"rewriteIndexes":\[1,4\]/);
  assert.match(result.questions[1].text, /比亚迪宋/);
  assert.match(result.questions[4].text, /比亚迪宋/);
  assert.match(result.questions[0].text, /第1个场景/);
});

test("health really probes each model and reports latency", async () => {
  const health = require("../api/health.js");
  const previous = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    glm: process.env.GLM_API_KEY
  };
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.GLM_API_KEY = "test-key";
  const calls = [];
  let result;
  try {
    result = await health.probeModels({
      callChatImpl: async ({ provider, timeoutMs, extraBody, maxTokens }) => {
        calls.push(provider);
        assert.ok(timeoutMs <= 12000, "probes must use a short timeout");
        assert.ok(maxTokens <= 16, "probes must stay tiny");
        assert.equal(extraBody.thinking.type, "disabled");
        return {
          model: provider === "glm" ? "glm-4.6v" : "deepseek-flash",
          finishReason: "stop",
          message: { content: "可用" }
        };
      }
    });
  } finally {
    if (previous.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.deepseek;
    if (previous.glm === undefined) delete process.env.GLM_API_KEY;
    else process.env.GLM_API_KEY = previous.glm;
  }
  assert.deepEqual(calls.sort(), ["deepseek", "glm"]);
  assert.equal(result.healthy, true);
  assert.equal(result.models.deepseek.ok, true);
  assert.equal(result.models.deepseek.model, "deepseek-flash");
  assert.equal(typeof result.models.deepseek.latencyMs, "number");
  assert.match(result.summary, /DeepSeek Flash ✓/);
  assert.match(result.summary, /GLM 4\.6v ✓/);
});

test("health reports a failing model without failing the endpoint", async () => {
  const health = require("../api/health.js");
  const previous = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    glm: process.env.GLM_API_KEY
  };
  const previousFetch = global.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.GLM_API_KEY = "test-key";
  global.fetch = async (url) => {
    if (/bigmodel/i.test(String(url))) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "rate limited" } })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "可用" } }]
      })
    };
  };
  const res = {
    statusCode: 0,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    }
  };
  try {
    await health(
      { url: "/api/health", query: {} },
      res
    );
  } finally {
    global.fetch = previousFetch;
    if (previous.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.deepseek;
    if (previous.glm === undefined) delete process.env.GLM_API_KEY;
    else process.env.GLM_API_KEY = previous.glm;
  }
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.probed, true);
  assert.equal(res.payload.healthy, false, "a failing model must not report healthy");
  assert.equal(res.payload.models.deepseek.ok, true);
  assert.equal(res.payload.models.glm.ok, false);
  assert.equal(res.payload.models.glm.status, 429);
  assert.match(res.payload.summary, /DeepSeek Flash ✓/);
  assert.match(res.payload.summary, /GLM 4\.6v ✗/);
});

test("search probe tells us which keyless sources work", async () => {
  const probe = require("../api/search-probe.js");
  const ddgSource = probe.SOURCES.find((item) => item.key === "duckduckgo_html");
  const wikiSource = probe.SOURCES.find((item) => item.key === "wikipedia_zh");

  const ddgHtml =
    '<a class="result__a" href="https://a">喜茶新品一</a>' +
    '<a class="result__a" href="https://b">喜茶新品二</a>';
  const ddg = await probe.fetchSource(ddgSource, "喜茶", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => ddgHtml })
  });
  assert.equal(ddg.ok, true);
  assert.equal(ddg.resultCount, 2);
  assert.deepEqual(ddg.samples, ["喜茶新品一", "喜茶新品二"]);
  assert.ok(Number.isFinite(ddg.latencyMs));

  const wiki = await probe.fetchSource(wikiSource, "喜茶", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ query: { search: [{ title: "喜茶" }] } })
    })
  });
  assert.equal(wiki.resultCount, 1);
  assert.deepEqual(wiki.samples, ["喜茶"]);

  // A page that parses to nothing must not be reported as working.
  const blocked = await probe.fetchSource(ddgSource, "喜茶", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>captcha</html>" })
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.resultCount, 0);

  const failed = await probe.fetchSource(ddgSource, "喜茶", {
    fetchImpl: async () => {
      throw new Error("connection reset");
    }
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /connection reset/);
});

test("the search parser tolerates both quoting styles and markup changes", async () => {
  const probe = require("../api/search-probe.js");
  const bing = probe.SOURCES.find((item) => item.key === "bing_html");
  const doubleQuoted = '<h2><a href="https://a.example/x">标题一</a></h2>';
  const singleQuoted =
    "<h2 class='b'><a class='t' target='_blank' href='https://b.example/y'>标题二</a></h2>";
  const rewritten =
    '<div><h2 data-x="1"><span><a rel="x" href="https://c.example/z">标题三</a></span></h2></div>';

  assert.equal(bing.parse(doubleQuoted), 1);
  assert.equal(bing.parse(singleQuoted), 1);
  assert.equal(bing.parse(rewritten), 1);
  assert.deepEqual(bing.samples(singleQuoted), ["标题二"]);

  // If the heading structure disappears entirely, fall back to bare links so a
  // markup change degrades instead of returning nothing.
  const noHeadings = '<ul><li><a href="https://d.example/w">标题四</a></li></ul>';
  assert.equal(bing.parse(noHeadings), 1);

  // The engine's own links are never treated as results.
  const selfLinks = '<a href="https://www.bing.com/account">登录</a>';
  assert.equal(bing.parse(selfLinks), 0);
});

test("search probe reports a hang as a timeout instead of stalling", async () => {
  const probe = require("../api/search-probe.js");
  const hanging = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  const source = probe.SOURCES[0];
  const result = await probe.fetchSource(source, "喜茶", {
    fetchImpl: hanging,
    timeoutMs: 20
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 20ms/);
});

test("search probe summarises which sources are usable", async () => {
  const probe = require("../api/search-probe.js");
  const results = await probe.probeSources("喜茶", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '<a class="result__a">一</a><a class="result__a">二</a>'
    }),
    searchImpl: {
      key: "searxng_ecs",
      label: "SearXNG (ECS 对照组)",
      ok: false,
      status: "empty",
      resultCount: 0,
      latencyMs: 5
    }
  });
  assert.equal(results.length, probe.SOURCES.length + 1);
  assert.ok(results.every((item) => typeof item.ok === "boolean"));
  assert.ok(results.some((item) => item.key === "searxng_ecs"));
});

test("health probes the search gateway, not just the variable", async () => {
  const health = require("../api/health.js");
  const previousBase = process.env.SEARXNG_BASE_URL;
  let withGateway;
  let withoutGateway;
  let called;
  try {
    delete process.env.SEARXNG_BASE_URL;
    called = 0;
    withoutGateway = await health.probeSearch({
      searchImpl: async () => {
        called += 1;
        return { status: "ok", results: [] };
      }
    });

    process.env.SEARXNG_BASE_URL = "https://search.example";
    withGateway = await health.probeSearch({
      searchImpl: async () => ({
        status: "ok",
        query: "probe",
        results: [{ url: "https://example.com" }]
      })
    });
  } finally {
    if (previousBase === undefined) delete process.env.SEARXNG_BASE_URL;
    else process.env.SEARXNG_BASE_URL = previousBase;
  }
  assert.equal(withoutGateway.configured, false);
  assert.equal(withoutGateway.status, "not_configured");
  assert.equal(called, 0, "an unconfigured gateway must not be called");
  assert.equal(withGateway.configured, true);
  assert.equal(withGateway.ok, true);
  assert.equal(withGateway.resultCount, 1);
  assert.ok(Number.isFinite(withGateway.latencyMs));
});

test("a hanging search times out instead of stalling the request", async () => {
  const hangingFetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  await assert.rejects(
    research.searchQuery(
      { query: "test", entity: "", role: "web" },
      { env: { SEARXNG_BASE_URL: "https://search.example" }, fetchImpl: hangingFetch, timeoutMs: 20 }
    ),
    (error) => error.code === "search_timeout"
  );

  const outcome = await research.searchWeb("test", {
    env: { SEARXNG_BASE_URL: "https://search.example" },
    fetchImpl: hangingFetch,
    timeoutMs: 20
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "search_timeout");
});

test("health can skip probing so the endpoint stays free", async () => {
  const health = require("../api/health.js");
  const previous = { deepseek: process.env.DEEPSEEK_API_KEY };
  const previousFetch = global.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("probe=0 must not call any model");
  };
  const res = {
    statusCode: 0,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    }
  };
  try {
    await health({ url: "/api/health?probe=0", query: { probe: "0" } }, res);
  } finally {
    global.fetch = previousFetch;
    if (previous.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.deepseek;
  }
  assert.equal(fetchCalls, 0);
  assert.equal(res.payload.probed, false);
  assert.equal(res.payload.healthy, null);
  assert.equal(res.payload.models.deepseek.configured, true);
});

test("marks research as unconfigured when SearXNG is absent", async () => {
  const result = await research.researchBrief(
    {
      brand: "小米",
      brandProduct: "小米 14",
      competitors: [],
      dimensions: ["屏幕体验"],
      other: ""
    },
    { env: {} }
  );
  assert.equal(result.status, "not_configured");
  assert.deepEqual(result.results, []);
});

test("uses a keyed search API when one is configured", async () => {
  const seen = [];
  const result = await research.searchQuery(
    { query: "喜茶 新品", entity: "喜茶", role: "brand" },
    {
      env: { SEARCH_PROVIDER: "serper", SEARCH_API_KEY: "secret-key" },
      fetchImpl: async (url, options = {}) => {
        seen.push({ url: String(url), headers: options.headers, body: options.body });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            organic: [
              {
                title: "喜茶新品发布",
                link: "https://example.com/news",
                snippet: "喜茶推出新口味"
              }
            ]
          })
        };
      }
    }
  );
  assert.equal(result.status, "ok");
  assert.equal(result.provider, "serper");
  assert.equal(result.results[0].url, "https://example.com/news");
  assert.equal(result.results[0].title, "喜茶新品发布");
  assert.equal(seen[0].headers["X-API-KEY"], "secret-key");
  assert.equal(JSON.parse(seen[0].body).q, "喜茶 新品");
  assert.equal(JSON.parse(seen[0].body).hl, "zh-cn");
});

test("falls back to the self-hosted gateway when the API fails", async () => {
  const result = await research.searchQuery(
    { query: "喜茶", entity: "喜茶", role: "brand" },
    {
      env: {
        SEARCH_PROVIDER: "serper",
        SEARCH_API_KEY: "secret-key",
        SEARXNG_BASE_URL: "https://search.example"
      },
      fetchImpl: async (url) => {
        if (String(url).includes("serper.dev")) {
          return { ok: false, status: 429, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              { title: "backup", url: "https://backup.example/a", content: "x" }
            ]
          })
        };
      }
    }
  );
  assert.equal(result.provider, "searxng");
  assert.equal(result.fallbackFrom, "serper");
  assert.match(result.fallbackError, /429/);
  assert.equal(result.results[0].url, "https://backup.example/a");
});

test("surfaces the API error when there is no gateway to fall back to", async () => {
  await assert.rejects(
    research.searchQuery(
      { query: "喜茶", entity: "喜茶", role: "brand" },
      {
        env: { SEARCH_PROVIDER: "serper", SEARCH_API_KEY: "secret-key" },
        fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
      }
    ),
    (error) => error.status === 401
  );
});

test("does not cache a failed research lookup", async () => {
  const brief = {
    brand: "缓存品牌",
    brandProduct: "",
    competitors: [],
    dimensions: ["体验"],
    other: ""
  };
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const first = await research.researchBrief(brief, {
    env: { SEARXNG_BASE_URL: "https://search.example" },
    fetchImpl: failing
  });
  const second = await research.researchBrief(brief, {
    env: { SEARXNG_BASE_URL: "https://search.example" },
    fetchImpl: failing
  });
  // A gateway error degrades to "empty" rather than throwing...
  assert.equal(first.status, "empty");
  // ...and must be retried next time instead of being served from cache.
  assert.equal(second.cached, undefined);
  assert.equal(calls, 2, "a failure must not be served from cache");
});

test("collects deduplicated evidence from SearXNG", async () => {
  const seen = [];
  const result = await research.researchBrief(
    {
      brand: "小米",
      brandProduct: "小米 14",
      competitors: [],
      dimensions: ["屏幕体验"],
      other: ""
    },
    {
      env: { SEARXNG_BASE_URL: "https://search.example" },
      fetchImpl: async (url) => {
        seen.push(String(url));
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                title: "小米 14 官方规格",
                url: "https://example.com/xiaomi-14",
                content: "官方规格页面",
                engine: "test"
              }
            ]
          })
        };
      }
    }
  );
  assert.equal(result.status, "ok");
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].url, /xiaomi-14/);
  assert.ok(seen.every((url) => url.includes("format=json")));
});

test("reflection marks unsupported report claims for revision", async () => {
  const result = await reflection.reflectInsights(
    {
      brand: "小米",
      brandProduct: "小米 14",
      competitors: [],
      dimensions: ["屏幕体验"],
      other: ""
    },
    {
      metrics: { mentionRate: 50 },
      questionStats: [],
      observations: []
    },
    {
      positioning: { headline: "无证据结论", consensus: "", differentiators: "", conflicts: "" },
      suggestions: [{ title: "无证据建议", detail: "增加不存在的内容" }]
    },
    {
      callChatImpl: async () => ({
        message: {
          content: JSON.stringify({
            verdict: "revise",
            issues: [
              {
                type: "unsupported_claim",
                message: "该结论没有原始回答支持",
                evidenceId: "none"
              }
            ],
            revised: { positioning: [], suggestions: [] }
          })
        }
      })
    }
  );
  assert.equal(result.status, "checked");
  assert.equal(result.verdict, "revise");
  assert.equal(result.issues[0].type, "unsupported_claim");
  const applied = reflection.applyReflection(
    {
      positioningSummary: "无证据原结论",
      suggestions: [{ title: "无证据", detail: "原建议" }]
    },
    result
  );
  assert.equal(applied.positioningSummary, "无证据原结论");
  assert.equal(applied.suggestions.length, 1);
  const preserved = reflection.applyReflection(
    {
      positioningSummary: "保留原始定位总结",
      suggestions: [{ title: "建议", analysis: "分析", suggestion: "行动" }]
    },
    {
      verdict: "revise",
      revised: { positioningSummary: "", suggestions: [] }
    }
  );
  assert.equal(preserved.positioningSummary, "保留原始定位总结");
  assert.equal(preserved.suggestions.length, 1);
});

test("builds safe model error details for server logs", () => {
  const details = model.errorDetails({
    code: "provider_error",
    status: 400,
    provider: "deepseek",
    model: "deepseek-flash",
    message: " model rejected the request "
  });
  assert.deepEqual(details, {
    code: "provider_error",
    status: 400,
    provider: "deepseek",
    model: "deepseek-flash",
    message: "model rejected the request"
  });
  assert.ok(!Object.hasOwn(details, "apiKey"));
});

test("keeps analysis failures observable in server logs", async () => {
  const source = await readFile(
    new URL("../api/analyze.js", import.meta.url),
    "utf8"
  );
  const inputSource = await readFile(
    new URL("../api/_lib/analyze-input.js", import.meta.url),
    "utf8"
  );
  assert.match(source, /event:\s*"analysis_failed"/);
  assert.match(source, /errorDetails\(error\)/);
  assert.match(source, /phase === "answer"/);
  assert.match(source, /analysis_answer_completed/);
  assert.match(source, /answer_generation_failed/);
  assert.match(source, /analysis_answer_failed/);
  assert.match(source, /finishReason/);
  assert.match(source, /timeoutMs: 25000/);
  assert.match(inputSource, /TESTED_PROVIDERS = \["deepseek", "glm"\]/);
  assert.doesNotMatch(source, /provider:\s*"qwen"/i);
});

test("keeps image extraction failures observable without exposing secrets", async () => {
  const source = await readFile(
    new URL("../api/extract-image.js", import.meta.url),
    "utf8"
  );
  assert.match(source, /event:\s*"image_extraction_failed"/);
  assert.match(source, /errorDetails\(error\)/);
  assert.match(source, /provider:\s*"glm"/);
  assert.doesNotMatch(source, /provider:\s*"qwen"/i);
  assert.doesNotMatch(source, /console\.(?:error|log)\([^)]*apiKey/i);
});

// --- itemised judging (llm-as-a-judge, rubric items instead of a total score) ---

test("derives every dimension from yes/no items instead of a holistic score", () => {
  // 推荐出现: 提及 1 + 评价 1 + 列入推荐 1 + 被列为首选 1 = 4 → 100
  assert.equal(
    judge.presenceValue({
      mentioned: true,
      evaluated: true,
      recommended: true,
      firstChoice: true
    }),
    100
  );
  // 只是被列入推荐（没有排第一）不再等于满分。
  assert.equal(judge.presenceValue({ mentioned: true, evaluated: true, recommended: true }), 75);
  assert.equal(judge.presenceValue({ mentioned: true }), 25);
  assert.equal(judge.presenceValue({ mentioned: true, evaluated: true }), 50);
  // 被否定会从正分里扣掉，并且不会低于 0。
  assert.equal(judge.presenceValue({ mentioned: true, evaluated: true, rejected: true }), 0);
  assert.equal(judge.presenceValue({}), 0);

  assert.equal(judge.rankValue(1), 100);
  assert.equal(judge.rankValue(2), 75);
  assert.equal(judge.rankValue(3), 50);
  assert.equal(judge.rankValue(4), 25);
  assert.equal(judge.rankValue(7), 25);
  assert.equal(judge.rankValue(null), null);
  assert.equal(judge.rankValue(0), null);

  assert.equal(judge.sentimentValue("positive"), 100);
  assert.equal(judge.sentimentValue("neutral"), 60);
  assert.equal(judge.sentimentValue("mixed"), 40);
  assert.equal(judge.sentimentValue("negative"), 20);
  assert.equal(judge.sentimentValue("unknown"), null);

  assert.equal(
    judge.evidenceValue([
      { kind: "specific" },
      { kind: "specific" },
      { kind: "vague" }
    ]),
    67
  );
  // 只有主观推荐、没有事实主张时，这个维度没有可判定的依据。
  assert.equal(judge.evidenceValue([]), null);
  assert.equal(judge.evidenceValue([{ kind: "opinion" }]), null);

  assert.equal(
    judge.differentiationValue({ compared: false, difference: false, condition: false }),
    0
  );
  assert.equal(
    judge.differentiationValue({ compared: true, difference: true, condition: false }),
    67
  );
  assert.equal(
    judge.differentiationValue({ compared: true, difference: true, condition: true }),
    100
  );
});

test("renormalises the weights when a dimension cannot be judged", () => {
  const dimensions = { presence: 100, rank: 0, sentiment: 100, evidence: 0, differentiation: 100 };
  // Everything is judgeable → the documented weights apply.
  assert.equal(
    judge.weightedJudgedScore(dimensions, {
      presence: true,
      rank: true,
      sentiment: true,
      evidence: true,
      differentiation: true
    }),
    55
  );
  // 顺位无法判定（回答没有排序）时，分母只剩 75% 的权重，不能被当成 0 分拖低。
  assert.equal(
    judge.weightedJudgedScore(dimensions, {
      presence: true,
      rank: false,
      sentiment: true,
      evidence: false,
      differentiation: true
    }),
    100
  );
  // 同一个 50 分，在“全部可判定”和“只剩证据维度”两种情况下的结果不同。
  const partial = { presence: 100, rank: 0, sentiment: 0, evidence: 50, differentiation: 0 };
  assert.equal(
    judge.weightedJudgedScore(partial, {
      presence: true,
      rank: true,
      sentiment: true,
      evidence: true,
      differentiation: true
    }),
    35
  );
  assert.equal(
    judge.weightedJudgedScore(partial, { evidence: true }),
    50
  );
});

test("normalises a raw judge verdict and refuses to trust its free text", () => {
  const answer = "如果只看清爽度，我会先推喜茶，林里的甜度偏高。";
  const entities = [
    { id: "brand", type: "brand", name: "喜茶" },
    { id: "competitor_1", type: "competitor", name: "林里" }
  ];
  const normalized = judge.normalizeJudgment(
    {
      entities: {
        brand: {
          presence: {
            mentioned: true,
            evaluated: true,
            recommended: true,
            firstChoice: true,
            rejected: false
          },
          rank: 1,
          tone: "positive",
          claims: [
            { text: "喜茶的清爽度更好", kind: "vague" },
            { text: "喜茶单杯 16 元", kind: "specific" }
          ],
          differentiation: { compared: true, difference: true, condition: true },
          quote: "我会先推喜茶",
          reasons: {
            presence: "回答直接推荐了喜茶。",
            rank: "回答说“先推喜茶”，是第一名。",
            sentiment: "整体是正面推荐。",
            evidence: "两条主张里一条带具体价格。",
            differentiation: "与林里做了甜度对比并给出场景。"
          }
        },
        competitor_1: {
          presence: { mentioned: true },
          rank: null,
          tone: "negative",
          claims: [],
          differentiation: { compared: true },
          quote: "这句话根本不在回答里"
        }
      }
    },
    { answer, entities }
  );

  const brand = normalized.entities.brand;
  assert.equal(brand.dimensions.presence, 100);
  assert.equal(brand.dimensions.rank, 100);
  assert.equal(brand.dimensions.sentiment, 100);
  assert.equal(brand.dimensions.evidence, 50);
  assert.equal(brand.dimensions.differentiation, 100);
  assert.equal(brand.score, 90);
  assert.match(brand.reasons.rank, /先推喜茶/);
  assert.equal(brand.claims.length, 2);

  const competitor = normalized.entities.competitor_1;
  // 没有排序 → 该维度不参与加权；没有事实主张 → 证据维度不参与。
  assert.equal(competitor.applicable.rank, false);
  assert.equal(competitor.applicable.evidence, false);
  assert.equal(competitor.dimensions.rank, 0);
  // 引文不在回答原文里 → 直接丢掉，不给用户看没有出处的“原文”。
  assert.equal(competitor.quote, "");
  assert.equal(normalized.source, "model");
});

test("treats an unmentioned entity as zero instead of guessing", () => {
  const normalized = judge.normalizeJudgment(
    {
      entities: {
        brand: {
          presence: { mentioned: false },
          rank: 3,
          tone: "positive",
          claims: [{ text: "没有提到也应该有证据", kind: "specific" }],
          differentiation: { compared: true, difference: true, condition: true },
          quote: ""
        }
      }
    },
    { answer: "这道题只聊了竞品。", entities: [{ id: "brand", type: "brand", name: "喜茶" }] }
  );
  const brand = normalized.entities.brand;
  assert.equal(brand.mentioned, false);
  assert.deepEqual(brand.dimensions, {
    presence: 0,
    rank: 0,
    sentiment: 0,
    evidence: 0,
    differentiation: 0
  });
  assert.equal(brand.score, 0);
});

test("rejects a judge verdict that carries no entities", () => {
  assert.throws(
    () => judge.normalizeJudgment({ entities: {} }, { answer: "x", entities: [{ id: "brand" }] }),
    /no entities/
  );
});

test("asks the judge for itemised verdicts in JSON at temperature zero", async () => {
  let request = null;
  const result = await judge.judgeAnswer({
    question: "喜茶和林里哪个更清爽？",
    answer: "如果只看清爽度，我会先推喜茶。",
    entities: [
      { id: "brand", type: "brand", name: "喜茶" },
      { id: "competitor_1", type: "competitor", name: "林里" }
    ],
    callChatImpl: async (options) => {
      request = options;
      return {
        model: "deepseek-flash",
        message: {
          content: JSON.stringify({
            entities: {
              brand: {
                presence: {
                  mentioned: true,
                  evaluated: true,
                  recommended: true,
                  firstChoice: true
                },
                rank: 1,
                tone: "positive",
                claims: [],
                differentiation: { compared: true },
                quote: "我会先推喜茶",
                reasons: {}
              }
            }
          })
        }
      };
    }
  });

  assert.equal(request.provider, "deepseek");
  assert.equal(request.role, "judge");
  assert.equal(request.temperature, 0);
  assert.deepEqual(request.responseFormat, { type: "json_object" });
  assert.match(request.messages[0].content, /presence\.mentioned/);
  assert.match(request.messages[0].content, /differentiation\.condition/);
  assert.match(request.messages[1].content, /喜茶和林里哪个更清爽/);
  assert.equal(result.model, "deepseek-flash");
  // 原始判定会被浏览器带回去，报告阶段再重新归一化。
  assert.ok(result.raw.entities.brand);
  // 100/100/100 的加权，加只命中一项的竞品差异（33），证据维度不参与。
  assert.equal(result.judgment.entities.brand.score, 87);
  assert.equal(result.judgment.entities.brand.applicable.evidence, false);
});

test("the judge prompt tells the model to admit when there is no ranking", () => {
  const prompt = judge.judgeSystemPrompt();
  assert.match(prompt, /没有先后顺序时必须填 null/);
  assert.match(prompt, /只输出 JSON/);
  assert.match(prompt, /必须与回答原文一致/);
});

test("scores a report from itemised verdicts and keeps the rule fallback", () => {
  const questions = ["喜茶和林里哪个更清爽？", "喜茶适合什么场景？"];
  const responses = [
    {
      provider: "deepseek",
      model: "deepseek-flash",
      answers: ["只看清爽度我会先推喜茶，林里甜度偏高。", "办公室下午茶可以选喜茶。"]
    },
    {
      provider: "glm",
      model: "glm-4.6v",
      answers: ["两家都不错，我更喜欢喜茶。", "喜茶适合办公室场景。"]
    }
  ];
  const verdict = (options) => ({
    entities: {
      brand: {
        presence: {
          mentioned: true,
          evaluated: true,
          recommended: true,
          firstChoice: true
        },
        rank: 1,
        tone: "positive",
        claims: [
          { text: "喜茶清爽度更好", kind: "vague" },
          { text: "喜茶单杯 16 元", kind: "specific" }
        ],
        differentiation: { compared: true, difference: true, condition: false },
        quote: "我会先推喜茶",
        reasons: {
          presence: "回答直接推荐了喜茶。",
          rank: "喜茶被排在第一位。",
          sentiment: "整体正面。",
          evidence: "包含价格等具体细节。",
          differentiation: "与林里做了甜度对比。"
        },
        ...options
      }
    }
  });
  const judged = analysis.analyzeObservations({
    brand: "喜茶",
    competitors: ["林里"],
    questions,
    responses,
    judgments: {
      "deepseek:0": verdict({}),
      // 规则判定兜底：这一条故意没有判定结果。
      "deepseek:1": null
    }
  });

  const first = judged.observations.find(
    (item) => item.provider === "deepseek" && item.questionIndex === 0
  );
  assert.equal(first.judged, true);
  // 100 + 100 + 100 + 50 + 67（比较+差异，缺选择条件），证据维度可判定 → 按权重算。
  assert.equal(first.entityScores.brand.dimensions.presence, 100);
  assert.equal(first.entityScores.brand.dimensions.rank, 100);
  assert.equal(first.entityScores.brand.dimensions.evidence, 50);
  // 100/100/100 的加权，加 50 的证据、67 的竞品差异 → 85。
  assert.equal(first.entityScores.brand.dimensions.score, 85);
  assert.equal(first.judgments.brand.reasons.rank, "喜茶被排在第一位。");
  assert.equal(first.judgments.brand.quote, "我会先推喜茶");

  // 没有判定的那条走规则判定，并且会被标记出来。
  const second = judged.observations.find(
    (item) => item.provider === "deepseek" && item.questionIndex === 1
  );
  assert.equal(second.judged, false);
  assert.deepEqual(second.judgments, {});

  // 规则判定仍然给竞品算分（别名匹配），judge 只覆盖它被判定的那部分。
  const glmFirst = judged.observations.find(
    (item) => item.provider === "glm" && item.questionIndex === 0
  );
  assert.equal(glmFirst.judged, false);
  assert.equal(glmFirst.entityScores.brand.mentioned, true);
});

test("a dimension the judge could not decide is excluded from the average", () => {
  const questions = ["喜茶和林里哪个更清爽？"];
  const responses = [
    { provider: "deepseek", model: "deepseek-flash", answers: ["只看清爽度我会先推喜茶。"] },
    { provider: "glm", model: "glm-4.6v", answers: ["两家都不错。"] }
  ];
  const judged = analysis.analyzeObservations({
    brand: "喜茶",
    competitors: ["林里"],
    questions,
    responses,
    judgments: {
      // 这条回答没有给出排序，也没有事实主张 → 两个维度不参与。
      "deepseek:0": {
        entities: {
          brand: {
            presence: { mentioned: true, evaluated: true },
            rank: null,
            tone: "positive",
            claims: [],
            differentiation: { compared: false, difference: false, condition: false },
            quote: "我会先推喜茶",
            reasons: { presence: "提到了喜茶并给出评价。" }
          }
        }
      }
    }
  });
  const judgedAnswer = judged.observations.find((item) => item.provider === "deepseek");
  assert.equal(judgedAnswer.entityScores.brand.applicableDimensions.rank, false);
  assert.equal(judgedAnswer.entityScores.brand.applicableDimensions.evidence, false);
  // 顺位与证据不参与加权 → 只剩 25%+15%+15% 的权重。
  assert.equal(judgedAnswer.entityScores.brand.dimensions.score, 50);

  // 题目层仍然给出一份品牌维度的汇总，供“得分明细”表格使用。
  assert.ok(judged.questionStats[0].dimensions);
  assert.equal(typeof judged.questionStats[0].dimensions.rank, "number");
  // 竞品这一题没有判定数据，继续走规则判定。
  assert.equal(judged.questionStats[0].entityScores.competitor_1.applicable, true);
  assert.equal(judged.questionStats[0].entityScores.competitor_1.asked, true);
  // 回答里没提到竞品 → 记 0 分（真实的“没被推荐”信号），而不是从平均里剔除。
  assert.equal(judged.questionStats[0].entityScores.competitor_1.mentioned, false);
  assert.equal(judged.questionStats[0].entityScores.competitor_1.score, 0);
});

test("the report phase re-derives judged numbers and rejects unusable verdicts", () => {
  const handler = require("../api/analyze.js");
  const questions = ["喜茶和林里哪个更清爽？"];
  const responses = [
    { provider: "deepseek", model: "deepseek-flash", answers: ["只看清爽度我会先推喜茶。"] },
    { provider: "glm", model: "glm-4.6v", answers: ["两家都不错。"] }
  ];
  const brief = {
    brand: "喜茶",
    brandProduct: "",
    competitors: [{ name: "林里", product: "" }],
    dimensions: [],
    other: ""
  };
  const normalized = handler.normalizeJudgments(
    {
      "deepseek:0": {
        entities: {
          brand: {
            presence: {
              mentioned: true,
              evaluated: true,
              recommended: true,
              firstChoice: true
            },
            rank: 1,
            tone: "positive",
            claims: [],
            differentiation: { compared: false, difference: false, condition: false },
            quote: "我会先推喜茶",
            // 就算浏览器把分数塞进来，也不会被采用。
            dimensions: { presence: 0, rank: 0, sentiment: 0, evidence: 0, differentiation: 0 },
            score: 0
          }
        }
      },
      "glm:0": { entities: {} },
      "not-a-provider:0": { entities: { brand: { presence: { mentioned: true } } } }
    },
    { questions, responses, brief, requestId: "req_1" }
  );
  assert.deepEqual(Object.keys(normalized), ["deepseek:0"]);
  const brand = normalized["deepseek:0"].entities.brand;
  assert.equal(brand.dimensions.presence, 100);
  assert.equal(brand.dimensions.rank, 100);
  assert.notEqual(brand.score, 0);

  assert.deepEqual(handler.judgedSummary({ observations: [{ judged: true }, { judged: false }] }), {
    judgedAnswers: 1,
    ruleAnswers: 1,
    totalAnswers: 2
  });
});

test("the judge phase answers with the raw verdict and degrades instead of failing", async () => {
  const handler = require("../api/analyze.js");
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousFetch = global.fetch;
  const logs = [];
  const previousLog = console.log;
  process.env.DEEPSEEK_API_KEY = "test-key";
  const baseBody = {
    phase: "judge",
    requestId: "req_judge",
    provider: "deepseek",
    questionIndex: 0,
    question: "喜茶和林里哪个更清爽？",
    answer: "只看清爽度我会先推喜茶。",
    brief: { brand: "喜茶", competitors: [{ name: "林里" }] }
  };
  const makeRes = () => ({
    statusCode: 0,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    }
  });
  console.log = (line) => logs.push(String(line));
  let ok;
  let failed;
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "deepseek-flash",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                entities: {
                  brand: {
                    presence: { mentioned: true, evaluated: true, recommended: true },
                    rank: 1,
                    tone: "positive",
                    claims: [],
                    differentiation: { compared: false },
                    quote: "我会先推喜茶",
                    reasons: {}
                  }
                }
              })
            }
          }
        ]
      })
    });
    ok = makeRes();
    await handler({ method: "POST", body: baseBody }, ok);

    global.fetch = async () => {
      throw new Error("network down");
    };
    failed = makeRes();
    await handler({ method: "POST", body: baseBody }, failed);
  } finally {
    global.fetch = previousFetch;
    console.log = previousLog;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }

  assert.equal(ok.statusCode, 200);
  assert.equal(ok.payload.phase, "judge");
  assert.equal(ok.payload.judgment.entities.brand.rank, 1);
  // 原始判定里没有算好的分数，所有数字都在报告阶段重新推导。
  assert.equal(ok.payload.judgment.entities.brand.score, undefined);

  // 判定失败必须降级，而不是让整份报告失败。
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.payload.degraded, true);
  assert.equal(failed.payload.judgment, null);
  const events = logs.map((line) => JSON.parse(line)).map((item) => item.event);
  assert.ok(events.includes("analysis_judge_completed"));
  assert.ok(events.includes("analysis_judge_failed"));
});

test("counts 'first choice' only when the judge also ranked it first", () => {
  const entities = [{ id: "brand", type: "brand", name: "喜茶" }];
  const verdict = (presence, rank) => ({
    entities: { brand: { presence, rank, tone: "positive", claims: [], differentiation: {} } }
  });

  // 说是首选，但名次给了第二 → 互相矛盾，按保守口径丢掉“首选”。
  const inconsistent = judge.normalizeJudgment(
    verdict({ mentioned: true, evaluated: true, recommended: true, firstChoice: true }, 2),
    { answer: "我会先推林里，喜茶也不错。", entities }
  );
  assert.equal(inconsistent.entities.brand.items.firstChoice, false);
  assert.equal(inconsistent.entities.brand.dimensions.presence, 75);

  // 名次第一 + 首选 → 满分；被列为首选本身就意味着进了推荐清单。
  const consistent = judge.normalizeJudgment(
    verdict({ mentioned: true, evaluated: true, firstChoice: true }, 1),
    { answer: "我会先推喜茶。", entities }
  );
  assert.equal(consistent.entities.brand.items.recommended, true);
  assert.equal(consistent.entities.brand.dimensions.presence, 100);

  // 没有给出名次时，“首选”同样不成立。
  const noRank = judge.normalizeJudgment(
    verdict({ mentioned: true, evaluated: true, recommended: true, firstChoice: true }, null),
    { answer: "喜茶和竞品各有侧重。", entities }
  );
  assert.equal(noRank.entities.brand.items.firstChoice, false);
  assert.equal(noRank.entities.brand.dimensions.presence, 75);
});

test("reports the recommendation rate from judged answers only", () => {
  const questions = ["喜茶和林里哪个更清爽？"];
  const responses = [
    { provider: "deepseek", model: "deepseek-flash", answers: ["我会先推喜茶。"] },
    { provider: "glm", model: "glm-4.6v", answers: ["两家都不错。"] }
  ];
  const judged = analysis.analyzeObservations({
    brand: "喜茶",
    competitors: ["林里"],
    questions,
    responses,
    judgments: {
      "deepseek:0": {
        entities: {
          brand: {
            presence: {
              mentioned: true,
              evaluated: true,
              recommended: true,
              firstChoice: true
            },
            rank: 1,
            tone: "positive",
            claims: [],
            differentiation: {},
            reasons: {}
          }
        }
      },
      "glm:0": {
        entities: {
          brand: {
            presence: { mentioned: true, evaluated: true },
            rank: null,
            tone: "neutral",
            claims: [],
            differentiation: {},
            reasons: {}
          }
        }
      }
    }
  });
  // 两条回答都完成了判定：一条被推荐、一条只是被描述。
  assert.equal(judged.metrics.recommendationRate, 50);
  assert.equal(judged.metrics.firstChoiceRate, 50);
  assert.equal(judged.metrics.judgedAnswers, 2);
  // 提及率仍然是 100%——这正是它没有区分度的原因，所以顶部换成主动推荐率。
  assert.equal(judged.metrics.mentionRate, 100);

  // 全部回落规则判定时，这项没有数据，必须留空而不是当成 0。
  const rulesOnly = analysis.analyzeObservations({
    brand: "喜茶",
    competitors: ["林里"],
    questions,
    responses
  });
  assert.equal(rulesOnly.metrics.recommendationRate, null);
  assert.equal(rulesOnly.metrics.firstChoiceRate, null);
  assert.equal(rulesOnly.metrics.judgedAnswers, 0);
  assert.equal(rulesOnly.observations[0].recommended, false);
  // 规则判定下，只有逐字出现品牌名的那条算提及。
  assert.equal(rulesOnly.metrics.mentionRate, 50);
});

test("retries a truncated verdict once and reports why it failed", async () => {
  let calls = 0;
  const result = await judge.judgeAnswer({
    question: "喜茶和林里哪个更清爽？",
    answer: "我会先推喜茶。",
    entities: [{ id: "brand", type: "brand", name: "喜茶" }],
    callChatImpl: async ({ messages }) => {
      calls += 1;
      if (calls === 1) {
        // Cut off mid-JSON: this is what the production logs showed.
        return {
          model: "deepseek-flash",
          message: { content: '{"entities":{"brand":{"presence":{"mentioned":true},' },
          finishReason: "length"
        };
      }
      assert.match(
        messages[messages.length - 1].content,
        /不是完整合法的 JSON/,
        "the retry must tell the model what went wrong"
      );
      return {
        model: "deepseek-flash",
        message: {
          content: JSON.stringify({ entities: { brand: { presence: { mentioned: true } } } })
        },
        finishReason: "stop"
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.judgment.entities.brand.dimensions.presence, 25);

  // Two broken answers: the error carries the diagnostics the route logs.
  let error = null;
  const broken = '{"entities":';
  try {
    await judge.judgeAnswer({
      question: "q",
      answer: "a",
      entities: [{ id: "brand", type: "brand", name: "喜茶" }],
      callChatImpl: async () => ({
        model: "deepseek-flash",
        message: { content: broken },
        finishReason: "length"
      })
    });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, "a verdict that never parses must fail");
  assert.equal(error.contentLength, broken.length);
  assert.equal(error.finishReason, "length");
  assert.equal(error.attempt, 2);
});

test("only asks the judge about the entities the question names", async () => {
  const handler = require("../api/analyze.js");
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousFetch = global.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let sent = null;
  const res = {
    statusCode: 0,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    }
  };
  try {
    global.fetch = async (_url, options) => {
      sent = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "deepseek-flash",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  entities: {
                    brand: { presence: { mentioned: true }, rank: 1, tone: "positive" }
                  }
                })
              }
            }
          ]
        })
      };
    };
    await handler(
      {
        method: "POST",
        body: {
          phase: "judge",
          requestId: "req_scope",
          provider: "deepseek",
          questionIndex: 0,
          question: "喜茶和林里哪个更清爽？",
          answer: "我会先推喜茶，林里甜度偏高。",
          brief: {
            brand: "喜茶",
            competitors: [{ name: "林里" }, { name: "奈雪" }]
          }
        }
      },
      res
    );
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }

  const prompt = sent.messages.map((message) => message.content).join("\n");
  assert.match(prompt, /id=brand（品牌）喜茶/);
  assert.match(prompt, /id=competitor_1（竞品）林里/);
  assert.doesNotMatch(prompt, /奈雪/, "an entity the question never asked must not be judged");
  assert.equal(res.statusCode, 200);
  assert.ok(res.payload.judgment.entities.brand);
});

test("rejects a judge request without a usable answer", async () => {
  const input = require("../api/_lib/analyze-input.js");
  assert.deepEqual(
    Object.keys(
      input.cleanJudgments({
        "deepseek:0": { entities: { brand: { presence: { mentioned: true } } } },
        "qwen:0": { entities: {} },
        "deepseek:9": { entities: {} },
        "deepseek:1": "not-an-object"
      })
    ),
    ["deepseek:0"]
  );
  assert.throws(
    () =>
      input.cleanJudgeInput({
        provider: "deepseek",
        questionIndex: 0,
        question: "喜茶和林里哪个更清爽？",
        answer: "",
        brief: { brand: "喜茶", competitors: [{ name: "林里" }] }
      }),
    /invalid_answer/
  );
});

// --- background search for the recommendations module ---

test("builds at most four background queries from the brief", () => {
  const queries = background.buildBackgroundQueries({
    brand: "麦当劳",
    brandProduct: "炸鸡",
    competitors: [{ name: "肯德基" }, { name: "德克士" }, { name: "塔斯汀" }]
  });
  assert.ok(queries.length <= background.MAX_QUERIES);
  assert.deepEqual(
    queries.map((item) => item.kind),
    ["brand", "competitor", "competitor", "category"]
  );
  assert.match(queries[0].query, /麦当劳 炸鸡/);
  assert.match(queries[1].query, /肯德基/);
  // 竞品最多搜两个，避免查询数量膨胀。
  assert.ok(!queries.some((item) => item.query.includes("塔斯汀")));
});

test("collects background sources and never throws when search fails", async () => {
  const ok = await background.collectBackground(
    { brand: "喜茶", brandProduct: "", competitors: [{ name: "林里" }] },
    {
      searchImpl: async (query) => ({
        status: "ok",
        query,
        results: [
          { title: "喜茶官方数据", url: "https://www.heytea.com/news", content: "官方披露" },
          { title: "坏链接", url: "javascript:alert(1)", content: "" },
          // 同一个链接出现两次只保留一条
          { title: "喜茶官方数据", url: "https://www.heytea.com/news", content: "重复" }
        ]
      })
    }
  );
  assert.equal(ok.status, "ok");
  assert.equal(ok.sources.length, 1);
  assert.equal(ok.sources[0].id, "background_1");
  assert.equal(ok.sources[0].host, "heytea.com");
  assert.equal(ok.sources[0].kind, "brand");
  assert.ok(ok.durationMs >= 0);

  const failed = await background.collectBackground(
    { brand: "喜茶", competitors: [{ name: "林里" }] },
    {
      searchImpl: async () => {
        throw new Error("network down");
      }
    }
  );
  assert.equal(failed.status, "unavailable");
  assert.deepEqual(failed.sources, []);
  assert.ok(failed.queries.every((item) => item.status === "failed"));

  const empty = await background.collectBackground(
    { brand: "喜茶", competitors: [{ name: "林里" }] },
    { searchImpl: async (query) => ({ status: "ok", query, results: [] }) }
  );
  assert.equal(empty.status, "empty");
});

test("tolerates a hanging search instead of stalling the report", async () => {
  const startedAt = Date.now();
  const result = await background.collectBackground(
    { brand: "喜茶", competitors: [] },
    {
      timeoutMs: 60,
      searchImpl: () => new Promise(() => {})
    }
  );
  assert.equal(result.status, "unavailable");
  assert.ok(Date.now() - startedAt < 2000, "a hang must be cut off by the timeout");
});

test("attaches at most one verified external source to a recommendation", () => {
  const analyzed = {
    brand: "喜茶",
    competitors: ["林里"],
    questions: ["喜茶和林里哪个更清爽？"],
    responses: [],
    observations: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        questionIndex: 0,
        question: "喜茶和林里哪个更清爽？",
        answer: "我会先推喜茶。",
        mentionQuote: "我会先推喜茶"
      },
      {
        provider: "glm",
        model: "glm-4.6v",
        questionIndex: 0,
        question: "喜茶和林里哪个更清爽？",
        answer: "两家都不错。",
        mentionQuote: ""
      }
    ]
  };
  const withBackground = insights.normalizeInsights(
    {
      positioning: { headline: "AI 眼中的喜茶是果茶首选。" },
      suggestions: [
        {
          title: "补充第三方实测",
          analysis: "回答缺少具体依据。",
          suggestion: "公布一份可核查的实测数据，回应竞品说法。",
          evidenceIds: ["answer_deepseek_0"],
          backgroundId: "background_1"
        },
        {
          title: "编造来源",
          analysis: "回答缺少依据。",
          suggestion: "引用一个不存在的来源。",
          evidenceIds: ["answer_deepseek_0"],
          backgroundId: "background_99"
        }
      ]
    },
    analyzed,
    {
      status: "ok",
      sources: [
        {
          id: "background_1",
          kind: "category",
          label: "品类推荐现状",
          title: "某榜单",
          url: "https://example.com/list",
          host: "example.com"
        }
      ]
    }
  );
  assert.equal(withBackground.suggestions.length, 2);
  assert.equal(withBackground.suggestions[0].source.url, "https://example.com/list");
  assert.equal(withBackground.suggestions[0].source.host, "example.com");
  // 不存在的 backgroundId 直接丢掉，不会渲染成来源。
  assert.equal(withBackground.suggestions[1].source, null);

  // 没有搜索结果的报告不能凭空长出来源。
  const noBackground = insights.normalizeInsights(
    {
      positioning: { headline: "AI 眼中的喜茶是果茶首选。" },
      suggestions: [
        {
          title: "补充第三方实测",
          analysis: "回答缺少具体依据。",
          suggestion: "公布一份可核查的实测数据。",
          evidenceIds: ["answer_deepseek_0"],
          backgroundId: "background_1"
        }
      ]
    },
    analyzed,
    { status: "unavailable", sources: [] }
  );
  assert.equal(noBackground.suggestions[0].source, null);
});

test("tells the insights model how search results may be used", () => {
  const messages = insights.buildMessages(
    { brand: "喜茶", competitors: [{ name: "林里" }] },
    { metrics: {}, questionStats: [], conflicts: [], observations: [] },
    {
      status: "ok",
      sources: [{ id: "background_1", kind: "brand", title: "某报道", url: "https://example.com/a", host: "example.com" }]
    }
  );
  const system = messages[0].content;
  assert.match(system, /只能用来补充背景和素材/);
  assert.match(system, /就挑最相关的那一条建议引用它（backgroundId）/);
  assert.match(system, /不能把 background 里的数字说成这个产品的表现/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.background.sources[0].id, "background_1");
});

// --- recommendations must carry concrete measures, not slogans ---

const vagueSuggestion = "加强品牌专业形象，持续优化用户口碑。";
const concreteSuggestion =
  "在官网产品页新增一栏第三方实测数据，并把客服话术统一改成引用该数据。· 做一条 30 秒的对比视频投放到小红书，由产品经理提供素材、市场同学剪辑，每周投放预算控制在 300 元以内。· 一周后用同一组问题复测，看“证据完整”和“推荐出现”两个维度是否上升；如果没有变化，就换成图文长图继续测试两周。";

test("records a coverage gap when only one model mentions the product", () => {
  const questions = ["华为和 vivo 的最新旗舰哪个更适合拍照？"];
  const responses = [
    {
      provider: "deepseek",
      model: "deepseek-flash",
      // 这个模型查不到型号，回答里没有出现品牌名
      answers: ["我没有查到这款机型的准确信息，无法比较。"]
    },
    {
      provider: "glm",
      model: "glm-4.6v",
      answers: ["华为的最新旗舰在夜景上更稳，vivo 在人像色彩上更讨喜。"]
    }
  ];
  const analyzed = analysis.analyzeObservations({
    brand: "华为",
    competitors: ["vivo"],
    questions,
    responses
  });
  // 品牌和竞品各记一条：缺了华为，也缺了 vivo。
  assert.equal(analyzed.coverageGaps.length, 2);
  const gap = analyzed.coverageGaps.find((item) => item.entityName === "华为");
  assert.ok(gap);
  assert.equal(gap.entityName, "华为");
  assert.equal(gap.questionIndex, 0);
  assert.equal(gap.sides.find((side) => side.provider === "deepseek").mentioned, false);
  assert.equal(gap.sides.find((side) => side.provider === "glm").mentioned, true);

  // 两个模型都提到时不会记成覆盖缺口。
  const bothMention = analysis.analyzeObservations({
    brand: "华为",
    competitors: ["vivo"],
    questions,
    responses: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        answers: ["华为的夜景更强，vivo 的人像色彩更讨喜。"]
      },
      { provider: "glm", model: "glm-4.6v", answers: ["华为偏稳，vivo 更讨喜。"] }
    ]
  });
  assert.deepEqual(bothMention.coverageGaps, []);
});

test("carries coverage gaps into the positioning block without the model", () => {
  const analyzed = {
    brand: "华为",
    questions: ["华为和 vivo 的最新旗舰哪个更适合拍照？"],
    observations: [],
    coverageGaps: [
      {
        entityId: "brand",
        entityName: "华为",
        entityType: "brand",
        questionIndex: 0,
        question: "华为和 vivo 的最新旗舰哪个更适合拍照？",
        sides: [
          { provider: "deepseek", model: "deepseek-flash", mentioned: false, quote: "" },
          { provider: "glm", model: "glm-4.6v", mentioned: true, quote: "华为偏稳。" }
        ]
      }
    ]
  };
  const result = insights.normalizeInsights(
    { positioning: { headline: "AI 眼中的华为是影像旗舰。" } },
    analyzed,
    { status: "unavailable", sources: [] }
  );
  assert.equal(result.positioning.coverageGaps.length, 1);
  assert.equal(result.positioning.coverageGaps[0].entityName, "华为");
  // 定位总结里也要带上这句话，Copilot 才不会说“报告里没有这个数据”。
  assert.match(result.positioningSummary, /没有提到/);
});

test("puts each bulleted measure on its own line", () => {
  // 模型经常把分点写在同一行，页面上就看不到列表。
  assert.equal(
    insights.formatSuggestionText("先做实测。· 再拍视频。· 一周后复测。"),
    "· 先做实测。\n· 再拍视频。\n· 一周后复测。"
  );
  // 已经是多行时，第一个要点也要补上“· ”，不能只有后面几条有。
  assert.equal(
    insights.formatSuggestionText("先做实测。\n· 再拍视频。"),
    "· 先做实测。\n· 再拍视频。"
  );
  // 没有分点的文本不动。
  assert.equal(
    insights.formatSuggestionText("在官网新增一栏实测数据。"),
    "在官网新增一栏实测数据。"
  );
  assert.equal(insights.formatSuggestionText(""), "");
});

test("strips Markdown markers out of positioning and suggestions", () => {
  const analyzed = {
    brand: "喜茶",
    questions: [],
    observations: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        questionIndex: 0,
        question: "喜茶和林里哪个更清爽？",
        answer: "我会先推喜茶。",
        mentionQuote: "我会先推喜茶"
      }
    ]
  };
  const result = insights.normalizeInsights(
    {
      positioning: {
        headline: "**AI 认为喜茶**是果茶首选",
        consensus: "__两个模型__都提到甜度"
      },
      suggestions: [
        {
          title: "**补齐实测**",
          analysis: "回答*缺少*依据。",
          suggestion: "在官网新增一栏**实测数据**。\n· 一周后复测。",
          evidenceIds: ["answer_deepseek_0"]
        }
      ]
    },
    analyzed,
    { status: "unavailable", sources: [] }
  );
  assert.equal(result.positioning.headline, "AI 认为喜茶是果茶首选");
  assert.equal(result.positioning.consensus, "两个模型都提到甜度");
  assert.equal(result.suggestions[0].title, "补齐实测");
  assert.equal(result.suggestions[0].analysis, "回答缺少依据。");
  assert.doesNotMatch(result.suggestions[0].suggestion, /\*\*|__/);
});

test("flags a suggestion that only stacks empty verbs", () => {
  const problems = insights.suggestionProblems(vagueSuggestion);
  assert.ok(problems.includes("too_short"));
  assert.ok(problems.includes("no_concrete_action"));
  assert.ok(problems.includes("no_deliverable"));
  assert.ok(problems.includes("empty_verbs"));

  assert.deepEqual(insights.suggestionProblems(concreteSuggestion), []);
  // 只有形容词没有产出物也算不合格。
  assert.ok(
    insights
      .suggestionProblems(`新增一版内容，让更多人看到我们的优势。${"我们做得更好。".repeat(12)}`)
      .includes("no_deliverable")
  );
  // 太啰嗦同样会退回。
  assert.ok(
    insights.suggestionProblems(`${concreteSuggestion}${"补充说明。".repeat(80)}`).includes("too_long")
  );
});

test("the insights prompt asks for 100-220 characters and banlists empty verbs", () => {
  const messages = insights.buildMessages(
    { brand: "喜茶", competitors: [{ name: "林里" }] },
    { metrics: {}, questionStats: [], conflicts: [], observations: [] },
    { status: "unavailable", sources: [] }
  );
  const system = messages[0].content;
  assert.match(system, /100-220 个汉字/);
  assert.match(system, /加强、提升、优化、打造/);
  assert.match(system, /在哪个渠道、对谁、做什么、产出什么/);
  assert.match(system, /会被系统判为不合格并退回重写/);
  // 示例本身必须每条都带“· ”：模型会照抄示例的格式。
  assert.match(
    system,
    /示例（好，注意换行）：\n· 在官网产品页新增一栏第三方实测数据/
  );
});

test("rewrites only the vague suggestions and keeps the concrete one", async () => {
  const analyzed = {
    brand: "喜茶",
    questions: ["喜茶和林里哪个更清爽？"],
    observations: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        questionIndex: 0,
        question: "喜茶和林里哪个更清爽？",
        answer: "我会先推喜茶。",
        mentionQuote: "我会先推喜茶"
      }
    ]
  };
  const suggestions = [
    {
      title: "空话建议",
      analysis: "回答缺少具体依据。",
      suggestion: vagueSuggestion,
      evidenceIds: ["answer_deepseek_0"],
      source: null
    },
    {
      title: "具体建议",
      analysis: "回答缺少具体依据。",
      suggestion: concreteSuggestion,
      evidenceIds: ["answer_deepseek_0"],
      source: { id: "background_1", url: "https://example.com/a" }
    }
  ];
  const calls = [];
  const polished = await insights.polishSuggestions(
    { positioning: { headline: "AI 眼中的喜茶是果茶首选。" }, suggestions },
    {
      brief: { brand: "喜茶", competitors: [{ name: "林里" }] },
      analyzed,
      background: {
        status: "ok",
        sources: [
          {
            id: "background_1",
            kind: "category",
            title: "某榜单",
            url: "https://example.com/a",
            host: "example.com"
          }
        ]
      },
      callChatImpl: async (options) => {
        calls.push(options);
        return {
          model: "deepseek-flash",
          message: {
            content: JSON.stringify({
              suggestions: [
                {
                  index: 0,
                  title: "补齐可核查的实测素材",
                  suggestion: concreteSuggestion,
                  evidenceIds: ["answer_deepseek_0"],
                  backgroundId: "background_1"
                }
              ]
            })
          }
        };
      }
    }
  );

  assert.equal(calls.length, 1, "only one rewrite call is needed");
  assert.equal(calls[0].maxTokens, 1600);
  assert.deepEqual(calls[0].responseFormat, { type: "json_object" });
  assert.match(calls[0].messages[0].content, /太笼统，请只重写这几条/);
  const payload = JSON.parse(calls[0].messages[1].content);
  // 只把不合格的那一条发去重写。
  assert.equal(payload.rewrite.length, 1);
  assert.equal(payload.rewrite[0].index, 0);
  assert.ok(payload.rewrite[0].problems.includes("empty_verbs"));

  assert.equal(polished.suggestions[0].title, "补齐可核查的实测素材");
  // 行内写的“· ”会被规范成每行一个要点。
  assert.equal(
    polished.suggestions[0].suggestion,
    insights.formatSuggestionText(concreteSuggestion)
  );
  // 已经合格的那条原样保留。
  assert.deepEqual(polished.suggestions[1], suggestions[1]);
});

test("keeps the original suggestion when the rewrite is still vague", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (line) => logged.push(String(line));
  let polished;
  try {
    polished = await insights.polishSuggestions(
      {
        positioning: { headline: "AI 眼中的喜茶是果茶首选。" },
        suggestions: [
          {
            title: "空话建议",
            analysis: "回答缺少具体依据。",
            suggestion: vagueSuggestion,
            evidenceIds: [],
            source: null
          }
        ]
      },
      {
        brief: { brand: "喜茶", competitors: [] },
        analyzed: { brand: "喜茶", questions: [], observations: [] },
        background: { status: "unavailable", sources: [] },
        callChatImpl: async () => ({
          model: "deepseek-flash",
          message: {
            content: JSON.stringify({
              suggestions: [{ index: 0, suggestion: vagueSuggestion }]
            })
          }
        })
      }
    );
  } finally {
    console.error = originalError;
  }
  // 重写后仍然笼统 → 保留原文，但记一条日志，绝不让报告失败。
  assert.equal(polished.suggestions[0].suggestion, vagueSuggestion);
  const entry = logged
    .map((line) => JSON.parse(line))
    .find((item) => item.event === "insights_suggestion_polished");
  assert.ok(entry, "the rewrite must be logged");
  assert.equal(entry.stillVague, 1);
});

test("generateInsights polishes vague suggestions before returning", async () => {
  const calls = [];
  const analyzed = {
    brand: "喜茶",
    competitors: ["林里"],
    questions: ["喜茶和林里哪个更清爽？"],
    observations: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        questionIndex: 0,
        question: "喜茶和林里哪个更清爽？",
        answer: "我会先推喜茶。",
        mentionQuote: "我会先推喜茶"
      }
    ],
    metrics: {},
    questionStats: [],
    conflicts: []
  };
  const result = await insights.generateInsights(
    { brand: "喜茶", competitors: [{ name: "林里" }] },
    analyzed,
    {
      background: { status: "unavailable", sources: [] },
      callChatImpl: async (options) => {
        calls.push(options);
        if (calls.length === 1) {
          return {
            model: "deepseek-flash",
            message: {
              content: JSON.stringify({
                positioning: { headline: "AI 眼中的喜茶是果茶首选。" },
                suggestions: [
                  {
                    title: "空话建议",
                    analysis: "回答缺少具体依据。",
                    suggestion: vagueSuggestion,
                    evidenceIds: ["answer_deepseek_0"]
                  }
                ]
              })
            }
          };
        }
        return {
          model: "deepseek-flash",
          message: {
            content: JSON.stringify({
              suggestions: [{ index: 0, suggestion: concreteSuggestion }]
            })
          }
        };
      }
    }
  );
  assert.equal(calls.length, 2, "a vague suggestion triggers one rewrite call");
  assert.equal(calls[0].maxTokens, 2600, "the first call needs room for longer suggestions");
  assert.equal(
    result.suggestions[0].suggestion,
    insights.formatSuggestionText(concreteSuggestion)
  );
  assert.equal(result.status, "ok");
});

// --- resolving "the latest model" through search instead of memory ---

test("tells the assistant to verify current models with search", () => {
  const prompt = agent.systemPrompt("input", {});
  assert.match(prompt, /最新 \/ 今年 \/ 目前 \/ 新款 \/ 刚发布/);
  assert.match(prompt, /必须先调用 search_web 查证当前在售的型号/);
  assert.match(prompt, /至少两条来源一致/);
  assert.match(prompt, /必须同时通过 sources 参数给出 1–2 条来源/);
  assert.match(prompt, /绝对不要用记忆里的型号冒充当前最新款/);
  // 提示词里必须带当天日期，模型才有“最新”的基准。
  assert.match(prompt, new RegExp(`今天的日期是 ${new Date().toISOString().slice(0, 10)}`));
  assert.match(agent.TOOL_DEFINITIONS.search_web.function.description, /必须带上当前年份/);
});

test("accepts search sources on a form action and shows them on the confirm card", () => {
  const action = agent.validateToolCall(
    "fill_form",
    {
      brand: "华为",
      brandProduct: "Mate 90 Pro",
      competitors: ["vivo"],
      competitorProducts: ["X300 Pro"],
      sources: [
        { title: "华为官网发布页", url: "https://consumer.huawei.com/news" },
        { title: "坏链接", url: "javascript:alert(1)" },
        { title: "第三条应被丢弃", url: "https://example.com/third" }
      ]
    },
    {}
  );
  assert.equal(action.payload.sources.length, 2);
  assert.equal(action.payload.sources[0].host, "consumer.huawei.com");

  const card = agent.confirmCardFor([action]);
  assert.equal(card.type, "confirm_card");
  assert.equal(card.sources.length, 2);
  assert.equal(card.sources[0].url, "https://consumer.huawei.com/news");
  assert.equal(card.fields[1].value, "Mate 90 Pro");

  // 没有来源的表单动作不带来源字段。
  const plainCard = agent.confirmCardFor([
    agent.validateToolCall("fill_form", { brand: "喜茶" }, {})
  ]);
  assert.deepEqual(plainCard.sources, []);
});
