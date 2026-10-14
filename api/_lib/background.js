"use strict";

const { searchWeb } = require("./research");

// Background search feeds the recommendations module only. It never touches the
// scores: mentions, ranks and quotes still come from the 12 real answers.
const MAX_QUERIES = 4;
const PER_QUERY_RESULTS = 3;
const MAX_SOURCES = 6;
const DEFAULT_TIMEOUT_MS = 7000;

function buildBackgroundQueries(brief = {}) {
  const brand = String(brief.brand || "").trim();
  const product = String(brief.brandProduct || "").trim();
  const competitors = (brief.competitors || [])
    .map((item) => String(item?.name || "").trim())
    .filter(Boolean);
  const queries = [];
  if (brand) {
    queries.push({
      kind: "brand",
      label: "品牌公开素材",
      query: `${brand}${product ? ` ${product}` : ""} 官方 参数 数据`
    });
  }
  competitors.slice(0, 2).forEach((name) => {
    queries.push({
      kind: "competitor",
      label: `${name} 最新动作`,
      query: `${name} 新品 活动 价格 最新`
    });
  });
  if (product || brand) {
    queries.push({
      kind: "category",
      label: "品类推荐现状",
      query: `${product || brand} 推荐 排行 对比`
    });
  }
  return queries.slice(0, MAX_QUERIES);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").slice(0, 80);
  } catch {
    return "";
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("background_timeout")), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Never throws: a search outage can only make the recommendations plainer, it
// must not fail the report.
async function collectBackground(
  brief,
  { searchImpl = searchWeb, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}
) {
  const startedAt = now();
  const queries = buildBackgroundQueries(brief);
  if (!queries.length) {
    return { status: "empty", queries: [], sources: [], durationMs: 0 };
  }
  const outcomes = await Promise.all(
    queries.map(async (item) => {
      const queryStartedAt = now();
      let outcome;
      try {
        outcome = await withTimeout(
          searchImpl(item.query, { limit: PER_QUERY_RESULTS, timeoutMs }),
          timeoutMs
        );
      } catch (error) {
        outcome = {
          status: "failed",
          results: [],
          error: String(error?.message || "search failed").slice(0, 160)
        };
      }
      return { item, outcome, durationMs: now() - queryStartedAt };
    })
  );

  const seen = new Set();
  const sources = [];
  outcomes.forEach(({ item, outcome }) => {
    (outcome?.results || []).slice(0, PER_QUERY_RESULTS).forEach((result) => {
      const url = String(result?.url || "").trim();
      if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
      seen.add(url);
      sources.push({
        kind: item.kind,
        label: item.label,
        query: item.query,
        title: String(result?.title || url).slice(0, 200),
        url: url.slice(0, 500),
        host: hostOf(url),
        snippet: String(result?.content || "").slice(0, 300)
      });
    });
  });

  const selected = sources
    .slice(0, MAX_SOURCES)
    .map((source, index) => ({ id: `background_${index + 1}`, ...source }));
  const anyOk = outcomes.some(({ outcome }) => outcome?.status === "ok");
  return {
    status: selected.length ? "ok" : anyOk ? "empty" : "unavailable",
    queries: outcomes.map(({ item, outcome, durationMs }) => ({
      kind: item.kind,
      query: item.query,
      status: String(outcome?.status || "failed"),
      resultCount: (outcome?.results || []).length,
      durationMs
    })),
    sources: selected,
    durationMs: now() - startedAt
  };
}

module.exports = {
  buildBackgroundQueries,
  collectBackground,
  MAX_QUERIES,
  MAX_SOURCES
};
