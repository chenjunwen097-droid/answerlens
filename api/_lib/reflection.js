"use strict";

const { callChat, parseJsonContent } = require("./model");

const ISSUE_TYPES = new Set([
  "unsupported_claim",
  "wrong_metric",
  "irrelevant_advice",
  "missing_evidence"
]);

function normalizeReflection(value) {
  const input = value && typeof value === "object" ? value : {};
  const issues = (Array.isArray(input.issues) ? input.issues : [])
    .map((item) => ({
      type: ISSUE_TYPES.has(item?.type) ? item.type : "unsupported_claim",
      message: String(item?.message || "").slice(0, 500),
      evidenceId: String(item?.evidenceId || "").slice(0, 120)
    }))
    .filter((item) => item.message);
  const revised = input.revised && typeof input.revised === "object" ? input.revised : null;
  return {
    verdict: input.verdict === "pass" && issues.length === 0 ? "pass" : "revise",
    issues,
    revised
  };
}

function applyReflection(insights, reflection) {
  const basePositioning =
    insights.positioning && typeof insights.positioning === "object"
      ? insights.positioning
      : {};
  const baseConflicts = Array.isArray(basePositioning.conflicts)
    ? basePositioning.conflicts
    : [];
  const next = {
    ...insights,
    positioning: {
      ...basePositioning,
      headline: String(basePositioning.headline || ""),
      consensus: String(basePositioning.consensus || ""),
      differentiators: String(basePositioning.differentiators || ""),
      // Conflicts are produced and validated from real answers, never by the
      // critic, so a sparse revision can not erase or invent them.
      conflicts: baseConflicts
    },
    positioningSummary: String(insights.positioningSummary || ""),
    suggestions: Array.isArray(insights.suggestions) ? insights.suggestions : []
  };
  if (reflection?.verdict !== "revise" || !reflection.revised) return next;
  const revisedPositioning = reflection.revised.positioning;
  const revisedSummary = String(reflection.revised.positioningSummary || "").trim();
  if (
    revisedPositioning &&
    typeof revisedPositioning === "object" &&
    !Array.isArray(revisedPositioning)
  ) {
    // Only a non-empty revision may replace a field, so a sparse critic
    // response can never wipe the verified draft.
    ["headline", "consensus", "differentiators"].forEach((key) => {
      const revised = String(revisedPositioning[key] || "").trim();
      if (revised) next.positioning[key] = revised.slice(0, key === "headline" ? 160 : 200);
    });
  } else if (revisedSummary) {
    next.positioning.headline = revisedSummary.slice(0, 1500);
  }
  const composedSummary = [
    next.positioning.headline,
    next.positioning.consensus,
    next.positioning.differentiators,
    ...next.positioning.conflicts.map((conflict) => {
      const detail =
        conflict.summary ||
        (conflict.sides || []).map((side) => side.quote).filter(Boolean).join("；");
      return `${conflict.entityName}：${detail}`;
    })
  ]
    .filter(Boolean)
    .join(" ");
  next.positioningSummary = composedSummary || next.positioningSummary;
  if (
    Array.isArray(reflection.revised.suggestions) &&
    reflection.revised.suggestions.length
  ) {
    next.suggestions = reflection.revised.suggestions.slice(0, 3).map((item) => ({
      title: String(item?.title || "").slice(0, 160),
      analysis: String(item?.analysis || "").slice(0, 500),
      suggestion: String(item?.suggestion || item?.detail || "").slice(0, 700),
      detail: String(item?.suggestion || item?.detail || "").slice(0, 700),
      impact: String(item?.impact || "中影响").slice(0, 40),
      evidenceIds: Array.isArray(item?.evidenceIds)
        ? item.evidenceIds.map((id) => String(id || "")).slice(0, 6)
        : [],
      evidence: Array.isArray(item?.evidence) ? item.evidence.slice(0, 6) : []
    }));
  }
  return next;
}

async function reflectInsights(brief, analyzed, insights, {
  callChatImpl = callChat
} = {}) {
  const evidence = {
    brief,
    metrics: analyzed.metrics,
    questionStats: analyzed.questionStats,
    observations: analyzed.observations.map((item) => ({
      model: item.model,
      questionIndex: item.questionIndex,
      question: item.question,
      answer: item.answer.slice(0, 1200),
      mentioned: item.mentioned,
      rank: item.rank,
      sentiment: item.sentiment
    }))
  };
  try {
    const completion = await callChatImpl({
      provider: "deepseek",
      role: "reflection",
      maxTokens: 1400,
      temperature: 0.1,
      timeoutMs: 30000,
      extraBody: { thinking: { type: "disabled" } },
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是事实审计 Critic。逐条检查 headline、consensus、differentiators 和建议是否能被原始回答证据支持，尤其要检查 differentiators 的每句话是否真的出自所引用的回答；如果某句话在引用回答里找不到依据，必须清空该字段。conflicts 由代码根据真实回答判定，不在你的职责内，禁止改写或新增。不得新增事实、引用或数据。只返回 JSON：{\"verdict\":\"pass|revise\",\"issues\":[{\"type\":\"unsupported_claim|wrong_metric|irrelevant_advice|missing_evidence\",\"message\":\"\",\"evidenceId\":\"\"}],\"revised\":{\"positioning\":{\"headline\":\"\",\"consensus\":\"\",\"differentiators\":\"\"},\"suggestions\":[{\"title\":\"\",\"analysis\":\"\",\"suggestion\":\"\",\"evidenceIds\":[]}]}}。如果存在无证据内容，verdict 必须为 revise；revised 中只保留有证据支持的内容，无法确认的字段必须返回空字符串，不要保留原文。"
        },
        {
          role: "user",
          content: JSON.stringify({
            evidence,
            draft: {
              positioning: insights.positioning,
              suggestions: insights.suggestions
            }
          })
        }
      ]
    });
    const parsed = parseJsonContent(completion.message.content);
    return {
      status: "checked",
      ...normalizeReflection(parsed)
    };
  } catch (error) {
    return {
      status: "unavailable",
      verdict: "unchecked",
      issues: [],
      revised: null,
      error: String(error?.message || "reflection failed").slice(0, 200)
    };
  }
}

module.exports = {
  ISSUE_TYPES,
  applyReflection,
  normalizeReflection,
  reflectInsights
};
