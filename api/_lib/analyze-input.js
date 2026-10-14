"use strict";

const core = require("../../app-core.js");

const TESTED_PROVIDERS = ["deepseek", "glm"];
const QUESTION_COUNT = 6;

function inputError(message) {
  const error = new Error(message);
  error.code = "invalid_analysis_input";
  return error;
}

function cleanBaseInput(body = {}) {
  const brief = core.cleanBrief(body.brief || body);
  const brand = brief.brand;
  if (!brand || core.isOffTopic(brand)) {
    throw inputError("off_topic_or_missing_brand");
  }
  return {
    brief,
    brand,
    brandProduct: brief.brandProduct,
    competitors: brief.competitors.map((item) => item.name),
    competitorProducts: brief.competitors.map((item) => item.product),
    dimensions: brief.dimensions,
    other: brief.other,
    requestId: String(body.requestId || "").trim().slice(0, 80)
  };
}

function cleanQuestions(value) {
  if (!Array.isArray(value) || value.length !== QUESTION_COUNT) {
    throw inputError("six_questions_required");
  }
  const questions = value.map((item) => String(item || "").trim().slice(0, 500));
  if (questions.some((item) => !item)) throw inputError("invalid_questions");
  return questions;
}

function cleanAnswerInput(body = {}) {
  const provider = String(body.provider || "");
  if (!TESTED_PROVIDERS.includes(provider)) {
    throw inputError("invalid_provider");
  }
  const questionIndex = Number(body.questionIndex);
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= QUESTION_COUNT) {
    throw inputError("invalid_question_index");
  }
  const question = String(body.question || "").trim().slice(0, 500);
  if (!question) throw inputError("invalid_question");
  return {
    provider,
    questionIndex,
    question,
    requestId: String(body.requestId || "").trim().slice(0, 80)
  };
}

function cleanJudgeInput(body = {}) {
  const base = cleanAnswerInput(body);
  const brief = core.cleanBrief(body.brief || body);
  if (!brief.brand || core.isOffTopic(brief.brand)) {
    throw inputError("off_topic_or_missing_brand");
  }
  const answer = String(body.answer || "").trim().slice(0, 6000);
  if (!answer) throw inputError("invalid_answer");
  return { ...base, brief, answer };
}

function cleanReportInput(body = {}) {
  const base = cleanBaseInput(body);
  const questions = cleanQuestions(body.questions);
  const entries = Array.isArray(body.responses) ? body.responses : [];
  const responses = TESTED_PROVIDERS.map((provider) => {
    const entry = entries.find((item) => item?.provider === provider);
    if (!entry) throw inputError(`missing_${provider}_responses`);
    const answers = Array.isArray(entry.answers) ? entry.answers : [];
    if (answers.length !== QUESTION_COUNT) {
      throw inputError(`invalid_${provider}_answers`);
    }
    return {
      provider,
      model: String(entry.model || "").trim().slice(0, 100),
      answers: answers.map((answer) => String(answer || "").slice(0, 6000))
    };
  });
  return { ...base, questions, responses, judgments: cleanJudgments(body.judgments) };
}

// Judgments come back from the browser as { "provider:questionIndex": {...} }.
// They are untrusted: only the keys we can address are kept, and each payload is
// re-validated by the judge normaliser when the report is built.
function cleanJudgments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, judgment] of Object.entries(value).slice(0, 40)) {
    const match = /^(deepseek|glm):([0-5])$/.exec(String(key));
    if (!match) continue;
    if (!judgment || typeof judgment !== "object") continue;
    result[`${match[1]}:${match[2]}`] = judgment;
  }
  return result;
}

module.exports = {
  QUESTION_COUNT,
  TESTED_PROVIDERS,
  cleanAnswerInput,
  cleanBaseInput,
  cleanJudgeInput,
  cleanJudgments,
  cleanQuestions,
  cleanReportInput
};
