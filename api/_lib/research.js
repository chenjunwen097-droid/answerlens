"use strict";

function searchBase(env = process.env) {
  return String(env.SEARXNG_BASE_URL || env.SEARCH_API_URL || "").replace(/\/+$/, "");
}

function researchConfigured(env = process.env) {
  return Boolean(searchBase(env));
}

function apiKey(env = process.env) {
  return String(env.SEARCH_API_KEY || "").trim();
}

// Keyed search APIs (Serper/Brave/Tavily/Google CSE). These are real APIs, not
// scraped pages, so they keep working from datacenter IPs where every search
// engine blocks us.
const SEARCH_PROVIDERS = {
  serper: {
    label: "Serper",
    endpoint: "https://google.serper.dev/search",
    async request(url, query, { key, fetchImpl, signal }) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: 10 }),
        signal
      });
      const payload = await response.json().catch(() => ({}));
      return {
        response,
        items: (payload.organic || []).map((item) => ({
          title: item.title,
          url: item.link,
          content: item.snippet
        }))
      };
    }
  },
  brave: {
    label: "Brave",
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    async request(url, query, { key, fetchImpl, signal }) {
      const target = new URL(url);
      target.searchParams.set("q", query);
      target.searchParams.set("count", "10");
      const response = await fetchImpl(target, {
        headers: { Accept: "application/json", "X-Subscription-Token": key },
        signal
      });
      const payload = await response.json().catch(() => ({}));
      return {
        response,
        items: (payload.web?.results || []).map((item) => ({
          title: item.title,
          url: item.url,
          content: item.description
        }))
      };
    }
  },
  tavily: {
    label: "Tavily",
    endpoint: "https://api.tavily.com/search",
    async request(url, query, { key, fetchImpl, signal }) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          max_results: 10,
          search_depth: "basic"
        }),
        signal
      });
      const payload = await response.json().catch(() => ({}));
      return {
        response,
        items: (payload.results || []).map((item) => ({
          title: item.title,
          url: item.url,
          content: item.content
        }))
      };
    }
  },
  google_cse: {
    label: "Google CSE",
    endpoint: "https://www.googleapis.com/customsearch/v1",
    async request(url, query, { key, cx, fetchImpl, signal }) {
      const target = new URL(url);
      target.searchParams.set("key", key);
      target.searchParams.set("cx", cx || "");
      target.searchParams.set("q", query);
      target.searchParams.set("num", "10");
      const response = await fetchImpl(target, { headers: { Accept: "application/json" }, signal });
      const payload = await response.json().catch(() => ({}));
      return {
        response,
        items: (payload.items || []).map((item) => ({
          title: item.title,
          url: item.link,
          content: item.snippet
        }))
      };
    }
  }
};

function activeProvider(env = process.env) {
  const key = apiKey(env);
  if (!key) return null;
  const name = String(env.SEARCH_PROVIDER || "").trim().toLowerCase();
  const impl = SEARCH_PROVIDERS[name];
  if (!impl) return null;
  return { name, impl, key, cx: String(env.SEARCH_CX || "").trim() };
}

async function runApiProvider(provider, query, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  limit = 5,
  timeoutMs = 8000
} = {}) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const { response, items } = await provider.impl.request(
      provider.impl.endpoint,
      query,
      { key: provider.key, cx: provider.cx, fetchImpl, signal: controller?.signal }
    );
    if (!response.ok) {
      const error = new Error(
        `${provider.name} returned status ${response.status}`
      );
      error.status = response.status;
      throw error;
    }
    const results = items
      .map((item) => ({
        title: String(item.title || "").slice(0, 240),
        url: String(item.url || "").slice(0, 1000),
        content: String(item.content || "").slice(0, 1200),
        engine: provider.name,
        query,
        entity: "",
        role: "web"
      }))
      .filter((item) => item.url && item.title)
      .slice(0, limit);
    return {
      status: results.length ? "ok" : "empty",
      provider: provider.name,
      query,
      results
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error(`${provider.name} timed out after ${timeoutMs}ms`);
      timeout.code = "search_timeout";
      throw timeout;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildQueries(brief) {
  const entities = [
    brief.brandProduct ? `${brief.brand} ${brief.brandProduct}` : brief.brand,
    ...brief.competitors.map((item) =>
      item.product ? `${item.name} ${item.product}` : item.name
    )
  ].filter(Boolean);
  const dimensions = brief.dimensions.length ? brief.dimensions : ["产品体验"];
  // One focused query per entity (brand + up to three competitors). Keeps API
  // quota predictable while still covering every entity fairly.
  return entities.slice(0, 4).map((entity, index) => ({
    entity,
    role: index === 0 ? "brand" : "competitor",
    query: `${entity} ${dimensions.join(" ")} 参数 体验 评测`
  }));
}

async function searchQuery(query, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  limit = 5,
  timeoutMs = 8000
} = {}) {
  // Prefer a keyed search API when one is configured: unlike scraped pages it
  // keeps working from datacenter IPs.
  const provider = activeProvider(env);
  if (provider) {
    try {
      return await runApiProvider(provider, query.query, {
        env,
        fetchImpl,
        limit,
        timeoutMs
      });
    } catch (error) {
      // Fall back to the self-hosted gateway so one provider outage degrades
      // instead of failing the whole step.
      if (!searchBase(env)) throw error;
      const fallback = await searchQueryViaSearxng(query, {
        env,
        fetchImpl,
        limit,
        timeoutMs
      });
      return {
        ...fallback,
        provider: "searxng",
        fallbackFrom: provider.name,
        fallbackError: String(error?.message || "").slice(0, 160)
      };
    }
  }
  return searchQueryViaSearxng(query, { env, fetchImpl, limit, timeoutMs });
}

async function searchQueryViaSearxng(query, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  limit = 5,
  timeoutMs = 8000
} = {}) {
  const base = searchBase(env);
  if (!base) return { status: "not_configured", results: [] };
  const url = new URL("/search", `${base}/`);
  url.searchParams.set("q", query.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "zh-CN");
  url.searchParams.set("safesearch", "1");
  const headers = { Accept: "application/json" };
  if (env.SEARCH_API_TOKEN) headers.Authorization = `Bearer ${env.SEARCH_API_TOKEN}`;
  // A hanging search must never take the whole request down with it.
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      ...(controller ? { signal: controller.signal } : {})
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error(`research provider timed out after ${timeoutMs}ms`);
      timeout.code = "search_timeout";
      throw timeout;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`research provider failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const results = (Array.isArray(payload.results) ? payload.results : [])
    .slice(0, limit)
    .map((item) => ({
      title: String(item.title || "").slice(0, 240),
      url: String(item.url || "").slice(0, 1000),
      content: String(item.content || item.snippet || "").slice(0, 1200),
      engine: String(item.engine || "").slice(0, 60),
      query: query.query,
      entity: query.entity,
      role: query.role
    }))
    .filter((item) => item.url);
  return { status: results.length ? "ok" : "empty", results };
}

// Analyses of the same brief repeat a lot in practice, so a warm instance can
// answer from this cache and save API quota.
const researchCache = new Map();
const RESEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const RESEARCH_CACHE_LIMIT = 50;

function researchCacheKey(brief, env) {
  return JSON.stringify([
    brief.brand,
    brief.brandProduct,
    brief.competitors,
    brief.dimensions,
    activeProvider(env)?.name || "searxng",
    searchBase(env)
  ]);
}

async function researchBrief(brief, options = {}) {
  const key = researchCacheKey(brief, options.env || process.env);
  const cached = researchCache.get(key);
  if (cached && Date.now() - cached.at < RESEARCH_TTL_MS) {
    return { ...cached.value, cached: true };
  }
  const queries = buildQueries(brief);
  const outcomes = await Promise.allSettled(
    queries.map((query) => searchQuery(query, options))
  );
  const results = [];
  const seen = new Set();
  outcomes.forEach((outcome) => {
    if (outcome.status !== "fulfilled") return;
    outcome.value.results.forEach((item) => {
      if (seen.has(item.url)) return;
      seen.add(item.url);
      results.push(item);
    });
  });
  const result = {
    status: results.length ? "ok" : researchConfigured(options.env) ? "empty" : "not_configured",
    queries,
    results: results.slice(0, 16),
    fetchedAt: new Date().toISOString()
  };
  // Only successful lookups are worth remembering; caching a provider outage
  // or an empty result for a day would hide a temporary failure.
  if (result.status === "ok") {
    if (researchCache.size >= RESEARCH_CACHE_LIMIT) {
      researchCache.delete(researchCache.keys().next().value);
    }
    researchCache.set(key, { at: Date.now(), value: result });
  }
  return result;
}

// Single ad-hoc lookup used by the page assistant. It never throws so a search
// outage can only degrade an answer, not break the chat.
async function searchWeb(query, options = {}) {
  const text = String(query || "").trim().slice(0, 300);
  if (!text) return { status: "empty", query: text, results: [] };
  try {
    const outcome = await searchQuery(
      { query: text, entity: "", role: "web" },
      { limit: 4, timeoutMs: 8000, ...options }
    );
    return { status: outcome.status, query: text, results: outcome.results };
  } catch (error) {
    return {
      status: "failed",
      query: text,
      results: [],
      code: error?.code || "search_failed",
      error: String(error?.message || "search failed").slice(0, 160)
    };
  }
}

module.exports = {
  activeProvider,
  buildQueries,
  researchBrief,
  researchConfigured,
  runApiProvider,
  searchQuery,
  searchQueryViaSearxng,
  searchWeb
};
