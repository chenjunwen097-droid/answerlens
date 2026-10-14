"use strict";

const {
  analyzeObservations,
} = require("./_lib/analysis");
const {
  TESTED_PROVIDERS,
  cleanAnswerInput,
  cleanBaseInput,
  cleanJudgeInput,
  cleanReportInput
} = require("./_lib/analyze-input");
const { callChat, errorDetails } = require("./_lib/model");
const { generateQuestions } = require("./_lib/questions");
const { applyReflection, reflectInsights } = require("./_lib/reflection");
const { generateInsights } = require("./_lib/insights");
const { judgeAnswer, normalizeJudgment } = require("./_lib/judge");
const { buildEntityDictionary, findEntityMentionsForDictionary } = require("./_lib/entities");
const { collectBackground } = require("./_lib/background");

async function generateAnswer(provider, question) {
  try {
    const completion = await callChat({
      provider,
      role: "tested",
      maxTokens: 800,
      temperature: 0.6,
      timeoutMs: 25000,
      extraBody: { thinking: { type: "disabled" } },
      messages: [
        {
          role: "system",
          content:
            "你是正在帮助买家做产品选型的 AI。先完成必要判断，再只输出最终答案，不要展示思考过程。最终可见答案控制在 100 个汉字以内，最多 2 段，必须围绕用户问题给出完整结论，不要提及自己是模型。"
        },
        { role: "user", content: question }
      ]
    });
    const answer = String(completion.message.content || "").trim();
    if (!answer) {
      const emptyError = new Error(`${provider} returned an empty answer`);
      emptyError.code = "answer_empty";
      emptyError.finishReason = String(completion.message.finish_reason || "");
      emptyError.contentLength = String(completion.message.content || "").length;
      emptyError.hasReasoning = Boolean(completion.message.reasoning_content);
      emptyError.usage = completion.usage || null;
      throw emptyError;
    }
    return {
      provider,
      model: completion.model,
      answer,
      attempts: 1
    };
  } catch (error) {
    if (!error.code) error.code = "answer_generation_failed";
    error.provider = provider;
    throw error;
  }
}

async function createReport({
  brand,
  brandProduct,
  competitors,
  competitorProducts,
  dimensions,
  other,
  brief,
  questions,
  responses,
  judgments,
  searchImpl,
  requestId
}) {
  const analyzed = analyzeObservations({
    brand,
    brandProduct,
    competitors,
    competitorProducts,
    questions,
    responses,
    judgments: normalizeJudgments(judgments, { questions, responses, brief, requestId })
  });
  // Background search only feeds the recommendations module, and a failure here
  // degrades those recommendations instead of failing the report.
  const background = await collectBackground(brief, { searchImpl: searchImpl });
  logEvent({
    event: "analysis_background_completed",
    requestId,
    status: background.status,
    sourceCount: background.sources.length,
    durationMs: background.durationMs,
    queries: background.queries.map((item) => ({
      kind: item.kind,
      status: item.status,
      resultCount: item.resultCount
    }))
  });
  const draftInsights = await generateInsights(brief, analyzed, { background });
  const reflection = await reflectInsights(brief, analyzed, draftInsights);
  const insights = applyReflection(draftInsights, reflection);
  logEvent({
    event: "analysis_insights_completed",
    requestId,
    draftStatus: draftInsights.status,
    finalStatus: insights.status || draftInsights.status,
    positioningLength: insights.positioningSummary.length,
    suggestionCount: insights.suggestions.length
  });
  logEvent({
    event: "analysis_reflection_completed",
    requestId,
    status: reflection.status,
    verdict: reflection.verdict,
    issueCount: reflection.issues.length
  });
  return {
    ...analyzed,
    ...insights,
    id: requestId || `report_${Date.now().toString(36)}`,
    brand,
    brandProduct,
    competitors,
    competitorProducts,
    dimensions,
    other,
    brief,
    reflection: {
      status: reflection.status,
      verdict: reflection.verdict,
      issues: reflection.issues
    },
    isReal: true,
    completedAt: new Date().toISOString(),
    judge: judgedSummary(analyzed),
    trace: [
      {
        id: "questions",
        label: `提交 ${questions.length} 个已确认买家问题`,
        detail: "已使用用户确认的问题进行模型测试"
      },
      ...responses.map((response) => ({
        id: response.provider,
        label: `询问 ${response.model} · ${questions.length}/${questions.length}`,
        detail: `${brand} 的回答信号已提取`
      })),
      {
        id: "judge",
        label: `按判定项核对 ${judgedSummary(analyzed).judgedAnswers}/${judgedSummary(analyzed).totalAnswers} 条回答`,
        detail: "每条得分都能追溯到回答原文"
      },
      {
        id: "background",
        label: background.sources.length
          ? `联网补充 ${background.sources.length} 条外部素材`
          : "联网补充外部素材",
        detail: background.sources.length
          ? "仅用于行动建议的背景与来源"
          : "本次未取到可用素材，行动建议不含外部来源"
      },
      { id: "extract", label: "提取推荐证据与产品理解", detail: "已归一化两个 AI 的回答证据" },
      {
        id: "score",
        label: `生成 AI 推荐表现 ${analyzed.score}/100`,
        detail: "由 6 个决策问题的推荐表现平均计算"
      }
    ]
  };
}

function logEvent(payload) {
  console.log(JSON.stringify(payload));
}

// How much of the report was scored from the judge's itemised verdicts versus
// the deterministic fallback. Surfaced so the page can be honest about it.
function judgedSummary(analyzed) {
  const observations = Array.isArray(analyzed?.observations) ? analyzed.observations : [];
  const judgedAnswers = observations.filter((item) => item.judged).length;
  return {
    judgedAnswers,
    ruleAnswers: observations.length - judgedAnswers,
    totalAnswers: observations.length
  };
}

function entitiesFromBrief(brief = {}) {
  return buildEntityDictionary({
    brand: brief.brand,
    brandProduct: brief.brandProduct,
    competitors: (brief.competitors || []).map((item) => ({
      name: item.name,
      product: item.product
    }))
  });
}

// The browser only stores what the judge phase returned; every dimension value
// is recomputed here from the judge's own yes/no answers, keyed to the real
// answer text. A judgment that cannot be re-derived is dropped, and that answer
// falls back to rule-based scoring instead of inventing a number.
function normalizeJudgments(judgments, { questions, responses, brief, requestId }) {
  if (!judgments || typeof judgments !== "object") return {};
  const entities = entitiesFromBrief(brief);
  const result = {};
  Object.entries(judgments).forEach(([key, raw]) => {
    const [provider, indexText] = String(key).split(":");
    const questionIndex = Number(indexText);
    const response = (responses || []).find((item) => item.provider === provider);
    const answer = String(response?.answers?.[questionIndex] || "");
    if (!answer || !Number.isInteger(questionIndex)) return;
    try {
      result[key] = normalizeJudgment(raw, { answer, entities });
    } catch (error) {
      logEvent({
        event: "analysis_judgment_rejected",
        requestId,
        provider,
        questionIndex,
        question: String(questions?.[questionIndex] || "").slice(0, 120),
        ...errorDetails(error)
      });
    }
  });
  return result;
}

function sendFailure(res, error) {
  if (error?.code === "invalid_analysis_input") {
    res.status(400).json({ ok: false, error: error.code, message: error.message });
    return;
  }
  if (error?.code === "question_generation_failed") {
    res.status(502).json({
      ok: false,
      error: error.code,
      message: "问题生成失败，请重新生成。"
    });
    return;
  }
  if (error?.code === "answer_generation_failed") {
    res.status(502).json({
      ok: false,
      error: error.code,
      message: "模型回答超时或请求过于频繁，本次未扣除额度。请稍后重试。"
    });
    return;
  }
  const configured = error.code !== "model_not_configured";
  res.status(configured ? 502 : 503).json({
    ok: false,
    error: configured ? "analysis_failed" : "model_not_configured",
    message: configured
      ? "分析服务暂时不可用，本次未扣除额度。"
      : "模型服务尚未配置，无法生成真实报告。"
  });
}

async function runLegacyAnalysis(body, res) {
  const base = cleanBaseInput(body);
  logEvent({ event: "analysis_started", ...base, mode: "full" });
  const questionResult = await generateQuestions(base.brief);
  const questions = questionResult.questions.map((item) => item.text);
  const responses = await Promise.all(
    TESTED_PROVIDERS.map(async (provider) => {
      const completions = await Promise.all(
        questions.map((question) => generateAnswer(provider, question))
      );
      return {
        provider,
        model: [...new Set(completions.map((item) => item.model))].join(" / "),
        answers: completions.map((item) => item.answer)
      };
    })
  );
  const report = await createReport({ ...base, questions, responses });
  logEvent({
    event: "analysis_completed",
    requestId: base.requestId,
    reportId: report.id,
    score: report.score
  });
  res.status(200).json({ ok: true, report });
}

const handler = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const body = req.body || {};
  const phase = String(body.phase || "").trim();
  try {
    if (!phase) {
      await runLegacyAnalysis(body, res);
      return;
    }

    if (phase === "questions") {
      const base = cleanBaseInput(body);
      logEvent({ event: "analysis_questions_started", requestId: base.requestId, brand: base.brand });
      // Deliberately offline: question design only uses the user's own input,
      // so a slow or blocked search provider cannot delay or fail this step.
      const questionResult = await generateQuestions(base.brief);
      const questions = questionResult.questions.map((item) => item.text);
      logEvent({
        event: "analysis_questions_completed",
        requestId: base.requestId,
        researchStatus: "disabled",
        evidenceCount: 0,
        attempts: questionResult.attempts,
        provider: questionResult.provider
      });
      res.status(200).json({
        ok: true,
        phase,
        questions,
        questionMeta: questionResult.questions,
        questionAttempts: questionResult.attempts,
        researchStatus: "disabled",
        sourceCount: 0
      });
      return;
    }

    if (phase === "answer") {
      const input = cleanAnswerInput(body);
      const startedAt = Date.now();
      let result;
      try {
        result = await generateAnswer(input.provider, input.question);
      } catch (error) {
        logEvent({
          event: "analysis_answer_failed",
          requestId: input.requestId,
          provider: input.provider,
          questionIndex: input.questionIndex,
          durationMs: Date.now() - startedAt,
          finishReason: error.finishReason || "",
          contentLength: error.contentLength ?? null,
          hasReasoning: Boolean(error.hasReasoning),
          usage: error.usage || null,
          ...errorDetails(error)
        });
        throw error;
      }
      logEvent({
        event: "analysis_answer_completed",
        requestId: input.requestId,
        provider: input.provider,
        model: result.model,
        thinkingDisabled: true,
        attempts: result.attempts,
        questionIndex: input.questionIndex,
        durationMs: Date.now() - startedAt
      });
      res.status(200).json({
        ok: true,
        phase,
        provider: input.provider,
        questionIndex: input.questionIndex,
        model: result.model,
        thinkingDisabled: true,
        answer: result.answer,
        attempts: result.attempts
      });
      return;
    }

    if (phase === "judge") {
      const input = cleanJudgeInput(body);
      const startedAt = Date.now();
      // Only the entities this question actually asks about: judging the rest
      // wasted output tokens and pushed the JSON past the ceiling.
      const dictionary = entitiesFromBrief(input.brief);
      const asked = new Set(
        findEntityMentionsForDictionary(input.question, dictionary).map(
          (item) => item.entityId
        )
      );
      const entities = dictionary.filter((item) => asked.has(item.id));
      try {
        const result = await judgeAnswer({
          question: input.question,
          answer: input.answer,
          entities: entities.length ? entities : dictionary
        });
        logEvent({
          event: "analysis_judge_completed",
          requestId: input.requestId,
          provider: input.provider,
          questionIndex: input.questionIndex,
          model: result.model,
          entities: (entities.length ? entities : dictionary).map((item) => item.id),
          attempts: result.attempts,
          durationMs: Date.now() - startedAt
        });
        res.status(200).json({
          ok: true,
          phase,
          provider: input.provider,
          questionIndex: input.questionIndex,
          model: result.model,
          judgment: result.raw
        });
      } catch (error) {
        // A failed judgment never fails the report: that one answer falls back
        // to rule-based scoring and the report says so.
        logEvent({
          event: "analysis_judge_failed",
          requestId: input.requestId,
          provider: input.provider,
          questionIndex: input.questionIndex,
          entities: entities.map((item) => item.id),
          durationMs: Date.now() - startedAt,
          contentLength: error.contentLength ?? null,
          finishReason: error.finishReason || "",
          judgeAttempts: error.attempt || 1,
          ...errorDetails(error)
        });
        res.status(200).json({
          ok: true,
          phase,
          provider: input.provider,
          questionIndex: input.questionIndex,
          judgment: null,
          degraded: true
        });
      }
      return;
    }

    if (phase === "report") {
      const input = cleanReportInput(body);
      logEvent({
        event: "analysis_report_started",
        requestId: input.requestId,
        brand: input.brand
      });
      const report = await createReport(input);
      logEvent({
        event: "analysis_completed",
        requestId: input.requestId,
        reportId: report.id,
        score: report.score
      });
      res.status(200).json({ ok: true, phase, report });
      return;
    }

    res.status(400).json({ ok: false, error: "invalid_analysis_phase" });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "analysis_failed",
        phase: phase || "full",
        requestId: String(body.requestId || "").slice(0, 80),
        ...errorDetails(error)
      })
    );
    sendFailure(res, error);
  }
};

// Exposed for tests: the report phase re-derives every judged number from the
// verdicts the browser carried back.
handler.normalizeJudgments = normalizeJudgments;
handler.judgedSummary = judgedSummary;

module.exports = handler;
