"use strict";

const { callChat, parseJsonContent } = require("./model");
const { SCORE_DIMENSIONS } = require("../../app-core.js");

// One judge call per model answer. The judge never gives a holistic score: it
// answers a fixed list of yes/no items per dimension, so every point in the
// report can be traced back to a sentence it read. Numbers are computed here,
// never by the judge.
// The verdict is structured: five yes/no items, one rank, one tone, up to three
// claims and five one-line reasons per entity. Judging every entity in the
// brief made the JSON run past the token ceiling and come back truncated.
const JUDGE_MAX_OUTPUT_TOKENS = 2400;
const JUDGE_TIMEOUT_MS = 20000;

// Being listed as a recommendation and being the first choice are separate
// signals: the first is "in the running", the second is "picked". Splitting the
// old +2 into two +1s keeps the 0–100 scale while making 100 mean "first pick".
const PRESENCE_POINTS = {
  mentioned: 1,
  evaluated: 1,
  recommended: 1,
  firstChoice: 1,
  rejected: -2
};
const PRESENCE_MAX = 4;

const TONE_VALUES = { positive: 100, neutral: 60, mixed: 40, negative: 20 };
const RANK_VALUES = [100, 75, 50, 25];

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function presenceValue(items = {}) {
  const points =
    (items.mentioned ? PRESENCE_POINTS.mentioned : 0) +
    (items.evaluated ? PRESENCE_POINTS.evaluated : 0) +
    (items.recommended ? PRESENCE_POINTS.recommended : 0) +
    (items.firstChoice ? PRESENCE_POINTS.firstChoice : 0) +
    (items.rejected ? PRESENCE_POINTS.rejected : 0);
  return clampScore((100 * points) / PRESENCE_MAX);
}

function rankValue(rank) {
  const number = Number(rank);
  if (!Number.isInteger(number) || number < 1) return null;
  return RANK_VALUES[Math.min(number, RANK_VALUES.length) - 1];
}

function sentimentValue(tone) {
  const key = String(tone || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TONE_VALUES, key) ? TONE_VALUES[key] : null;
}

function evidenceValue(claims = []) {
  const specific = claims.filter((claim) => claim?.kind === "specific").length;
  const vague = claims.filter((claim) => claim?.kind === "vague").length;
  const total = specific + vague;
  if (!total) return null;
  return clampScore((100 * specific) / total);
}

function differentiationValue(items = {}) {
  const hits = [items.compared, items.condition].filter(Boolean).length +
    (items.difference ? 1 : 0);
  return clampScore((100 * hits) / 3);
}

// Applicable dimensions share the weight: a question that never ranked the
// entity, or an answer with no factual claim at all, must not be punished.
function weightedJudgedScore(dimensions, applicable) {
  const entries = SCORE_DIMENSIONS.filter(
    (item) => applicable[item.key] && Number.isFinite(dimensions[item.key])
  );
  if (!entries.length) return 0;
  const totalWeight = entries.reduce((sum, item) => sum + item.weight, 0);
  const weighted = entries.reduce(
    (sum, item) => sum + dimensions[item.key] * item.weight,
    0
  );
  return clampScore(weighted / totalWeight);
}

function clipText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function judgeJsonContract(entities) {
  const ids = entities.map((entity) => entity.id);
  const example = {
    entities: ids.reduce((result, id) => {
      result[id] = {
        presence: {
          mentioned: false,
          evaluated: false,
          recommended: false,
          firstChoice: false,
          rejected: false
        },
        rank: null,
        tone: "neutral",
        claims: [{ text: "", kind: "specific" }],
        differentiation: { compared: false, difference: false, condition: false },
        quote: "",
        reasons: {
          presence: "",
          rank: "",
          sentiment: "",
          evidence: "",
          differentiation: ""
        }
      };
      return result;
    }, {})
  };
  return JSON.stringify(example, null, 2);
}

function judgeSystemPrompt() {
  return [
    "你是 AI 推荐情报的评分员。你会看到一道买家问题、一个 AI 助手的回答，以及需要评分的对象（品牌与竞品）。",
    "你的任务不是给总分，而是对每个对象的固定判定项逐条回答：是或否，并且每条都要引用回答里的原句或写明依据。",
    "判定项说明：",
    "presence.mentioned：回答里是否出现了该对象的名称或产品名（包括简称、英文名）。",
    "presence.evaluated：回答是否对该对象给出了评价、描述或倾向，而不是只提了名字。",
    "presence.recommended：回答是否把它列入推荐或候选清单（不要求排第一）。",
    "presence.firstChoice：回答是否把它作为第一推荐或首选。只有回答明确表达“先选它 / 首选它 / 它更值得买”时才是 true；只是并列推荐时为 false。firstChoice 为 true 时必须同时给出 rank=1。",
    "presence.rejected：回答是否明确否定、劝退或把它当作反面例子。",
    "rank：回答对推荐顺序给出的名次，从 1 开始（1 = 第一个推荐）。只有回答确实表达了排序或优先级时才填数字；只是并列罗列、没有先后顺序时必须填 null。",
    "tone：回答对该对象的整体描述倾向，只能填 positive、neutral、mixed、negative 之一。mixed 表示同时有明显优点和缺点。",
    "claims：把回答中与该对象有关的事实主张拆成最多 3 条，每条不超过 40 个字，给 kind：specific（含参数、数字、场景、时间、来源等可核查细节）或 vague（只有形容词或结论）。纯主观偏好不算事实主张，不要列入。",
    "differentiation.compared：回答是否显式比较了该对象与至少一个竞品。",
    "differentiation.difference：比较是否指出了相对差异点（谁更某方面更好/更差）。",
    "differentiation.condition：回答是否给出了选择条件（什么场景下选它）。",
    "quote：最能代表该对象在这条回答里被如何描述的原文片段，不超过 60 个字，必须与回答原文一致，不要改写。",
    "reasons：每个维度一句不超过 30 个字的中文说明，指出你依据回答里的哪句话做出判定。",
    "严格只输出 JSON，不要输出任何解释性文字；宁可写得简短，也不要让 JSON 不完整。",
    "除非回答中确实提到该对象，否则 mentioned 为 false，并且 rank 为 null、claims 为空数组、tone 为 neutral。"
  ].join("\n");
}

function buildJudgeMessages({ question, answer, entities }) {
  const dictionary = entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    product: entity.product || "",
    role: entity.type === "brand" ? "品牌" : "竞品"
  }));
  return [
    { role: "system", content: judgeSystemPrompt() },
    {
      role: "user",
      content: [
        "买家问题：",
        question,
        "",
        "AI 助手的回答：",
        answer,
        "",
        "需要评分的对象：",
        dictionary
          .map((item) => `- id=${item.id}（${item.role}）${item.name}${item.product ? ` / ${item.product}` : ""}`)
          .join("\n"),
        "",
        "请按以下 JSON 结构输出（对象 id 必须与上面一致，值按你的判定填写）：",
        judgeJsonContract(dictionary)
      ].join("\n")
    }
  ];
}

const CLAIM_KINDS = new Set(["specific", "vague"]);
const TONES = new Set(["positive", "neutral", "mixed", "negative"]);

function normalizeClaims(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 5)
    .map((claim) => ({
      text: clipText(claim?.text, 160),
      kind: CLAIM_KINDS.has(String(claim?.kind || "").trim())
        ? String(claim.kind).trim()
        : "vague"
    }))
    .filter((claim) => claim.text);
}

// The judge's JSON is untrusted input: every field is re-derived here, a quote
// that does not appear in the answer is dropped, and a dimension the judge did
// not really decide is marked inapplicable instead of scoring zero.
function normalizeJudgment(raw, { answer = "", entities = [] } = {}) {
  const answerText = String(answer || "");
  const source = raw && typeof raw === "object" ? raw : {};
  const judged = source.entities && typeof source.entities === "object" ? source.entities : {};
  const result = { source: "model", entities: {} };
  for (const entity of entities) {
    const item = judged[entity.id];
    if (!item || typeof item !== "object") continue;
    const presence = item.presence && typeof item.presence === "object" ? item.presence : {};
    const items = {
      mentioned: Boolean(presence.mentioned),
      evaluated: Boolean(presence.evaluated),
      recommended: Boolean(presence.recommended),
      // "First choice" only counts when the judge also ranked it first: the two
      // answers have to agree, otherwise the claim is dropped instead of
      // inflating 推荐出现.
      firstChoice: Boolean(presence.firstChoice) && Number(item.rank) === 1,
      rejected: Boolean(presence.rejected)
    };
    const claims = normalizeClaims(item.claims);
    // A first choice is by definition also a recommendation.
    items.recommended = items.recommended || items.firstChoice;
    const tone = TONES.has(String(item.tone || "").trim().toLowerCase())
      ? String(item.tone).trim().toLowerCase()
      : null;
    const differences =
      item.differentiation && typeof item.differentiation === "object"
        ? item.differentiation
        : {};
    const differentiation = {
      compared: Boolean(differences.compared),
      difference: Boolean(differences.difference),
      condition: Boolean(differences.condition)
    };
    const rankNumber = Number(item.rank);
    const rank = Number.isInteger(rankNumber) && rankNumber >= 1 ? rankNumber : null;

    const notMentioned = !items.mentioned && presence.mentioned !== true;
    const dimensions = {
      presence: notMentioned ? 0 : presenceValue(items)
    };
    const applicable = { presence: true };

    if (notMentioned) {
      dimensions.rank = 0;
      dimensions.sentiment = 0;
      dimensions.evidence = 0;
      dimensions.differentiation = 0;
      applicable.rank = true;
      applicable.sentiment = true;
      applicable.evidence = true;
      applicable.differentiation = true;
    } else {
      const rankScore = rankValue(rank);
      dimensions.rank = rankScore === null ? 0 : rankScore;
      applicable.rank = rankScore !== null;
      const toneScore = sentimentValue(tone);
      dimensions.sentiment = toneScore === null ? 0 : toneScore;
      applicable.sentiment = toneScore !== null;
      const evidenceScore = evidenceValue(claims);
      dimensions.evidence = evidenceScore === null ? 0 : evidenceScore;
      applicable.evidence = evidenceScore !== null;
      dimensions.differentiation = differentiationValue(differentiation);
      applicable.differentiation = true;
    }

    const reasons = item.reasons && typeof item.reasons === "object" ? item.reasons : {};
    const quote = clipText(item.quote, 160);
    result.entities[entity.id] = {
      mentioned: items.mentioned,
      rejected: items.rejected,
      rank,
      tone,
      claims,
      differences: differentiation,
      items,
      dimensions,
      applicable,
      score: weightedJudgedScore(dimensions, applicable),
      reasons: {
        presence: clipText(reasons.presence, 120),
        rank: clipText(reasons.rank, 120),
        sentiment: clipText(reasons.sentiment, 120),
        evidence: clipText(reasons.evidence, 120),
        differentiation: clipText(reasons.differentiation, 120)
      },
      // A quote the answer does not contain is never shown as evidence.
      quote: quote && answerText.includes(quote) ? quote : ""
    };
  }
  if (!Object.keys(result.entities).length) throw new Error("judge returned no entities");
  return result;
}

async function judgeAnswer({
  question,
  answer,
  entities,
  callChatImpl = callChat,
  timeoutMs = JUDGE_TIMEOUT_MS
}) {
  const messages = buildJudgeMessages({ question, answer, entities });
  let lastError = null;
  // A verdict that cannot be parsed is worth one more try: an incomplete JSON is
  // the most common failure, and the reminder below fixes most of them.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const completion = await callChatImpl({
      provider: "deepseek",
      role: "judge",
      messages:
        attempt === 1
          ? messages
          : [
              ...messages,
              {
                role: "user",
                content:
                  "上一次输出不是完整合法的 JSON。请重新输出一份完整、可解析的 JSON，理由与主张写得更短，不要截断。"
              }
            ],
      maxTokens: JUDGE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      timeoutMs,
      responseFormat: { type: "json_object" },
      extraBody: { thinking: { type: "disabled" } }
    });
    try {
      const parsed = parseJsonContent(completion.message?.content);
      return {
        model: completion.model,
        attempts: attempt,
        // `raw` is what travels back through the browser; the report phase
        // re-normalises it against the real answer, so the stored numbers can
        // never be anything the judge did not actually say.
        raw: parsed,
        judgment: normalizeJudgment(parsed, { answer, entities })
      };
    } catch (error) {
      lastError = error;
      // Carried out to the route log so a truncated verdict is recognisable.
      lastError.contentLength = String(completion.message?.content || "").length;
      lastError.finishReason = String(completion.finishReason || "");
      lastError.attempt = attempt;
    }
  }
  throw lastError;
}

module.exports = {
  buildJudgeMessages,
  differentiationValue,
  evidenceValue,
  judgeAnswer,
  judgeSystemPrompt,
  normalizeJudgment,
  presenceValue,
  rankValue,
  sentimentValue,
  weightedJudgedScore
};
