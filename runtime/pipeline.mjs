// Real analysis pipeline. Every question, answer, verdict and report sentence
// comes from a live model call; nothing here is generated from templates.
import { randomUUID } from "node:crypto";

const DS_BASE = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com";
const DS_KEY = process.env.DEEPSEEK_API_KEY || "";
const DS_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const DS_JUDGE_MODEL = process.env.DEEPSEEK_JUDGE_MODEL || DS_MODEL;
const GLM_BASE = process.env.GLM_API_BASE || "https://open.bigmodel.cn/api/paas/v4";
const GLM_KEY = process.env.GLM_API_KEY || "";
const GLM_MODEL = process.env.GLM_MODEL || "glm-4.6v";

const WEIGHTS = [
  { key: "presence", label: "推荐出现", weight: 25 },
  { key: "rank", label: "推荐顺位", weight: 25 },
  { key: "tone", label: "描述倾向", weight: 15 },
  { key: "evidence", label: "证据完整", weight: 20 },
  { key: "differentiation", label: "竞品差异", weight: 15 }
];

const STAGES = [
  { stage: "understand", label: "理解需求" },
  { stage: "research", label: "联网调研" },
  { stage: "questions", label: "设计问题" },
  { stage: "answers", label: "模型作答" },
  { stage: "judge", label: "逐条判定" },
  { stage: "report", label: "汇总报告" }
];

const budget = { started: Date.now(), maxMs: 240_000, tokens: 0, maxTokens: 160_000 };

function checkBudget() {
  if (Date.now() - budget.started > budget.maxMs) throw new Error("分析超时（>4 分钟），本次未生成报告");
  if (budget.tokens > budget.maxTokens) throw new Error("本次分析超出 token 预算，已终止");
}

function countTokens(text) {
  budget.tokens += Math.ceil(String(text || "").length / 4);
}

async function postJson(url, body, headers, timeout = 90_000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  countTokens(text);
  if (!response.ok) throw new Error(`${new URL(url).host} ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function extractJson(text) {
  const source = String(text || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(source);
  } catch {
    const match = source.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) throw new Error("模型没有返回 JSON");
    return JSON.parse(match[0]);
  }
}

async function deepseek(messages, { json = false, temperature = 0.2, maxTokens = 2000 } = {}) {
  if (!DS_KEY) throw new Error("DEEPSEEK_API_KEY 未配置");
  const payload = await postJson(
    `${DS_BASE}/chat/completions`,
    {
      model: DS_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
      // v1 did the same: DeepSeek Flash is a reasoning model, and analysis
      // steps need the answer, not the hidden chain of thought.
      thinking: { type: "disabled" },
      ...(json ? { response_format: { type: "json_object" } } : {})
    },
    { authorization: `Bearer ${DS_KEY}` }
  );
  const text = payload.choices?.[0]?.message?.content || "";
  countTokens(text);
  return text;
}

async function glm(messages, { temperature = 0.4, maxTokens = 400 } = {}) {
  if (!GLM_KEY) throw new Error("GLM_API_KEY 未配置");
  const payload = await postJson(
    `${GLM_BASE}/chat/completions`,
    { model: GLM_MODEL, messages, temperature, max_tokens: maxTokens },
    { authorization: `Bearer ${GLM_KEY}` }
  );
  const text = payload.choices?.[0]?.message?.content || "";
  countTokens(text);
  return text;
}

async function search(query, count = 5) {
  if (!DS_KEY) throw new Error("DEEPSEEK_API_KEY 未配置（搜索需要）");
  const payload = await postJson(
    `${DS_BASE}/v1/tools/search`,
    { query, count, need_content: false },
    { authorization: `Bearer ${DS_KEY}` },
    30_000
  );
  return (payload.results || [])
    .filter((item) => Number(item.rerank_score ?? 0) >= 1.2)
    .slice(0, count)
    .map((item) => ({
      title: item.title,
      url: item.url,
      summary: item.summary || item.snippet || "",
      date: item.date || null,
      authority: Number(item.authority ?? -1)
    }));
}

function stage(index) {
  return { type: "stage", stage: STAGES[index].stage, label: STAGES[index].label, index, total: STAGES.length };
}

async function researchBrief(brief) {
  const product = brief.product || "";
  const queries = [
    `${brief.brand} ${product} 产品 参数 定位`.trim(),
    ...brief.competitors.slice(0, 2).map((name) => `${name} 产品 参数 定位`)
  ];
  const sources = [];
  for (const query of queries) {
    try {
      sources.push(...(await search(query, 4)));
    } catch {
      // A failed search is a fact, not a blocker: the prompt below will say so.
    }
  }
  const seen = new Set();
  const unique = sources.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
  return {
    sources: unique.slice(0, 8),
    summary: unique
      .slice(0, 8)
      .map((item, index) => `[${index + 1}] ${item.title}（${item.url}）：${item.summary}`)
      .join("\n")
  };
}

function questionProblems(questions, brief) {
  if (!Array.isArray(questions) || questions.length !== 6) return "必须正好 6 个问题";
  // Models freely vary spacing ("华为 Mate 70" vs "华为Mate 70"), so compare
  // names with whitespace removed, the same way the v1 validator did.
  const compact = (value) => String(value || "").toLowerCase().replace(/\s+/g, "");
  for (const question of questions) {
    const text = compact(question);
    if (!brief.brand || !text.includes(compact(brief.brand))) return `问题缺少品牌：${question}`;
    if (!brief.competitors.some((name) => text.includes(compact(name)))) return `问题缺少竞品：${question}`;
  }
  if (new Set(questions).size !== 6) return "问题重复";
  for (const competitor of brief.competitors) {
    const count = questions.filter((question) => compact(question).includes(compact(competitor))).length;
    if (count < 3) return `竞品 ${competitor} 只出现在 ${count} 题，至少需要 3 题`;
  }
  return "";
}

async function designQuestions(brief, research) {
  const prompt = `你是真实买家问题设计 Agent。为下面的产品对比设计 6 个买家会问 AI 的购买决策问题。
品牌：${brief.brand}${brief.product ? `（${brief.product}）` : ""}
竞品：${brief.competitors.join("、")}
检测方向：${(brief.directions || []).join("、") || "未指定"}
其他背景：${brief.other || "无"}
联网调研材料：
${research.summary || "（无）"}

要求：
1. 6 题固定配方：2 题一句话直接对比；2 题带真实场景（人群/时间/预算/地点/健康忌口等，先交代处境再提问）；1 题针对决策阶段（第一次买、换品牌、复购、送礼）；1 题要求 AI 给出推荐顺序或只能选一个；
2. 每题必须同时包含品牌名和至少一个竞品；有型号时优先用型号；
3. 每个竞品至少出现在 3 题；每个检测方向至少出现在 2 题、最多 3 题；
4. 不要编造具体参数、价格、销量、评价或来源；问题要保持在模型凭常识能回答的层面；
5. 6 题不要用相同开头；同一类场景最多 2 题；
6. 像真实买家说话，不要写“作为 AI”这类元问题；
7. 只返回 JSON：{"questions":[{"text":"","dimension":"","entities":[],"rationale":""}]}`;
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = await deepseek(
      [
        { role: "system", content: "你是严谨的消费者研究分析师，只输出 JSON。" },
        { role: "user", content: prompt + (lastProblem ? `\n上次的问题：${lastProblem}，请修正。` : "") }
      ],
      { json: true, temperature: attempt === 0 ? 0.5 : 0.2, maxTokens: 2000 }
    );
    const parsed = extractJson(text);
    const questions = (Array.isArray(parsed) ? parsed : parsed.questions || []).map((item) =>
      typeof item === "string" ? item.trim() : String(item?.text || "").trim()
    );
    lastProblem = questionProblems(questions, brief);
    if (!lastProblem) return questions.map(String);
  }
  throw new Error(`问题生成不达标：${lastProblem}`);
}

async function answerWith(provider, question, brief) {
  const system =
    "你在回答一个真实买家的购买决策问题。只给结论和关键理由，不要展开成文章，控制在 120 字以内，不要编造未给出的参数。";
  const user = `问题：${question}\n背景：${brief.brand}${brief.product ? ` ${brief.product}` : ""} 对比 ${brief.competitors.join("、")}`;
  if (provider === "deepseek") {
    return (await deepseek([{ role: "system", content: system }, { role: "user", content: user }], {
      temperature: 0.4,
      maxTokens: 800
    })).trim();
  }
  return (await glm([{ role: "system", content: system }, { role: "user", content: user }], {
    temperature: 0.4,
    maxTokens: 800
  })).trim();
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

const TONES = { positive: 100, neutral: 60, mixed: 40, negative: 20 };

function scoreEntity(entity) {
  const presence = clamp(
    ((entity.mentioned ? 1 : 0) +
      (entity.evaluated ? 1 : 0) +
      (entity.recommended ? 1 : 0) +
      (entity.firstChoice ? 1 : 0) -
      (entity.rejected ? 2 : 0)) /
      4 *
      100
  );
  const rank = Number(entity.rank);
  const rankScore = Number.isFinite(rank) && rank > 0 ? Math.max(25, 100 - (rank - 1) * 25) : null;
  const tone = TONES[entity.tone] ?? 60;
  const specific = Number(entity.claims?.specific ?? 0);
  const vague = Number(entity.claims?.vague ?? 0);
  const evidence = specific + vague > 0 ? clamp((specific / (specific + vague)) * 100) : null;
  const differentiation = clamp(
    ((entity.compared ? 1 : 0) + (entity.difference ? 1 : 0) + (entity.condition ? 1 : 0)) / 3 * 100
  );
  const values = { presence, rank: rankScore, tone, evidence, differentiation };
  let weighted = 0;
  let totalWeight = 0;
  for (const dimension of WEIGHTS) {
    const value = values[dimension.key];
    if (value === null || value === undefined) continue;
    weighted += value * (dimension.weight / 100);
    totalWeight += dimension.weight / 100;
  }
  return {
    score: totalWeight ? clamp(weighted / totalWeight) : null,
    dimensions: values,
    reasons: entity.reasons || {}
  };
}

async function judgeAnswer({ question, answer, brief }) {
  const entities = [
    {
      id: "brand",
      // The answer often writes the model name ("小米 14") instead of the bare
      // brand ("小米"); both must count as the same object.
      name: brief.product ? `${brief.brand}（${brief.product}）` : brief.brand
    },
    ...brief.competitors.map((name, index) => ({ id: `competitor_${index + 1}`, name }))
  ];
  const prompt = `逐条判定下面这条 AI 回答，只依据回答原文，不补充外部知识。
问题：${question}
回答：${answer}
需要判定的对象：${entities.map((item) => `${item.id}=${item.name}`).join("；")}
注意：提到品牌名或产品型号，都算提到该对象。

对每个对象输出：
- mentioned 是否提到名称；evaluated 是否给出评价；recommended 是否列入推荐；firstChoice 是否第一推荐；rejected 是否明确不推荐
- rank：推荐顺位（1 起，没有顺序填 null）
- tone：positive / neutral / mixed / negative
- claims：specific 具体主张数、vague 笼统主张数
- compared 是否与其他对象比较；difference 是否指出差异；condition 是否给出选择条件
- reasons：五个维度各一句中文依据，必须引用回答里的原句
只返回 JSON：{"entities":[{"id":"brand","mentioned":false,"evaluated":false,"recommended":false,"firstChoice":false,"rejected":false,"rank":null,"tone":"neutral","claims":{"specific":0,"vague":0},"compared":false,"difference":false,"condition":false,"reasons":{"推荐出现":"","推荐顺位":"","描述倾向":"","证据完整":"","竞品差异":""}}]}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await deepseek(
        [
          { role: "system", content: "你是严格的评审，只输出 JSON，评分必须有原文依据。" },
          { role: "user", content: prompt }
        ],
        { json: true, temperature: 0, maxTokens: 2000 }
      );
      const parsed = extractJson(text);
      if (!Array.isArray(parsed.entities)) throw new Error("缺少 entities");
      const result = {};
      for (const entity of entities) {
        const judged = parsed.entities.find((item) => item.id === entity.id);
        if (!judged) throw new Error(`缺少 ${entity.id} 的判定`);
        result[entity.id] = scoreEntity(judged);
      }
      return { entities: result, degraded: false };
    } catch (error) {
      if (attempt === 1) throw new Error(`judge 失败：${error.message}`);
    }
  }
  throw new Error("judge 失败");
}

async function composeReport({ brief, questions, answered, judged, research }) {
  const digest = questions
    .map((question, index) => {
      const answers = answered.filter((item) => item.questionIndex === index);
      const brand = judged.find((item) => item.questionIndex === index)?.entities?.brand;
      return `第 ${index + 1} 题：${question}\n品牌得分：${brand?.score ?? "-"}\n${answers
        .map((item) => `${item.provider}：${item.text.slice(0, 120)}`)
        .join("\n")}`;
    })
    .join("\n\n");
  const prompt = `基于下面的真实检测结果，写报告的定位判断和行动建议。
品牌：${brief.brand}${brief.product ? `（${brief.product}）` : ""}
竞品：${brief.competitors.join("、")}
调研材料（可能有缺失，缺失就说明缺失）：
${research.summary || "（本次没有可用的联网结果）"}

${digest}

要求：
1. 只总结上面出现的内容，不得补充外部事实；
2. positioning 输出三项：一句话定位、模型共识、与竞品的关键差异；
3. actions 输出三条，每条必须具体可执行，并给出 evidenceIds（用 q1…q6 指向题目）；
4. 只返回 JSON：{"headline":"...","positioning":[{"label":"一句话定位","text":"..."}],"actions":[{"title":"...","why":"...","evidenceIds":["q1"]}]}`;
  const text = await deepseek(
    [
      { role: "system", content: "你是增长分析师，只依据给定证据写结论，证据不足要直说。" },
      { role: "user", content: prompt }
    ],
    { json: true, temperature: 0.3, maxTokens: 2500 }
  );
  return extractJson(text);
}

function buildReport({ brief, reportId, questions, answered, judged, content, research }) {
  const questionScores = questions.map((_, index) => {
    const brand = judged.find((item) => item.questionIndex === index)?.entities?.brand;
    return brand?.score ?? null;
  });
  const available = questionScores.filter((score) => score !== null);
  const score = available.length ? Math.round(available.reduce((sum, value) => sum + value, 0) / available.length) : null;
  const entityRows = [{ id: "brand", name: brief.brand, type: "brand" }].concat(
    brief.competitors.map((name, index) => ({ id: `competitor_${index + 1}`, name, type: "competitor" }))
  );
  const bars = entityRows.map((entity) => {
    const values = judged
      .map((item) => item.entities[entity.id]?.score)
      .filter((value) => typeof value === "number");
    return {
      name: entity.name,
      value: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0,
      asked: values.length,
      insufficient: values.length === 0
    };
  });
  const ranked = [...bars].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  bars.forEach((bar) => {
    const position = ranked.findIndex((item) => item.name === bar.name) + 1;
    bar.rank = bar.value === null || bar.asked < 2 ? null : position;
  });
  const answersByQuestion = questions.map((_, index) =>
    answered.filter((item) => item.questionIndex === index)
  );
  return {
    id: reportId || randomUUID(),
    brand: brief.brand,
    product: brief.product || "",
    competitors: brief.competitors,
    score,
    date: new Date().toISOString().slice(0, 10),
    version: 1,
    status: "complete",
    headline: content.headline || "",
    summary:
      score === null
        ? `${brief.brand} 的有效回答不足，无法计算推荐表现。`
        : `${brief.brand} 的 AI 推荐表现平均分为 ${score}/100，共分析 ${questions.length} 个决策问题和 ${answered.length} 条真实回答。`,
    metrics: {
      recommendRate: Math.round(
        (judged.filter((item) => item.entities.brand?.dimensions.presence >= 75).length / Math.max(1, judged.length)) * 100
      ),
      firstChoiceRate: Math.round(
        (judged.filter((item) => item.entities.brand?.dimensions.rank === 100).length / Math.max(1, judged.length)) * 100
      ),
      samples: answered.length
    },
    bars,
    positioning: content.positioning || [],
    actions: (content.actions || []).map((action) => ({
      title: action.title,
      why: action.why,
      evidenceIds: action.evidenceIds || []
    })),
    questions: questions.map((question, index) => ({
      q: question,
      score: questionScores[index],
      deepseek: answersByQuestion[index].find((item) => item.provider === "deepseek")?.text || "",
      glm: answersByQuestion[index].find((item) => item.provider === "glm")?.text || "",
      answers: answersByQuestion[index],
      judgments: judged.find((item) => item.questionIndex === index)?.entities || {}
    })),
    research: research.sources.map((item) => ({
      title: item.title,
      url: item.url,
      date: item.date,
      authority: item.authority
    })),
    model: { deepseek: DS_MODEL, glm: GLM_MODEL, judge: DS_JUDGE_MODEL },
    tokens: budget.tokens
  };
}

export async function chatReply({ message, report }) {
  const system = report
    ? "你是 AnswerLens 的报告助手。只依据给定的报告数据回答；数字必须与报告一致，报告里没有的信息要明确说没有，绝不编造。"
    : "你是 AnswerLens 的助手。用户想做 AI 推荐检测时，先确认品牌、竞品、型号与检测方向；不要编造型号。回答简洁。";
  const context = report
    ? JSON.stringify({
        brand: report.brand,
        score: report.score,
        questions: report.questions?.map((item, index) => ({
          index: index + 1,
          q: item.q,
          score: item.score
        })),
        positioning: report.positioning,
        actions: report.actions
      })
    : "";
  return (
    await deepseek(
      [
        { role: "system", content: system },
        { role: "user", content: context ? `报告数据：${context}\n\n用户问题：${message}` : String(message) }
      ],
      { temperature: 0.4, maxTokens: 1200 }
    )
  ).trim();
}

export async function* runPipeline({ brief, reportId }) {
  budget.started = Date.now();
  budget.tokens = 0;
  if (!DS_KEY || !GLM_KEY) throw new Error("运行时缺少 DEEPSEEK_API_KEY 或 GLM_API_KEY");
  const normalized = {
    brand: String(brief.brand || "").trim(),
    product: String(brief.product || "").trim(),
    competitors: (brief.competitors || []).map(String).filter(Boolean).slice(0, 3),
    directions: brief.directions || [],
    other: brief.other || ""
  };
  if (!normalized.brand || !normalized.competitors.length) throw new Error("brand 与 competitors 必填");

  yield stage(0);
  checkBudget();

  yield stage(1);
  const research = await researchBrief(normalized);
  for (const source of research.sources) {
    yield { type: "research.source", title: source.title, url: source.url, authority: source.authority, date: source.date };
  }

  yield stage(2);
  const questions = await designQuestions(normalized, research);

  yield stage(3);
  const answered = [];
  for (const provider of ["deepseek", "glm"]) {
    for (let index = 0; index < questions.length; index += 1) {
      checkBudget();
      const text = await answerWith(provider, questions[index], normalized);
      answered.push({ provider, questionIndex: index, text });
      yield { type: "answer.progress", provider, done: index + 1, total: questions.length };
    }
  }

  yield stage(4);
  const judged = [];
  for (const answer of answered) {
    checkBudget();
    const verdict = await judgeAnswer({
      question: questions[answer.questionIndex],
      answer: answer.text,
      brief: normalized
    });
    judged.push({ questionIndex: answer.questionIndex, provider: answer.provider, entities: verdict.entities });
    yield { type: "judge.progress", done: judged.length, total: answered.length };
  }

  yield stage(5);
  const content = await composeReport({ brief: normalized, questions, answered, judged, research });
  const report = buildReport({ brief: normalized, reportId, questions, answered, judged, content, research });
  yield { type: "report", report };
}
