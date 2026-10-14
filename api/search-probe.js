"use strict";

const { activeProvider, searchWeb } = require("./_lib/research");

// Temporary diagnostic endpoint: it answers one question we cannot answer
// locally — which search sources are reachable from Vercel's (overseas)
// egress, given that every engine is blocked from the mainland ECS.
//
// It deliberately takes no query parameter, so it can never be used as a
// free search proxy; it always probes the same fixed query.
const PROBE_QUERY = "喜茶 新品";
const PROBE_TIMEOUT_MS = 9000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

function stripTags(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

// Search result titles are wrapped in an h2 > a on every engine we probe, so a
// single tolerant extractor works even when the surrounding markup changes.
function extractHeadingLinks(text, excludeHosts = []) {
  // Attribute quoting and ordering differ between Bing regions/UA, so accept
  // single or double quotes and a variable amount of markup before the anchor.
  const pattern =
    /<h2[^>]*>[\s\S]{0,400}?<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]{2,240}?)<\/a>/gi;
  const found = [];
  for (const match of String(text || "").matchAll(pattern)) {
    const url = match[1];
    if (excludeHosts.some((host) => url.includes(host))) continue;
    const title = stripTags(match[2]);
    if (title) found.push({ url, title });
  }
  if (found.length) return found;
  // Last resort: any external link inside the page, still filtered by host.
  const fallback = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]{2,200}?)<\/a>/gi;
  for (const match of String(text || "").matchAll(fallback)) {
    const title = stripTags(match[2]);
    const url = match[1];
    if (!title || excludeHosts.some((host) => url.includes(host))) continue;
    found.push({ url, title });
    if (found.length >= 12) break;
  }
  return found;
}

function htmlSource({ key, label, url, excludeHosts, marker }) {
  return {
    key,
    label,
    needsKey: false,
    url,
    marker,
    parse: (text) => extractHeadingLinks(text, excludeHosts).length,
    samples: (text) =>
      extractHeadingLinks(text, excludeHosts)
        .slice(0, 3)
        .map((item) => item.title)
  };
}

const SOURCES = [
  htmlSource({
    key: "bing_html",
    label: "Bing HTML",
    url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    excludeHosts: ["bing.com"],
    marker: "b_algo"
  }),
  htmlSource({
    key: "mojeek_html",
    label: "Mojeek HTML",
    url: (query) => `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`,
    excludeHosts: ["mojeek.com"],
    marker: "results"
  }),
  htmlSource({
    key: "ecosia_html",
    label: "Ecosia HTML",
    url: (query) => `https://www.ecosia.org/search?q=${encodeURIComponent(query)}`,
    excludeHosts: ["ecosia.org"],
    marker: "result"
  }),
  htmlSource({
    key: "startpage_html",
    label: "Startpage HTML",
    url: (query) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`,
    excludeHosts: ["startpage.com"],
    marker: "result"
  }),
  {
    key: "duckduckgo_html",
    label: "DuckDuckGo HTML",
    needsKey: false,
    url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: (text) => countMatches(text, /class="result__a"/g),
    samples: (text) =>
      [...String(text).matchAll(/class="result__a"[^>]*>([^<]{2,80})</g)]
        .slice(0, 3)
        .map((match) => match[1].trim())
  },
  {
    key: "duckduckgo_lite",
    label: "DuckDuckGo Lite",
    needsKey: false,
    url: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    parse: (text) => countMatches(text, /class="result-link"/g),
    samples: (text) =>
      [...String(text).matchAll(/class="result-link"[^>]*>([^<]{2,80})</g)]
        .slice(0, 3)
        .map((match) => match[1].trim())
  },
  {
    key: "wikipedia_zh",
    label: "Wikipedia API (zh)",
    needsKey: false,
    url: (query) =>
      `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        query
      )}&format=json&utf8=1&srlimit=5`,
    parse: (text) => {
      try {
        return (JSON.parse(text)?.query?.search || []).length;
      } catch {
        return 0;
      }
    },
    samples: (text) => {
      try {
        return (JSON.parse(text)?.query?.search || [])
          .slice(0, 3)
          .map((item) => String(item.title || ""));
      } catch {
        return [];
      }
    }
  }
];

async function fetchSource(
  source,
  query,
  { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}
) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(source.url(query), {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      },
      signal: controller.signal
    });
    const text = await response.text();
    const resultCount = source.parse(text);
    return {
      key: source.key,
      label: source.label,
      ok: response.ok && resultCount > 0,
      httpStatus: response.status,
      resultCount,
      samples: source.samples(text),
      bodyLength: text.length,
      // Diagnostics: tells us whether the markup simply changed, instead of
      // leaving us guessing why a 200 response parsed to zero results.
      debug: {
        marker: source.marker || "",
        markerFound: source.marker ? String(text).includes(source.marker) : null,
        title: (String(text).match(/<title[^>]*>([\s\S]{0,80}?)<\/title>/i) || [])[1]
          ? stripTags(String(text).match(/<title[^>]*>([\s\S]{0,80}?)<\/title>/i)[1])
          : "",
        h2Count: countMatches(text, /<h2/gi),
        // The raw markup is the only way to fix a parser when a page parses to
        // zero results, so keep a short excerpt around the first heading.
        snippet: (() => {
          const at = String(text).indexOf("<h2");
          return at >= 0 ? String(text).slice(at, at + 260).replace(/\s+/g, " ") : "";
        })()
      },
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      key: source.key,
      label: source.label,
      ok: false,
      httpStatus: null,
      resultCount: 0,
      samples: [],
      latencyMs: Date.now() - startedAt,
      error:
        error?.name === "AbortError"
          ? `timed out after ${timeoutMs}ms`
          : String(error?.message || "request failed").slice(0, 200)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeSources(query = PROBE_QUERY, { fetchImpl, searchImpl } = {}) {
  const sources = await Promise.all(
    SOURCES.map((source) => fetchSource(source, query, { fetchImpl }))
  );
  let searxng;
  if (searchImpl) {
    searxng = await searchImpl;
  } else {
    const startedAt = Date.now();
    const result = await searchWeb(query);
    const provider = activeProvider();
    searxng = {
      key: provider ? "search_api" : "searxng_ecs",
      label: provider ? `搜索 API（${provider.impl.label}）` : "SearXNG (ECS 对照组)",
      ok: result.status === "ok",
      status: result.status,
      provider: result.provider || (provider ? provider.name : "searxng"),
      resultCount: (result.results || []).length,
      latencyMs: Date.now() - startedAt,
      error: result.error || ""
    };
  }
  return [...sources, searxng];
}

module.exports = async (req, res) => {
  const results = await probeSources();
  const working = results.filter((item) => item.ok).map((item) => item.label);
  res.status(200).json({
    ok: true,
    service: "answerlens",
    checkedAt: new Date().toISOString(),
    query: PROBE_QUERY,
    note: "诊断用端点，固定查询，不接受外部参数。",
    workingSources: working,
    summary: working.length
      ? `可用：${working.join("、")}`
      : "没有任何免密来源返回结果",
    results
  });
};

module.exports.SOURCES = SOURCES;
module.exports.PROBE_QUERY = PROBE_QUERY;
module.exports.fetchSource = fetchSource;
module.exports.probeSources = probeSources;
