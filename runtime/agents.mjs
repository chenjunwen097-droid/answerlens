// Three-role agent layer:
//   Orchestrator  — decides whether it needs external information
//   Researcher    — turns search results into a compact, sourced brief
//   Report Agent  — answers only from a report, with optional web verification
//
// The tools are real: search goes through DeepSeek Search, every answer is a
// live model call. dsh (DeepSeek Harness) will be mounted behind this same
// interface once its Cordis tool plugins are written.
import { webSearch } from "./pipeline.mjs";

const DS_BASE = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com";
const DS_KEY = process.env.DEEPSEEK_API_KEY || "";
const DS_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";

async function chat(messages, { tools, maxTokens = 1200 } = {}) {
  const response = await fetch(`${DS_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${DS_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: DS_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      ...(tools ? { tools, tool_choice: "auto" } : {})
    }),
    signal: AbortSignal.timeout(45_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 200)}`);
  const payload = JSON.parse(text);
  return payload.choices?.[0]?.message || {};
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "查询实时网页信息。当问题涉及最新型号、价格、发布、新闻或你无法确定的事实时调用。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索词，尽量具体" } },
        required: ["query"],
        additionalProperties: false
      }
    }
  }
];

async function researcher(query) {
  const results = await webSearch(query, 5);
  const sourceText = results
    .map((item, index) => `[${index + 1}] ${item.title}（${item.url}）\n${item.summary}`)
    .join("\n\n");
  const message = await chat(
    [
      {
        role: "system",
        content:
          "你是检索整理员。只依据提供的搜索结果写一份 200 字以内的中文要点，必须标注引用编号；没有结果就明确说没有找到，不要补充记忆里的信息。"
      },
      { role: "user", content: `查询：${query}\n\n搜索结果：\n${sourceText || "（无）"}` }
    ],
    { maxTokens: 800 }
  );
  return {
    brief: String(message.content || "").trim(),
    sources: results.map((item) => ({
      title: item.title,
      url: item.url,
      date: item.date,
      authority: item.authority
    }))
  };
}

export async function agentReply({ message, report }) {
  if (!DS_KEY) throw new Error("DEEPSEEK_API_KEY 未配置");
  const system = report
    ? [
        "你是 AnswerLens 的报告助手（Report Agent）。",
        "只能依据给定的报告数据回答；数字必须与报告一致，报告里没有的信息要说没有。",
        "如果用户问的是报告之外的实时事实（最新价格、新闻、型号发布），调用 search_web，并在回答中给出来源编号。",
        "绝不编造数据或来源。"
      ].join("\n")
    : [
        "你是 AnswerLens 的主助手（Orchestrator）。",
        "用户想做 AI 推荐检测时，先确认品牌、竞品、型号和检测方向，不要自行编造型号。",
        "涉及最新价格、发布、新闻或你不确定的事实时，先调用 search_web，再回答。",
        "回答简洁，不使用 markdown 标题。"
      ].join("\n");

  const context = report
    ? `报告数据：${JSON.stringify({
        brand: report.brand,
        product: report.product,
        score: report.score,
        questions: (report.questions || []).map((item, index) => ({
          index: index + 1,
          q: item.q,
          score: item.score
        })),
        positioning: report.positioning,
        actions: report.actions
      })}`
    : "";

  const messages = [
    { role: "system", content: system },
    { role: "user", content: context ? `${context}\n\n用户问题：${message}` : String(message) }
  ];

  for (let round = 0; round < 2; round += 1) {
    const reply = await chat(messages, { tools: TOOLS });
    const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
    if (!calls.length) return String(reply.content || "").trim();
    messages.push({ role: "assistant", content: reply.content || "", tool_calls: calls });
    for (const call of calls) {
      let result;
      try {
        const args = JSON.parse(call.function?.arguments || "{}");
        result = await researcher(String(args.query || message));
      } catch (error) {
        result = { brief: `检索失败：${error.message}`, sources: [] };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
    }
  }
  return "我查到了相关资料，但信息不够确定，暂时无法给出可靠结论。";
}
