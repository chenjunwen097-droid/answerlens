"use strict";

const { callChat, parseJsonContent } = require("./model");
const { compact } = require("./entities");
const { cleanAssistantText } = require("../../app-core.js");

function observationId(item) {
  return `answer_${item.provider}_${item.questionIndex}`;
}

function evidenceCatalog(analyzed) {
  return (analyzed.observations || []).map((item) => ({
    id: observationId(item),
    provider: item.provider,
    model: item.model,
    questionIndex: item.questionIndex,
    question: item.question,
    answer: String(item.answer || "").slice(0, 1800),
    mentioned: item.mentioned,
    rank: item.rank,
    sentiment: item.sentiment,
    mentionQuote: item.mentionQuote || ""
  }));
}

function buildMessages(brief, analyzed, background) {
  return [
    {
      role: "system",
      content: [
        "你是证据总结 Agent。",
        "只能依据提供的 12 个真实回答进行总结和提出建议，不得编造参数、价格、评价、来源或用户行为。",
        "positioning 描述 AI 目前的认知现状，只写事实判断，禁止出现任何建议、行动或“应该”。每项不超过 60 个汉字，且必须能被证据目录支持：",
        "positioning.headline：一句话概括 AI 眼中的品牌定位。",
        "positioning.consensus：两个模型共同提到或认可的特点。",
        "positioning.differentiators：AI 在回答里如何区分你与竞品。",
        "positioning.differentiatorEvidenceIds：支撑 differentiators 的 evidenceId 列表，只能从证据目录选择；所选回答必须同时出现你的品牌和至少一个竞品，否则整项会被系统丢弃。",
        "suggestions 最多 3 条。每条必须分开输出 analysis 和 suggestion：analysis 只写这条建议所依据的关键观察，控制在 30-60 个汉字，不要复述整体定位；suggestion 是这条建议的主体，控制在 100-220 个汉字，说明做什么以及预期效果。",
        "suggestion 必须具体到能执行：包含 1-2 个具体措施，每个措施都要交代“在哪个渠道、对谁、做什么、产出什么”。",
        "suggestion 必须用换行把 2-3 个要点分开，每个要点以“· ”开头（真正的换行符，不要写在同一行）：前 1-2 行写具体措施，最后一行写预期效果或怎么验证有效（例如一周后用同一组问题复测看哪一项变化）。",
        "禁止用空话动词代替措施：加强、提升、优化、打造、注重、重视、进一步、持续关注、做好。写成“提升品牌专业形象”这种不给措施的句子会被系统判为不合格并退回重写。",
        "示例（好，注意换行）：\n· 在官网产品页新增一栏第三方实测数据，并把客服话术统一改成引用该数据。\n· 做一条 30 秒的对比视频投放到小红书。\n· 一周后用同一组问题复测，看“证据完整”是否上升。",
        "示例（会被退回）：加强品牌专业形象，持续优化用户口碑。",
        "background 是网络搜索结果，只能用来补充背景和素材：可以让建议对准竞品最近的动作、引用一个可核查的外部来源，或给验证方式一个参照。绝对不能改动任何分数、提及、名次或原句，也不能把 background 里的数字说成这个产品的表现。",
        "如果 background.sources 里有与竞品近期动作、品类现状或可核查素材直接相关的来源，就挑最相关的那一条建议引用它（backgroundId），并在 suggestion 里让读者明白这条来自网络；只有确实没有相关来源时才不引用。",
        "每条建议必须引用至少一个 evidenceId；evidenceId 只能从提供的证据目录选择。",
        "数据里的 conflicts 是系统用代码判定好的真实冲突，你无权新增、删除或改写冲突本身，也不得编造冲突。你只能为每条冲突写一句 summary：必须提到该冲突的 entityName，不超过 40 个汉字，且不得改变冲突双方的说法。",
        "conflictSummaries 必须原样带回对应冲突的 entityId 和 questionIndex。",
        "如果证据不足，不要补造建议，返回空 suggestions。",
        "只返回 JSON：{\"positioning\":{\"headline\":\"\",\"consensus\":\"\",\"differentiators\":\"\",\"differentiatorEvidenceIds\":[]},\"conflictSummaries\":[{\"entityId\":\"\",\"questionIndex\":0,\"summary\":\"\"}],\"suggestions\":[{\"title\":\"\",\"analysis\":\"\",\"suggestion\":\"\",\"evidenceIds\":[],\"backgroundId\":\"\"}]}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        brief,
        metrics: analyzed.metrics,
        questionStats: analyzed.questionStats,
        conflicts: analyzed.conflicts || [],
        evidence: evidenceCatalog(analyzed),
        background: {
          status: background?.status || "unavailable",
          sources: (background?.sources || []).map((source) => ({
            id: source.id,
            kind: source.kind,
            label: source.label,
            title: source.title,
            url: source.url,
            host: source.host,
            snippet: source.snippet
          }))
        }
      })
    }
  ];
}

function mentions(answer, name) {
  const key = compact(name);
  return Boolean(key) && compact(answer).includes(key);
}

// A suggestion is only useful if it names something to do and something to
// produce. These rules are deterministic so a vague suggestion is caught even
// when the model ignores the prompt.
const EMPTY_VERBS = ["加强", "提升", "优化", "打造", "注重", "重视", "进一步", "持续关注", "做好"];
const ACTION_VERBS =
  /新增|上线|发布|更新|制作|替换|改写|改成|联系|报名|投放|公开|回复|加进|做一版|出具|整理|补充|搭建|开通|拍摄|设计|邀请|对接|申报|申请|实测|复测|拆解|对比|访谈|调研|培训|跟进/;
const DELIVERABLES =
  /页面|图文|视频|对比表|参数表|FAQ|问答|话术|检测报告|报告|清单|教程|详情页|落地页|素材|脚本|榜单|案例|白皮书|流程|模板|看板|横幅|海报|长图|专栏|说明书|指南/;

const SUGGESTION_MIN_CHARS = 100;
const SUGGESTION_MAX_CHARS = 240;

// Models write the bulleted measures inline ("…。· 做视频。· 复测。") as often as
// they write them on separate lines. Normalise both shapes to one measure per
// line so the page renders them as a list.
function formatSuggestionText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const parts = text
    .split(/\s*[·•]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return text;
  // Every measure is an item, including the first one: a bare first line read
  // like a heading and the bullet list looked broken.
  return parts.map((part) => `· ${part}`).join("\n");
}

function suggestionProblems(text) {
  const value = String(text || "").trim();
  const length = value.replace(/\s+/g, "").length;
  const problems = [];
  if (length < SUGGESTION_MIN_CHARS) problems.push("too_short");
  if (length > SUGGESTION_MAX_CHARS) problems.push("too_long");
  const hasAction = ACTION_VERBS.test(value);
  if (!hasAction) problems.push("no_concrete_action");
  if (!DELIVERABLES.test(value)) problems.push("no_deliverable");
  const emptyHits = EMPTY_VERBS.filter((verb) => value.includes(verb)).length;
  if (emptyHits >= 2) problems.push("empty_verbs");
  return problems;
}

function normalizeInsights(value, analyzed, background) {
  const catalog = new Map(evidenceCatalog(analyzed).map((item) => [item.id, item]));
  // A recommendation may cite one search result, but only from the list the
  // server actually fetched: an id the model invented is dropped.
  const backgroundCatalog = new Map(
    (background?.sources || []).map((source) => [source.id, source])
  );
  const rawPositioning =
    value?.positioning && typeof value.positioning === "object"
      ? value.positioning
      : {};
  const clip = (input, limit) =>
    String(input || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  // Model text occasionally carries Markdown markers ("**重点**"); the report is
  // plain text, so strip them before anything reaches the page.
  const plain = (input, limit) =>
    cleanAssistantText(String(input || ""))
      // cleanAssistantText handles **bold**; single-asterisk emphasis still slips
      // through and shows up as literal asterisks on the report.
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
      .slice(0, limit);
  const plainLine = (input, limit) => plain(input, limit).replace(/\s*\n\s*/g, " ").trim();
  const legacySummary = clip(value?.positioningSummary, 1500);
  const positioning = {
    headline: plainLine(rawPositioning.headline, 160) || legacySummary,
    consensus: plainLine(rawPositioning.consensus, 200),
    differentiators: plainLine(rawPositioning.differentiators, 200),
    differentiatorEvidenceIds: []
  };
  const matrix = Array.isArray(analyzed?.matrix) ? analyzed.matrix : [];
  const brandName = matrix.find((item) => item.type === "brand")?.name || "";
  const competitorNames = matrix
    .filter((item) => item.type === "competitor")
    .map((item) => item.name)
    .filter(Boolean);
  // Differentiators must be anchored to answers that actually contrast the
  // brand with a competitor, otherwise the claim is unverifiable and dropped.
  const differentiatorEvidenceIds = (
    Array.isArray(rawPositioning.differentiatorEvidenceIds)
      ? rawPositioning.differentiatorEvidenceIds
      : []
  )
    .map((id) => String(id || ""))
    .filter((id) => {
      const source = catalog.get(id);
      if (!source) return false;
      return (
        mentions(source.answer, brandName) &&
        competitorNames.some((name) => mentions(source.answer, name))
      );
    });
  if (differentiatorEvidenceIds.length) {
    positioning.differentiatorEvidenceIds = differentiatorEvidenceIds.slice(0, 6);
  } else {
    positioning.differentiators = "";
  }

  // Conflicts themselves come from code, not from the model. The model may
  // only add a short summary, and it must name the conflicted entity.
  const conflicts = (Array.isArray(analyzed?.conflicts) ? analyzed.conflicts : []).map(
    (conflict) => {
      const raw = (Array.isArray(value?.conflictSummaries) ? value.conflictSummaries : []).find(
        (item) =>
          String(item?.entityId || "") === String(conflict.entityId) &&
          Number(item?.questionIndex) === Number(conflict.questionIndex)
      );
      const summary = clip(raw?.summary, 80);
      const verified = summary && mentions(summary, conflict.entityName) ? summary : "";
      return { ...conflict, summary: verified };
    }
  );
  positioning.conflicts = conflicts;
  // Coverage gaps are detected by code (one model never mentioned the entity),
  // so they pass through untouched — the model cannot add or remove them.
  positioning.coverageGaps = (
    Array.isArray(analyzed?.coverageGaps) ? analyzed.coverageGaps : []
  ).slice(0, 3);

  const positioningSummary = [
    positioning.headline,
    positioning.consensus,
    positioning.differentiators,
    ...conflicts.map((conflict) => {
      const detail =
        conflict.summary ||
        (conflict.sides || []).map((side) => side.quote).filter(Boolean).join("；");
      return `${conflict.entityName}：${detail}`;
    }),
    ...positioning.coverageGaps.map((gap) => {
      const missing = (gap.sides || []).filter((side) => !side.mentioned);
      const speaking = (gap.sides || []).filter((side) => side.mentioned);
      return `${gap.entityName}：${missing
        .map((side) => side.model || side.provider)
        .join("、")} 在第 ${gap.questionIndex + 1} 题没有提到，${
        speaking.map((side) => side.model || side.provider).join("、") || "另一个模型"
      } 给出了回答`;
    })
  ]
    .filter(Boolean)
    .join(" ");
  const suggestions = (Array.isArray(value?.suggestions) ? value.suggestions : [])
    .slice(0, 3)
    .map((item) => {
      const evidenceIds = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])
        .map((id) => String(id || ""))
        .filter((id) => catalog.has(id));
      if (!evidenceIds.length) return null;
      const source = backgroundCatalog.get(String(item?.backgroundId || "").trim()) || null;
      const suggestionText = formatSuggestionText(
        plain(item?.suggestion || item?.detail || "", 700)
      );
      return {
        title: plainLine(item?.title, 160),
        analysis: plainLine(item?.analysis || item?.detail, 500),
        suggestion: suggestionText,
        detail: suggestionText,
        impact: plainLine(item?.impact, 40),
        source: source
          ? {
              id: source.id,
              kind: source.kind,
              label: source.label,
              title: source.title,
              url: source.url,
              host: source.host
            }
          : null,
        evidenceIds,
        evidence: evidenceIds.map((id) => {
          const source = catalog.get(id);
          return {
            id,
            provider: source.provider,
            model: source.model,
            question: source.question,
            quote: plainLine(source.mentionQuote || source.answer.slice(0, 320), 320)
          };
        })
      };
    })
    .filter((item) => item && item.title && item.suggestion);
  return {
    positioning,
    positioningSummary,
    suggestions,
    status:
      positioning.headline && suggestions.length
        ? "ok"
        : positioning.headline
          ? "summary_only"
          : "unavailable"
  };
}

// Rewrites only the suggestions that failed the “concrete enough” rules.
// Whatever comes back is accepted, so a stubborn suggestion costs time but can
// never fail the report.
function suggestionRepairMessages({ brief, analyzed, background, items }) {
  return [
    {
      role: "system",
      content: [
        "你是证据总结 Agent。下面有几条行动建议太笼统，请只重写这几条，其余保持不变。",
        "重写要求：每条 100-220 个汉字；包含 1-2 个具体措施，每个措施都要交代“在哪个渠道、对谁、做什么、产出什么”；可以用“· ”分成 2-3 行，最后一行写预期效果或验证方式。",
        "禁止使用这些空话动词：加强、提升、优化、打造、注重、重视、进一步、持续关注、做好。",
        "只能依据证据目录和 background 写，不得编造参数、价格、评价或来源；background 只能用来补充背景与素材，不能把它的数字说成这个产品的表现。",
        "必须原样保留每条建议的 evidenceIds 和 backgroundId。",
        "只返回 JSON：{\"suggestions\":[{\"index\":0,\"title\":\"\",\"suggestion\":\"\",\"evidenceIds\":[],\"backgroundId\":\"\"}]}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        brief,
        evidence: evidenceCatalog(analyzed),
        background: {
          status: background?.status || "unavailable",
          sources: (background?.sources || []).map((source) => ({
            id: source.id,
            kind: source.kind,
            title: source.title,
            url: source.url,
            host: source.host,
            snippet: source.snippet
          }))
        },
        rewrite: items.map((item) => ({
          index: item.index,
          title: item.title,
          analysis: item.analysis,
          suggestion: item.suggestion,
          problems: item.problems,
          evidenceIds: item.evidenceIds,
          backgroundId: item.source?.id || ""
        }))
      })
    }
  ];
}

function applySuggestionRewrite(suggestions, parsed) {
  const rewritten = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  if (!rewritten.length) return suggestions;
  const byIndex = new Map(
    rewritten.map((item, position) => [
      Number.isInteger(Number(item?.index)) ? Number(item.index) : position,
      item
    ])
  );
  return suggestions.map((item, index) => {
    const replacement = byIndex.get(index);
    const text = formatSuggestionText(
      cleanAssistantText(String(replacement?.suggestion || "")).trim().slice(0, 700)
    );
    if (!text) return item;
    return {
      ...item,
      title:
        cleanAssistantText(String(replacement?.title || ""))
          .replace(/\s*\n\s*/g, " ")
          .trim()
          .slice(0, 160) || item.title,
      suggestion: text,
      detail: text
    };
  });
}

async function polishSuggestions(result, { brief, analyzed, background, callChatImpl }) {
  const flagged = (result.suggestions || [])
    .map((item, index) => ({
      index,
      title: item.title,
      analysis: item.analysis,
      suggestion: item.suggestion,
      evidenceIds: item.evidenceIds,
      source: item.source,
      problems: suggestionProblems(item.suggestion)
    }))
    .filter((item) => item.problems.length);
  if (!flagged.length) return result;
  try {
    const completion = await callChatImpl({
      provider: "deepseek",
      role: "utility",
      messages: suggestionRepairMessages({ brief, analyzed, background, items: flagged }),
      maxTokens: 1600,
      temperature: 0.3,
      timeoutMs: 30000,
      extraBody: { thinking: { type: "disabled" } },
      responseFormat: { type: "json_object" }
    });
    const suggestions = applySuggestionRewrite(
      result.suggestions,
      parseJsonContent(completion.message.content)
    );
    const stillVague = suggestions.filter(
      (item) => suggestionProblems(item.suggestion).length
    ).length;
    console.error(
      JSON.stringify({
        event: "insights_suggestion_polished",
        flagged: flagged.length,
        stillVague,
        problems: flagged.flatMap((item) => item.problems).slice(0, 6)
      })
    );
    return { ...result, suggestions };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "insights_suggestion_polish_failed",
        flagged: flagged.length,
        message: String(error?.message || "rewrite failed").slice(0, 200)
      })
    );
    return result;
  }
}

async function generateInsights(brief, analyzed, {
  callChatImpl = callChat,
  background = null
} = {}) {
  try {
    const completion = await callChatImpl({
      provider: "deepseek",
      role: "utility",
      // Three suggestions of up to 220 characters plus the positioning block:
      // the old ceiling truncated the JSON.
      maxTokens: 2600,
      temperature: 0.25,
      timeoutMs: 30000,
      extraBody: { thinking: { type: "disabled" } },
      responseFormat: { type: "json_object" },
      messages: buildMessages(brief, analyzed, background)
    });
    const result = normalizeInsights(
      parseJsonContent(completion.message.content),
      analyzed,
      background
    );
    if (!result.positioning.headline) throw new Error("empty positioning summary");
    const polished = await polishSuggestions(result, {
      brief,
      analyzed,
      background,
      callChatImpl
    });
    // Citation rate is the metric that tells us whether the background search
    // earned its keep: without a citation no globe icon is shown.
    console.error(
      JSON.stringify({
        event: "insights_completed",
        suggestions: polished.suggestions.length,
        withSource: polished.suggestions.filter((item) => item.source?.url).length,
        backgroundStatus: background?.status || "unavailable",
        backgroundSources: (background?.sources || []).length
      })
    );
    return polished;
  } catch (error) {
    return {
      positioning: {
        headline: "",
        consensus: "",
        differentiators: "",
        differentiatorEvidenceIds: [],
        conflicts: []
      },
      positioningSummary: "",
      suggestions: [],
      status: "unavailable",
      error: String(error?.message || "insights unavailable").slice(0, 200)
    };
  }
}

module.exports = {
  applySuggestionRewrite,
  buildMessages,
  evidenceCatalog,
  formatSuggestionText,
  generateInsights,
  normalizeInsights,
  observationId,
  polishSuggestions,
  suggestionProblems,
  suggestionRepairMessages
};
