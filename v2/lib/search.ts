// Search layer: DeepSeek's native Search/Fetch API is the only provider.
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content?: string;
  siteName?: string;
  date?: string | null;
  authority?: number;
  rerankScore?: number;
}

export interface SearchOptions {
  count?: number;
  needContent?: boolean;
  after?: string;
  lang?: string;
}

const DEEPSEEK_BASE = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com";

export function searchConfigured() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

export async function deepSeekSearch(
  query: string,
  options: SearchOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<SearchResult[]> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured");
  const response = await fetchImpl(`${DEEPSEEK_BASE}/v1/tools/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      count: options.count ?? 8,
      need_content: options.needContent ?? false
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`DeepSeek search failed: ${response.status}`);
  const payload = (await response.json()) as { results?: Record<string, unknown>[] };
  return (payload.results || []).map((item) => ({
    title: String(item.title || ""),
    url: String(item.url || ""),
    snippet: String(item.snippet || ""),
    summary: String(item.summary || ""),
    content: String(item.content || "") || undefined,
    siteName: item.site_name ? String(item.site_name) : undefined,
    date: item.date ? String(item.date) : null,
    authority: Number(item.authority ?? -1),
    rerankScore: Number(item.rerank_score ?? 0)
  }));
}

export async function deepSeekFetch(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ title: string; markdown: string }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured");
  const response = await fetchImpl(`${DEEPSEEK_BASE}/v1/tools/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`DeepSeek fetch failed: ${response.status}`);
  const payload = (await response.json()) as { title?: string; content?: string };
  return { title: String(payload.title || url), markdown: String(payload.content || "") };
}

// Filters follow the DeepSeek guide: >=1.5 is a high-quality hit, >=3 is authoritative.
export async function searchWeb(query: string, options: SearchOptions = {}) {
  const results = await deepSeekSearch(query, options);
  return results.filter((item) => (item.rerankScore ?? 0) >= 1.5 || results.length <= 3);
}
