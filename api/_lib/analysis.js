"use strict";

const core = require("../../app-core.js");
const {
  buildEntityDictionary,
  entityRankById,
  findEntityMentionsForDictionary
} = require("./entities");
const { normalizeJudgment } = require("./judge");

function firstMentionRank(answer, brand, competitors) {
  const text = String(answer || "").toLowerCase();
  const positions = [
    { name: brand, position: text.indexOf(String(brand || "").toLowerCase()) },
    ...competitors.map((name) => ({
      name,
      position: text.indexOf(String(name || "").toLowerCase())
    }))
  ].filter((item) => item.position >= 0);
  positions.sort((a, b) => a.position - b.position);
  return positions.findIndex((item) => item.name.toLowerCase() === String(brand || "").toLowerCase()) + 1;
}

function localSentiment(text) {
  const value = String(text || "").toLowerCase();
  const negative =
    /短板|不推荐|不适合|缺点|限制|风险|不足|较差|落后|劣势|衰减严重|续航虚标|negative|weak|worse/i.test(
      value
    );
  const positive =
    /推荐|优势|适合|可靠|优秀|领先|更强|更好|更长|更便宜|性价比高|值得|优秀|positive|strong|better/i.test(
      value
    );
  if (negative && !positive) return "negative";
  if (positive) return "positive";
  return "neutral";
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Judgments travel keyed by "provider:questionIndex" so a report can be rebuilt
// from the answers plus the per-answer verdicts the judge already returned.
function judgmentKey(provider, questionIndex) {
  return `${String(provider || "")}:${Number(questionIndex)}`;
}

// Verdicts arrive as the judge's raw JSON. Every number is derived here from
// that JSON plus the real answer text, so a tampered payload can only ever
// change what the judge claimed, never invent a score.
function normalizeJudgmentMap(judgments, { responses, dictionary }) {
  if (!judgments || typeof judgments !== "object") return {};
  const result = {};
  Object.entries(judgments).forEach(([key, raw]) => {
    if (!raw || typeof raw !== "object") return;
    const entities = raw.entities || {};
    const alreadyScored = Object.keys(entities).length
      ? Object.values(entities).every((item) => item && item.dimensions)
      : false;
    if (alreadyScored) {
      result[key] = raw;
      return;
    }
    const [provider, indexText] = String(key).split(":");
    const questionIndex = Number(indexText);
    const response = (responses || []).find((item) => item.provider === provider);
    const answer = String(response?.answers?.[questionIndex] || "");
    if (!answer) return;
    try {
      result[key] = normalizeJudgment(raw, { answer, entities: dictionary });
    } catch {
      // A verdict we cannot re-derive is dropped; that answer falls back to the
      // rule-based scoring above.
    }
  });
  return result;
}

const DIMENSION_KEYS = ["presence", "rank", "sentiment", "evidence", "differentiation"];

function weightedScore(dimensions, applicable = {}) {
  const entries = core.SCORE_DIMENSIONS.filter(
    (item) =>
      (applicable[item.key] !== false) && Number.isFinite(dimensions[item.key])
  );
  if (!entries.length) return 0;
  const totalWeight = entries.reduce((sum, item) => sum + item.weight, 0);
  return clampScore(
    entries.reduce((sum, item) => sum + dimensions[item.key] * item.weight, 0) /
      totalWeight
  );
}

// Scores one entity (brand or a competitor) inside a single model answer,
// so every entity is measured with the same five dimensions.
// `asked` matters: an entity that the question never asked about is not a
// failure, so it is excluded from the average instead of scoring zero.
function scoreEntityInAnswer({
  answer,
  dictionary,
  entityId,
  mentions,
  asked = true,
  judgment = null
}) {
  if (!asked) {
    return {
      asked: false,
      applicable: false,
      mentioned: false,
      rank: 0,
      sentiment: "not_asked",
      quote: "",
      dimensions: null,
      judged: false
    };
  }
  // A model judgment replaces the rule-based tiers when the judge actually
  // decided the dimensions; anything it did not decide stays rule-based.
  const judgedEntity = judgment?.entities?.[entityId] || null;
  if (judgedEntity) {
    const dimensions = { ...judgedEntity.dimensions };
    const applicable = { ...judgedEntity.applicable };
    return {
      asked: true,
      applicable: true,
      mentioned: Boolean(judgedEntity.mentioned),
      rank: Number(judgedEntity.rank) || 0,
      sentiment: judgedEntity.tone || "neutral",
      quote: judgedEntity.quote || "",
      dimensions: {
        ...dimensions,
        score: weightedScore(dimensions, applicable)
      },
      applicableDimensions: applicable,
      reasons: judgedEntity.reasons,
      claims: judgedEntity.claims,
      items: judgedEntity.items,
      judged: true
    };
  }
  const mention = mentions.find((item) => item.entityId === entityId);
  const mentioned = Boolean(mention);
  if (!mentioned) {
    return {
      asked: true,
      applicable: true,
      mentioned: false,
      rank: 0,
      sentiment: "not_observed",
      quote: "",
      dimensions: {
        presence: 0,
        rank: 0,
        sentiment: 0,
        evidence: 0,
        differentiation: 0,
        score: 0
      },
      judged: false
    };
  }
  const rankPosition = entityRankById(answer, dictionary, entityId) || 4;
  const tone = localSentiment(mention.quote || answer);
  const otherMentions = mentions.filter((item) => item.entityId !== entityId).length;
  const dimensions = {
    presence: 100,
    rank: clampScore(100 - Math.max(0, rankPosition - 1) * 25),
    sentiment: tone === "positive" ? 100 : tone === "negative" ? 20 : 60,
    evidence: mention.quote ? 100 : 0,
    differentiation: otherMentions > 0 ? 100 : 60
  };
  return {
    asked: true,
    applicable: true,
    mentioned: true,
    rank: rankPosition,
    sentiment: tone,
    quote: mention.quote || "",
    dimensions: { ...dimensions, score: weightedScore(dimensions) },
    judged: false
  };
}

function averageEntityScores(perAnswerScores) {
  const list = (perAnswerScores || []).filter((item) => item?.applicable);
  if (!list.length) {
    return {
      asked: false,
      applicable: false,
      mentioned: false,
      mentions: 0,
      score: null,
      dimensions: null
    };
  }
  const dimensions = DIMENSION_KEYS.reduce((result, key) => {
    // A dimension the judge marked inapplicable for every answer (no ranking,
    // no factual claim) must not be averaged in as a zero.
    const values = list
      .filter((item) => item.applicableDimensions?.[key] !== false)
      .map((item) => item.dimensions[key]);
    result[key] = values.length
      ? clampScore(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0;
    return result;
  }, {});
  return {
    asked: true,
    applicable: true,
    ...dimensions,
    score: clampScore(
      list.reduce((sum, item) => sum + item.dimensions.score, 0) /
        Math.max(1, list.length)
    ),
    mentions: list.filter((item) => item.mentioned).length,
    mentioned: list.some((item) => item.mentioned)
  };
}

// Three tiers of confidence, all driven by how many questions asked about an
// entity: below MIN there is no score at all, below RANKING_MIN the score is
// shown but must not be used to rank competitors.
const MIN_ASKED_QUESTIONS = 2;
const RANKING_MIN_QUESTIONS = 3;

function analyzeObservations({
  brand,
  brandProduct,
  competitors,
  competitorProducts,
  questions,
  responses,
  entityDictionary,
  judgments
}) {
  const dictionary =
    entityDictionary ||
    buildEntityDictionary({
      brand,
      brandProduct,
      competitors: competitors.map((name, index) => ({
        name,
        product: competitorProducts?.[index] || ""
      }))
    });
  const observations = [];
  const entityIds = dictionary.map((entity) => entity.id);
  // What each question actually asks about. Entities the question never names
  // are excluded from scoring instead of being counted as zero.
  const askedByQuestion = questions.map(
    (question) =>
      new Set(
        findEntityMentionsForDictionary(question, dictionary).map(
          (item) => item.entityId
        )
      )
  );
  const normalizedJudgments = normalizeJudgmentMap(judgments, {
    responses,
    dictionary
  });
  responses.forEach((response) => {
    questions.forEach((question, questionIndex) => {
      const answer = response.answers[questionIndex] || "";
      const mentions = findEntityMentionsForDictionary(answer, dictionary);
      const judgment =
        normalizedJudgments[judgmentKey(response.provider, questionIndex)] || null;
      const entityScores = entityIds.reduce((result, entityId) => {
        result[entityId] = scoreEntityInAnswer({
          answer,
          dictionary,
          entityId,
          mentions,
          asked: askedByQuestion[questionIndex]?.has(entityId) ?? true,
          judgment
        });
        return result;
      }, {});
      const brandScore = entityScores.brand;
      observations.push({
        model: response.model,
        provider: response.provider,
        question,
        questionIndex,
        answer,
        mentioned: brandScore.mentioned,
        rank: brandScore.mentioned ? brandScore.rank : 0,
        sentiment: brandScore.sentiment,
        mentions,
        mentionQuote: brandScore.quote,
        judged: Boolean(brandScore.judged),
        recommended: Boolean(brandScore.items?.recommended),
        firstChoice: Boolean(brandScore.items?.firstChoice),
        judgments: entityIds.reduce((result, entityId) => {
          const score = entityScores[entityId];
          if (!score?.judged) return result;
          result[entityId] = {
            dimensions: DIMENSION_KEYS.reduce((dims, key) => {
              dims[key] = score.dimensions[key];
              return dims;
            }, {}),
            applicable: score.applicableDimensions || {},
            reasons: score.reasons || {},
            claims: score.claims || [],
            quote: score.quote || "",
            rank: score.rank || null,
            tone: score.sentiment || "",
            score: score.dimensions.score
          };
          return result;
        }, {}),
        entityScores
      });
    });
  });

  const totalModelAnswers = observations.length;
  // Only answers to questions that actually asked about the brand can say
  // anything about the brand.
  const brandAsked = observations.filter((item) => item.entityScores.brand?.applicable);
  const brandAskedTotal = brandAsked.length;
  const mentionRate =
    brandAskedTotal > 0
      ? brandAsked.filter((item) => item.mentioned).length / brandAskedTotal
      : 0;
  // The headline rate. A mention is nearly guaranteed because every question
  // names the brand, so the metric that carries information is whether the
  // model actually put it in the recommendation list. Answers that fell back to
  // rule-based scoring have no verdict, so they are left out of both sides of
  // this fraction instead of being counted as "not recommended".
  const brandJudged = brandAsked.filter((item) => item.judged);
  const recommendationRate = brandJudged.length
    ? brandJudged.filter((item) => item.recommended).length / brandJudged.length
    : null;
  const firstChoiceRate = brandJudged.length
    ? brandJudged.filter((item) => item.firstChoice).length / brandJudged.length
    : null;
  const mentionedRanks = brandAsked.filter((item) => item.mentioned).map((item) => item.rank);
  const averageRank = mentionedRanks.length
    ? mentionedRanks.reduce((sum, rank) => sum + rank, 0) / mentionedRanks.length
    : 4;
  const positiveCount = brandAsked.filter((item) => item.sentiment === "positive").length;
  const neutralCount = brandAsked.filter((item) => item.sentiment === "neutral").length;
  const observedCount = brandAsked.filter((item) => item.mentioned).length;
  const sentimentScore = observedCount
    ? (positiveCount + neutralCount * 0.5) / observedCount
    : 0;
  const questionMentioned = questions.filter((_, index) =>
    observations.some((item) => item.questionIndex === index && item.mentioned)
  ).length;
  const askedEntityIdsByQuestion = askedByQuestion.map((set) => [...set]);
  const questionStats = questions.map((question, questionIndex) => {
    const questionObservations = observations.filter(
      (item) => item.questionIndex === questionIndex
    );
    const entityScores = entityIds.reduce((result, entityId) => {
      result[entityId] = averageEntityScores(
        questionObservations.map((item) => item.entityScores[entityId])
      );
      return result;
    }, {});
    const brandScores = questionObservations.map((item) => item.entityScores.brand);
    const positiveCount = brandScores.filter((item) => item.sentiment === "positive").length;
    const negativeCount = brandScores.filter((item) => item.sentiment === "negative").length;
    const brandQuestionScore = entityScores.brand;
    return {
      questionIndex,
      question,
      mentioned: brandQuestionScore.mentioned,
      mentions: brandScores.filter((item) => item.mentioned).length,
      sentiment: brandQuestionScore.mentioned
        ? positiveCount > negativeCount
          ? "positive"
          : negativeCount > positiveCount
            ? "negative"
            : "neutral"
        : "not_observed",
      score: brandQuestionScore.score,
      askedEntityIds: askedEntityIdsByQuestion[questionIndex],
      dimensions: brandQuestionScore.applicable
        ? DIMENSION_KEYS.reduce((result, key) => {
            result[key] = brandQuestionScore[key];
            return result;
          }, {})
        : null,
      entityScores,
      models: questionObservations.map((item) => ({
        model: item.model,
        provider: item.provider,
        mentioned: item.entityScores.brand.mentioned,
        rank: item.entityScores.brand.rank,
        sentiment: item.entityScores.brand.sentiment,
        quote: item.entityScores.brand.quote
      }))
    };
  });
  // Per-entity totals use each entity's own denominator: only the questions
  // that actually asked about it. An entity asked fewer than
  // MIN_ASKED_QUESTIONS times has no reliable score at all.
  const entityStats = dictionary.map((entity) => {
    const perQuestion = questionStats.map((stat) => stat.entityScores[entity.id]);
    const applicable = perQuestion.filter((item) => item?.applicable);
    const askedQuestions = applicable.length;
    const insufficient = askedQuestions < MIN_ASKED_QUESTIONS;
    const rankable = askedQuestions >= RANKING_MIN_QUESTIONS;
    const rawScore = askedQuestions
      ? clampScore(
          applicable.reduce((sum, item) => sum + item.score, 0) / askedQuestions
        )
      : null;
    const askedObservations = observations.filter(
      (item) => item.entityScores[entity.id]?.applicable
    );
    return {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      askedQuestions,
      totalQuestions: questions.length,
      insufficient,
      rankable,
      score: insufficient ? null : rawScore,
      rawScore,
      mentions: askedObservations.filter(
        (item) => item.entityScores[entity.id].mentioned
      ).length,
      askedAnswers: askedObservations.length
    };
  });
  const brandStats = entityStats.find((item) => item.id === "brand") || null;
  const score = brandStats ? brandStats.score : null;
  const ranking = entityStats
    .filter((item) => item.rankable && item.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((item, index) => ({
      id: item.id,
      name: item.name,
      rank: index + 1,
      score: item.score
    }));
  // Conflicts are detected deterministically from the real answers: the same
  // entity gets an opposite description from two different models. Nothing is
  // generated here, so an entity can never be misattributed.
  const conflicts = [];
  questions.forEach((question, questionIndex) => {
    const questionObservations = observations.filter(
      (item) => item.questionIndex === questionIndex
    );
    dictionary.forEach((entity) => {
      const rated = questionObservations
        .map((item) => ({ item, score: item.entityScores[entity.id] }))
        .filter(
          (entry) =>
            entry.score?.applicable &&
            entry.score.mentioned &&
            ["positive", "negative"].includes(entry.score.sentiment)
        );
      const positive = rated.filter((entry) => entry.score.sentiment === "positive");
      const negative = rated.filter((entry) => entry.score.sentiment === "negative");
      if (!positive.length || !negative.length) return;
      const sides = [positive[0], negative[0]].map((entry) => ({
        provider: entry.item.provider,
        model: entry.item.model,
        tone: entry.score.sentiment,
        quote: entry.score.quote || ""
      }));
      conflicts.push({
        entityId: entity.id,
        entityName: entity.name || entity.product,
        entityType: entity.type,
        questionIndex,
        question,
        sides
      });
    });
  });

  // A conflict needs both models to describe the entity in opposite ways. When
  // one model never mentions it at all, that is a different, equally useful
  // signal: AI coverage for this product is partial.
  const coverageGaps = [];
  questions.forEach((question, questionIndex) => {
    const questionObservations = observations.filter(
      (item) => item.questionIndex === questionIndex
    );
    dictionary.forEach((entity) => {
      const asked = questionObservations.filter(
        (item) => item.entityScores[entity.id]?.applicable
      );
      if (asked.length < 2) return;
      const mentioned = asked.filter((item) => item.entityScores[entity.id].mentioned);
      const missing = asked.filter((item) => !item.entityScores[entity.id].mentioned);
      if (!mentioned.length || !missing.length) return;
      coverageGaps.push({
        entityId: entity.id,
        entityName: entity.name || entity.product,
        entityType: entity.type,
        questionIndex,
        question,
        sides: asked.map((item) => ({
          provider: item.provider,
          model: item.model,
          mentioned: item.entityScores[entity.id].mentioned,
          quote: item.entityScores[entity.id].quote || ""
        }))
      });
    });
  });
  const modelStats = responses.map((response) => {
    const modelObservations = observations.filter(
      (item) => item.provider === response.provider
    );
    const modelMentions = modelObservations.filter((item) => item.mentioned).length;
    return {
      name: response.model,
      provider: response.provider,
      state: modelMentions / Math.max(1, questions.length) >= 0.5 ? "稳定" : "波动",
      answers: questions.length,
      mentions: modelMentions
    };
  });

  // Every entity (brand and each competitor) is scored with the same five
  // evidence-backed dimensions, so the comparison chart is a real comparison.
  const matrix = entityStats.map((item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    value: item.score,
    mentions: item.mentions,
    asked: item.askedQuestions,
    insufficient: item.insufficient,
    rankable: item.rankable
  }));

  return {
    score,
    mentioned: questionMentioned,
    totalQuestions: questions.length,
    sentiment: Math.round(sentimentScore * 100),
    rank: Math.max(1, Math.round(averageRank)),
    questions,
    matrix,
    entityStats,
    ranking,
    minAskedQuestions: MIN_ASKED_QUESTIONS,
    rankingMinQuestions: RANKING_MIN_QUESTIONS,
    observations,
    conflicts,
    coverageGaps: coverageGaps.slice(0, 6),
    questionStats,
    modelStats,
    scoringStandard: core.SCORE_DIMENSIONS,
    metrics: {
      mentionRate: Math.round(mentionRate * 100),
      recommendationRate:
        recommendationRate === null ? null : Math.round(recommendationRate * 100),
      firstChoiceRate: firstChoiceRate === null ? null : Math.round(firstChoiceRate * 100),
      judgedAnswers: brandJudged.length,
      averageRank: Number(averageRank.toFixed(1)),
      positiveRate: Math.round((positiveCount / Math.max(1, brandAskedTotal)) * 100),
      evidenceRate: Math.round(
        (brandAsked.filter((item) => item.mentionQuote).length /
          Math.max(1, brandAskedTotal)) *
          100
      ),
      averageQuestionScore: score,
      askedAnswers: brandAskedTotal,
      totalModelAnswers
    }
  };
}

module.exports = {
  analyzeObservations,
  firstMentionRank,
  judgmentKey,
  localSentiment,
  MIN_ASKED_QUESTIONS,
  RANKING_MIN_QUESTIONS,
  scoreEntityInAnswer
};
