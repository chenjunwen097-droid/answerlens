"use strict";

const { callChat, parseJsonContent } = require("./model");
const { QUESTION_COUNT } = require("./analyze-input");
const core = require("../../app-core.js");

// Question generation is the step users cannot work around, so it gets a hard
// time budget and a hedged, multi-provider strategy instead of a single call.
const PROVIDERS = ["deepseek", "glm"];
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 18000;
const TOTAL_BUDGET_MS = 45000;
const MIN_ATTEMPT_MS = 5000;
const BACKOFF_MS = [1500, 4000];
// Each competitor must be asked about at least this often to be scored fairly.
const MIN_COMPETITOR_COVERAGE = core.MIN_COMPETITOR_COVERAGE;

const THINKING_DISABLED = { thinking: { type: "disabled" } };

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  if (!error) return true;
  if (error.code === "model_timeout") return true;
  const status = Number(error.status);
  if (Number.isFinite(status)) return status === 429 || status >= 500;
  // Our own validation failures are retried with a repaired prompt instead.
  if (error.code === "question_validation_failed") return false;
  // No HTTP status means the request never completed (DNS, reset, abort).
  return true;
}

function backoffFor(attemptIndex, random = Math.random) {
  const base = BACKOFF_MS[Math.min(attemptIndex, BACKOFF_MS.length - 1)];
  return Math.round(base * (0.7 + random() * 0.6));
}

// Question generation is intentionally offline: it only uses the user's own
// input, so a slow or blocked search provider can never delay or fail it.
function buildMessages(brief, validationIssues = []) {
  return [
    {
      role: "system",
      content: [
        "你是真实买家问题设计 Agent。",
        "用户输入可能来自汽车、手机、软件、消费品或其他行业，绝不能预设 B2B SaaS。",
        "只能依据用户给出的品牌、产品型号、竞品和检测方向出题。",
        "不要编造具体参数、价格、销量、评价或来源；不确定的细节一律不要写进问题，问题要保持在模型能凭常识回答的层面。",
        "6 个问题必须真正围绕用户给出的产品型号、竞品和检测方向，而不是替换品牌名的统一模板。",
        "问题要自然、具体、覆盖不同购买意图：直接比较、核心指标、真实场景、价格或使用成本、风险限制、长期口碑。",
        "6 个问题按固定配方出：2 题一句话直接对比；2 题带真实场景（人群、时间场合、预算、地点与等待、健康忌口、决策阶段等，像真人说话，先交代自己的处境）；1 题针对决策阶段（第一次买、想换品牌、复购、送礼）；1 题要求 AI 给出推荐顺序或只能选一个。",
        "检测方向是“必须覆盖”的约束，不是每道题的措辞来源：每个检测方向至少出现在 2 题，最多出现在 3 题。",
        "6 题不要用相同的开头和句式，同一类场景最多出现在 2 题里。",
        "每条问题必须同时包含用户的品牌和至少一个竞品，缺一不可；有型号时优先使用型号；有检测方向时必须体现该方向。",
        `每个竞品必须至少出现在 ${MIN_COMPETITOR_COVERAGE} 个问题中，否则该竞品无法被公平评分。`,
        "本步骤不联网，因此不要假装引用了任何外部资料或数据。",
        "只返回 JSON：{\"questions\":[{\"text\":\"\",\"dimension\":\"\",\"entities\":[],\"rationale\":\"\"}]}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        brief,
        questionCount: QUESTION_COUNT,
        minCompetitorCoverage: MIN_COMPETITOR_COVERAGE,
        recipe: core.QUESTION_RECIPE,
        sceneDimensions: core.SCENE_DIMENSIONS.map((item) => item.label),
        ...(validationIssues.length
          ? { previousValidationIssues: validationIssues }
          : {})
      })
    }
  ];
}

function normalizeQuestions(value) {
  const raw = Array.isArray(value?.questions) ? value.questions : [];
  return raw
    .map((item) =>
      typeof item === "string"
        ? {
            text: item.trim(),
            dimension: "",
            entities: [],
            rationale: ""
          }
        : {
            text: String(item?.text || "").trim(),
            dimension: String(item?.dimension || "").trim().slice(0, 60),
            entities: Array.isArray(item?.entities)
              ? item.entities.map((entity) => String(entity || "").trim()).slice(0, 5)
              : [],
            rationale: String(item?.rationale || "").trim().slice(0, 300)
          }
    )
    .filter((item) => item.text)
    .slice(0, QUESTION_COUNT);
}

// Question quality rules live in app-core so the generator and the in-page
// editor can never drift apart.
function questionProblems(question, brief) {
  return core.questionProblems(question?.text, brief);
}

function competitorCoverage(questions, brief) {
  const coverage = core.questionCoverage(
    brief,
    questions.map((question) => question?.text || "")
  );
  return coverage.entities
    .filter((entity) => entity.type === "competitor")
    .map((entity) => ({ name: entity.name, count: entity.count }));
}

function validateQuestions(questions, brief) {
  const issues = [];
  if (questions.length !== QUESTION_COUNT) {
    issues.push(`expected_${QUESTION_COUNT}_questions`);
  }
  const broken = questions.filter(
    (question) => questionProblems(question, brief).length > 0
  );
  if (broken.length) {
    issues.push(`incomplete_comparison_in_${broken.length}_questions`);
  }
  // Fair scoring needs every competitor asked about often enough to be scored.
  competitorCoverage(questions, brief).forEach((item) => {
    if (item.count < MIN_COMPETITOR_COVERAGE) {
      issues.push(`competitor_coverage_low:${item.name}:${item.count}`);
    }
  });
  const dimensions = brief.dimensions || [];
  if (
    dimensions.length &&
    !questions.some((question) =>
      dimensions.some((dimension) => question.text.includes(dimension))
    )
  ) {
    issues.push("missing_requested_dimension");
  }
  return issues;
}

function repairMessages(brief, questions, invalidIndexes) {
  const keep = questions
    .map((item, index) => ({ index, ...item }))
    .filter((item) => !invalidIndexes.includes(item.index));
  return [
    {
      role: "system",
      content: [
        "你是真实买家问题设计 Agent。",
        "下面这批问题中有几道不合格，请只重写不合格的那几道，其余问题保持原样。",
        "每条问题必须同时包含用户的品牌和至少一个竞品；有检测方向时必须体现该方向。",
        "重写后整批仍要满足配方：2 题精简对比、2 题带真实场景、1 题决策阶段、1 题要求 AI 排序；至少 2 题带真实场景。",
        "整批不要出现 3 题以上使用相同开头或同一类场景；同一检测方向最多出现在 3 题里。",
        `重写后仍要满足：每个竞品至少出现在 ${MIN_COMPETITOR_COVERAGE} 个问题中。`,
        "不得编造参数、价格、评价或来源。",
        "只返回 JSON：{\"questions\":[{\"index\":0,\"text\":\"\",\"dimension\":\"\",\"entities\":[],\"rationale\":\"\"}]}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        brief,
        rewriteIndexes: invalidIndexes,
        minCompetitorCoverage: MIN_COMPETITOR_COVERAGE,
        sceneDimensions: core.SCENE_DIMENSIONS.map((item) => item.label),
        keepQuestions: keep
      })
    }
  ];
}

function mergeRepaired(questions, parsed) {
  const patched = [...questions];
  const raw = Array.isArray(parsed?.questions) ? parsed.questions : [];
  raw.forEach((item, position) => {
    const index = Number.isInteger(Number(item?.index))
      ? Number(item.index)
      : position;
    if (index < 0 || index >= patched.length) return;
    const text = String(item?.text || item?.trim?.() || "").trim();
    if (!text) return;
    patched[index] = {
      text,
      dimension: String(item?.dimension || patched[index]?.dimension || "")
        .trim()
        .slice(0, 60),
      entities: Array.isArray(item?.entities)
        ? item.entities.map((entity) => String(entity || "").trim()).slice(0, 5)
        : patched[index]?.entities || [],
      rationale: String(item?.rationale || patched[index]?.rationale || "")
        .trim()
        .slice(0, 300)
    };
  });
  return patched;
}

// `research` is accepted but unused: question generation is offline by design.
async function generateQuestions(brief, research, {
  callChatImpl = callChat,
  sleep = defaultSleep,
  now = Date.now,
  totalBudgetMs = TOTAL_BUDGET_MS,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  random = Math.random
} = {}) {
  const startedAt = now();
  const deadline = startedAt + totalBudgetMs;
  const remaining = () => deadline - now();
  const budgetForAttempt = () =>
    Math.max(MIN_ATTEMPT_MS, Math.min(attemptTimeoutMs, remaining()));
  const logAttempt = (payload) =>
    console.error(JSON.stringify({ event: "question_generation_attempt", ...payload }));

  let messages = buildMessages(brief);
  let lastError = null;
  let attempts = 0;

  async function runOnce(provider, msgs) {
    const completion = await callChatImpl({
      provider,
      role: "utility",
      messages: msgs,
      maxTokens: 1400,
      temperature: 0.5,
      timeoutMs: budgetForAttempt(),
      extraBody: THINKING_DISABLED,
      responseFormat: { type: "json_object" }
    });
    const questions = normalizeQuestions(parseJsonContent(completion.message.content));
    const issues = validateQuestions(questions, brief);
    if (issues.length) {
      const error = new Error(`question_validation_failed:${issues.join(",")}`);
      error.code = "question_validation_failed";
      error.questions = questions;
      error.issues = issues;
      error.provider = provider;
      // Truncation shows up here first: an unfinished JSON body is the most
      // common reason a batch validates badly.
      error.finishReason = String(completion.finishReason || "");
      error.contentLength = String(completion.message.content || "").length;
      throw error;
    }
    return {
      questions,
      model: completion.model,
      provider,
      finishReason: String(completion.finishReason || ""),
      // Diversity problems are advisory: they trigger a rewrite of the worst
      // offenders but never fail the batch.
      batchProblems: core.questionBatchProblems(
        questions.map((question) => question.text),
        brief
      )
    };
  }

  // Rewrites only the flagged questions. Returns null when the rewritten batch
  // still breaks the hard rules, so the caller can fall back to what it had.
  async function rewriteQuestions(provider, questions, indexes) {
    const completion = await callChatImpl({
      provider,
      role: "utility",
      messages: repairMessages(brief, questions, indexes),
      maxTokens: 1100,
      temperature: 0.4,
      timeoutMs: budgetForAttempt(),
      extraBody: THINKING_DISABLED,
      responseFormat: { type: "json_object" }
    });
    const repaired = mergeRepaired(
      questions,
      parseJsonContent(completion.message.content)
    );
    if (validateQuestions(repaired, brief).length) return null;
    return { questions: repaired, model: completion.model, provider };
  }

  // Hedged first attempt: race both providers and keep the first valid answer,
  // so one slow or unavailable provider cannot fail the whole step.
  async function hedge(msgs) {
    const racers = PROVIDERS.map((provider) => runOnce(provider, msgs));
    racers.forEach((racer) => racer.catch(() => {}));
    try {
      return await Promise.any(racers);
    } catch (aggregate) {
      const errors = aggregate?.errors || [];
      const validation = errors.find(
        (error) => error?.code === "question_validation_failed"
      );
      throw validation || errors[0] || new Error("question_generation_failed");
    }
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (remaining() < MIN_ATTEMPT_MS) {
      lastError = lastError || new Error("question_generation_budget_exhausted");
      break;
    }
    attempts += 1;
    const hedged = attempt === 0;
    const provider = hedged ? "hedge" : PROVIDERS[attempt % PROVIDERS.length];
    const attemptStartedAt = now();
    try {
      const result = hedged
        ? await hedge(messages)
        : await runOnce(provider, messages);
      // The batch passed the hard rules; if it is still repetitive, rewrite the
      // worst offenders once. Whatever comes back is accepted, so a stubborn
      // batch can only cost time, never the whole analysis.
      let questions = result.questions;
      let softIssues = result.batchProblems?.issues || [];
      if (softIssues.length && result.batchProblems.rewriteIndexes.length) {
        try {
          const repaired = await rewriteQuestions(
            result.provider,
            result.questions,
            result.batchProblems.rewriteIndexes
          );
          if (repaired) {
            questions = repaired.questions;
            softIssues = core.questionBatchProblems(
              questions.map((question) => question.text),
              brief
            ).issues;
          }
        } catch (repairError) {
          lastError = repairError;
        }
        logAttempt({
          attempt: attempts,
          mode: "batch_repair",
          provider: result.provider,
          outcome: softIssues.length ? "still_repetitive" : "ok",
          issues: softIssues.slice(0, 3),
          rewritten: result.batchProblems.rewriteIndexes,
          totalMs: now() - startedAt
        });
      }
      logAttempt({
        attempt: attempts,
        mode: hedged ? "hedged" : "single",
        provider: result.provider,
        model: result.model,
        finishReason: result.finishReason || "",
        outcome: "ok",
        durationMs: now() - attemptStartedAt,
        totalMs: now() - startedAt
      });
      return {
        questions,
        attempts,
        model: result.model,
        provider: result.provider,
        validationIssues: [],
        batchIssues: softIssues
      };
    } catch (error) {
      lastError = error;
      logAttempt({
        attempt: attempts,
        mode: hedged ? "hedged" : "single",
        provider,
        outcome: error?.code === "question_validation_failed" ? "invalid" : "failed",
        code: error?.code || "unknown_error",
        status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
        finishReason: error?.finishReason || "",
        contentLength: Number.isFinite(Number(error?.contentLength))
          ? Number(error.contentLength)
          : null,
        durationMs: now() - attemptStartedAt,
        totalMs: now() - startedAt
      });

      if (
        error?.code === "question_validation_failed" &&
        Array.isArray(error.questions) &&
        error.questions.length === QUESTION_COUNT
      ) {
        // Only rewrite the offending questions instead of the whole batch.
        const invalidIndexes = error.questions
          .map((question, index) =>
            questionProblems(question, brief).length ? index : -1
          )
          .filter((index) => index >= 0);
        if (invalidIndexes.length > 0 && invalidIndexes.length <= 3) {
          try {
            const repaired = await rewriteQuestions(
              PROVIDERS[attempt % PROVIDERS.length],
              error.questions,
              invalidIndexes
            );
            if (repaired) {
              logAttempt({
                attempt: attempts,
                mode: "repair",
                provider: PROVIDERS[attempt % PROVIDERS.length],
                outcome: "ok",
                totalMs: now() - startedAt
              });
              return {
                questions: repaired.questions,
                attempts,
                model: repaired.model,
                provider: repaired.provider,
                validationIssues: []
              };
            }
          } catch (repairError) {
            lastError = repairError;
          }
        }
        messages = buildMessages(brief, error.issues || []);
        continue;
      }

      messages = buildMessages(brief, [
        "上一次调用失败。请重新返回严格 JSON，不得输出解释文字。"
      ]);
      if (isRetryable(error) && attempt < MAX_ATTEMPTS - 1) {
        const delayMs = backoffFor(attempt, random);
        if (remaining() - delayMs >= MIN_ATTEMPT_MS) await sleep(delayMs);
      }
    }
  }

  const error = new Error(lastError?.message || "question_generation_failed");
  error.code = "question_generation_failed";
  error.attempts = attempts;
  throw error;
}

module.exports = {
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MIN_COMPETITOR_COVERAGE,
  PROVIDERS,
  TOTAL_BUDGET_MS,
  backoffFor,
  buildMessages,
  competitorCoverage,
  generateQuestions,
  isRetryable,
  normalizeQuestions,
  questionProblems,
  validateQuestions
};
